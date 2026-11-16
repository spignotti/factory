import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProviderWindowError, TransientAgentError } from "../agents/models.js";
import { extractJson } from "../agents/runner.js";
import { commitAll, commitMerge, diffText, discardChanges, gitOk, headSha, stageAll, startMerge } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { asData, rolePrompt, taskBlock } from "../prompts.js";
import { EnvMissing } from "../services.js";
import { failureSummary, type GateReport, runGates } from "../steps/gates.js";
import { dropStrayHandoff, gitAuthor } from "../steps/implement.js";
import { callAgent, checkDeadline, type RunContext, WallTimeExceeded, writeJson } from "./context.js";
import type { TrackedFinding } from "./merge.js";
import { clearRepair, ensureBudget, holdUnfixed } from "./recovery.js";

/** Resolver turns per run, shared by every stop of the run (persisted as `state.resolver_turns`). */
export const MAX_RESOLVER_TURNS = 2;

/** What the run knows about a technical stop. */
export interface ResolverStop {
  reason: string;
  /** Latest gate report. */
  gates?: GateReport;
  /** Open review findings. */
  findings?: TrackedFinding[];
  /** Packages that did not finish (implement stop). Their uncommitted work was discarded. */
  packages?: string[];
  /** Red checks on the PR head. */
  ci?: { sha: string; failures: { name: string; output_tail: string }[] };
  /** Merge this commit before the turn and leave its conflicts to the resolver. `base` moves the run's base. */
  merge?: { sha: string; label: string; base: boolean };
}

export type ResolverOutcome =
  /** `summary`: the resolver's account of the turn; it goes to the next review as the findings' response. */
  | { ok: true; gates: GateReport; summary: string }
  /** `final`: the resolver said the approach is wrong; another turn would not help. */
  | { ok: false; reason: string; final?: boolean; gates?: GateReport };

const ReplySchema = z.object({
  outcome: z.enum(["fixed", "approach_wrong"]),
  summary: z.string().default(""),
  reason: z.string().default(""),
});

const REPLY_SHAPE =
  'Reply with a single ```json block: {"outcome":"fixed|approach_wrong","summary":"what you changed and why","reason":"approach_wrong only: why the plan cannot work"}';

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

function parseReply(text: string): { ok: true; reply: z.infer<typeof ReplySchema> } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: "no JSON object in output" };
  const parsed = ReplySchema.safeParse(json);
  return parsed.success ? { ok: true, reply: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

function prompt(ctx: RunContext, stop: ResolverStop, v: { diff: string; conflicts: string[]; previous?: string }): string {
  const findings = (stop.findings ?? []).map(({ id, severity, file, line, claim, evidence, fix, response }) => ({ id, severity, file, line, claim, evidence, fix, response }));
  const red = stop.gates && !stop.gates.green ? failureSummary(stop.gates) : "";
  return [
    "The run stopped on a technical problem. Resolve it in this worktree; the factory re-runs the gates, commits and continues.",
    asData("stop_reason", stop.reason),
    v.previous ? asData("previous_resolver_turn", v.previous) : "",
    stop.packages?.length ? `Packages not done: ${stop.packages.join(", ")}. Their uncommitted work was discarded; make them work on top of the committed tree.` : "",
    v.conflicts.length
      ? `The factory merged ${stop.merge!.label} into this branch. These files have conflict markers; resolve every one: ${v.conflicts.join(", ")}`
      : stop.merge
        ? `The factory merged ${stop.merge.label} into this branch without conflicts; the merge is not committed yet.`
        : "",
    red ? asData("gate_failures", red) : "",
    findings.length
      ? `${asData("open_findings", JSON.stringify(findings, null, 2))}\nEvery open finding needs a change: the next review checks your commit and reads your summary next to each finding. A finding the task cannot satisfy means the approach is wrong.`
      : "",
    stop.ci?.failures.length ? asData("ci_failures", stop.ci.failures.map((f) => `### ${f.name}\n${f.output_tail}`).join("\n\n")) : "",
    asData("plan", JSON.stringify(ctx.plan, null, 2)),
    taskBlock(ctx),
    ctx.handoffs.length ? asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)) : "",
    asData("diff_since_base", v.diff),
    `human_only_paths (never change these unless the plan's protected_changes declares it): ${ctx.repo.human_only_paths.join(", ") || "none"}`,
    REPLY_SHAPE,
  ].filter(Boolean).join("\n\n");
}

/** Files of the list that still contain a conflict marker line. */
function markersLeft(worktree: string, files: string[]): string[] {
  return files.filter((f) => {
    try {
      return MARKER.test(readFileSync(join(worktree, f), "utf8"));
    } catch {
      return false;
    }
  });
}

async function abandonTurn(ctx: RunContext, merging: boolean): Promise<void> {
  if (merging) await gitOk(ctx.worktree, ["merge", "--abort"]);
  await discardChanges(ctx.worktree);
}

/**
 * One resolver turn on a technical stop. The agent edits files only (git internals are read-only to it):
 * the factory starts a requested merge, commits the result and re-runs the full gates with the fake-fix
 * hold. Green clears the gate-repair budget so the run can continue. Provider, wall-time and interrupt
 * errors propagate; any other failure of the turn is returned as a failed turn.
 */
export async function resolverTurn(ctx: RunContext, stop: ResolverStop, turn: number, previous?: string): Promise<ResolverOutcome> {
  checkDeadline(ctx);
  const author = gitAuthor(ctx);
  const before = await headSha(ctx.worktree);
  let merging = false;
  let conflicts: string[] = [];
  try {
    if (stop.merge) ({ merging, conflicts } = await startMerge(ctx.worktree, stop.merge.sha, author));
    if (!merging) await stageAll(ctx.worktree);
    const diff = await diffText(ctx.worktree, ctx.baseSha);
    ctx.events.emit({ step: "resolve", event: "step_started", data: { turn, reason: stop.reason.slice(0, 300), conflicts } });
    let text = prompt(ctx, stop, { diff, conflicts, previous });
    let reply: z.infer<typeof ReplySchema> | undefined;
    let error = "";
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      const res = await callAgent(ctx, "resolve", {
        role: "resolve",
        cwd: ctx.worktree,
        tools: "coding",
        system: rolePrompt("resolve", ctx.deps.prompts),
        prompt: text,
        sessionKey: `${ctx.runId}-resolve-${turn}`,
      });
      const parsed = parseReply(res.text);
      if (parsed.ok) reply = parsed.reply;
      else {
        error = parsed.error;
        text = `Your reply was invalid: ${error}\n\n${REPLY_SHAPE}`;
      }
    }
    if (!reply) {
      await abandonTurn(ctx, merging);
      return { ok: false, reason: `resolver output invalid: ${error}` };
    }
    writeJson(ctx, `resolve-${turn}.json`, reply);
    if (reply.outcome === "approach_wrong") {
      await abandonTurn(ctx, merging);
      return { ok: false, final: true, reason: `the approach is wrong: ${reply.reason || reply.summary || "no reason given"}` };
    }
    await dropStrayHandoff(ctx, "resolve");
    if (merging) {
      const left = markersLeft(ctx.worktree, conflicts);
      if (left.length) {
        await abandonTurn(ctx, merging);
        return { ok: false, reason: `conflict markers left in ${left.join(", ")}` };
      }
      await commitMerge(ctx.worktree, `chore: merge ${stop.merge!.label} into ${ctx.branch}`, author);
      if (stop.merge!.base) ctx.baseSha = stop.merge!.sha;
    }
    const gates = await holdUnfixed(ctx, await runGates(ctx, "full", ctx.plan.packages.map((p) => p.id)));
    // Committed red or green: a second turn builds on this one, and a failed run keeps it for reading.
    await commitAll(ctx.worktree, `fix: resolve technical stop (turn ${turn})`, author);
    const moved = (await headSha(ctx.worktree)) !== before;
    ctx.events.emit({ step: "resolve", event: "step_finished", data: { turn, outcome: reply.outcome, green: gates.green, moved } });
    if (!gates.green) return { ok: false, reason: `gates red after the resolver turn:\n${failureSummary(gates)}`, gates };
    // An unchanged reviewed commit is not reviewed again: open findings with no change would reach the PR unreviewed.
    if (stop.findings?.length && !moved) return { ok: false, reason: "the resolver changed nothing, so the open review findings still stand", gates };
    clearRepair(ensureBudget(ctx));
    ctx.persist?.();
    return { ok: true, gates, summary: reply.summary };
  } catch (e) {
    if (e instanceof Interrupted || e instanceof TransientAgentError || e instanceof ProviderWindowError || e instanceof WallTimeExceeded || e instanceof EnvMissing) throw e;
    const reason = (e as Error).message.slice(0, 500);
    ctx.events.emit({ step: "resolve", event: "progress", data: { turn, error: reason } });
    await abandonTurn(ctx, merging).catch(() => undefined);
    return { ok: false, reason: `resolver turn failed: ${reason}` };
  }
}
