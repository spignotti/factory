import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { commitAll, diffText, discardChanges, gitOk, stageAll } from "../git.js";
import { callAgent, checkDeadline, type RunContext, writeJson } from "../pipeline/context.js";
import { type PackageStatus, runInDagOrder } from "../pipeline/dag.js";
import { asData, taskBlock, rolePrompt } from "../prompts.js";
import { type Handoff, HandoffSchema } from "../schemas/handoff.js";
import type { Package } from "../schemas/plan.js";
import { failureSummary, type GateReport, runGates } from "./gates.js";

export const MAX_GATE_ATTEMPTS = 3;

const HANDOFF_SHAPE = `When done, reply with handoff.json as a single \`\`\`json block (in your reply; never write it to a file):
{"package":"<id>","done":[],"decisions":[],"deviations_from_plan":[],"skipped":[],"uncertain":[],
 "evidence":[{"acceptance_id":"A1","kind":"test|check","ref":"<test file>[::<test name>] or <check name>"}],
 "responses":[{"finding_id":"R1-plan-1","status":"fixed|wontfix","response":"reason"}]}`;

/**
 * Removes a root \`handoff.json\` an agent wrote as a file instead of replying with it, so it never
 * lands in a factory commit. Kept when the base has it or a package names it.
 */
export async function dropStrayHandoff(ctx: Pick<RunContext, "worktree" | "baseSha" | "plan" | "events">, step: string): Promise<void> {
  const file = join(ctx.worktree, "handoff.json");
  if (!existsSync(file)) return;
  if (ctx.plan.packages.some((p) => p.files.includes("handoff.json"))) return;
  if (await gitOk(ctx.worktree, ["cat-file", "-e", `${ctx.baseSha}:handoff.json`])) return;
  rmSync(file);
  ctx.events.emit({ step, event: "progress", data: { detail: "removed stray handoff.json" } });
}

export function gitAuthor(ctx: Pick<RunContext, "repo">): { name: string; email: string } {
  const { author, email } = ctx.repo.git;
  return { name: author, email: email ?? `${author}@users.noreply.github.com` };
}

export function parseHandoff(text: string, expectedPackage: string): { ok: true; handoff: Handoff } | { ok: false; errors: string[] } {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, errors: ["no JSON object in output"] };
  const parsed = HandoffSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  if (parsed.data.package !== expectedPackage) return { ok: false, errors: [`package must be ${expectedPackage}`] };
  return { ok: true, handoff: parsed.data };
}

export interface SessionTurn {
  sessionKey: string;
  packageId: string;
  prompt: string;
  /** Extra validation (e.g. finding responses); returns errors. */
  validate?: (h: Handoff) => string[];
}

/** One implementer turn that must end in a valid handoff; invalid → one re-prompt in the same session. */
export async function implementerTurn(ctx: RunContext, step: string, turn: SessionTurn): Promise<{ handoff?: Handoff; errors: string[] }> {
  let prompt = turn.prompt;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callAgent(ctx, step, {
      role: "implement",
      cwd: ctx.worktree,
      tools: "coding",
      system: rolePrompt("implement", ctx.deps.prompts),
      prompt,
      sessionKey: turn.sessionKey,
    });
    const parsed = parseHandoff(res.text, turn.packageId);
    errors = parsed.ok ? (turn.validate?.(parsed.handoff) ?? []) : parsed.errors;
    if (parsed.ok && errors.length === 0) return { handoff: parsed.handoff, errors };
    ctx.events.emit({ step, event: "progress", role: "implement", data: { invalid_handoff: errors } });
    prompt = `Your handoff was invalid:\n- ${errors.join("\n- ")}\n\n${HANDOFF_SHAPE.replace("<id>", turn.packageId)}`;
  }
  return { errors };
}

function setHandoff(ctx: RunContext, handoff: Handoff): void {
  const i = ctx.handoffs.findIndex((h) => h.package === handoff.package);
  if (i >= 0) ctx.handoffs[i] = handoff;
  else ctx.handoffs.push(handoff);
}

async function packagePrompt(ctx: RunContext, pkg: Package): Promise<string> {
  await stageAll(ctx.worktree);
  const diff = await diffText(ctx.worktree, ctx.baseSha);
  return [
    `Implement package ${pkg.id} ("${pkg.title}") of this plan:`,
    asData("plan", JSON.stringify({ ...ctx.plan, current_package: pkg.id }, null, 2)),
    taskBlock(ctx),
    ctx.handoffs.length ? asData("previous_handoffs", JSON.stringify(ctx.handoffs, null, 2)) : "",
    diff ? asData("diff_since_base", diff) : "",
    ctx.briefing ? `Recurring findings in this repo (avoid them):\n${asData("findings_briefing", ctx.briefing)}` : "",
    HANDOFF_SHAPE.replace("<id>", pkg.id),
  ].filter(Boolean).join("\n\n");
}

export interface ImplementOutcome {
  status: Map<string, PackageStatus>;
  failures: Record<string, string>;
  /** Bug plan whose repro never failed on base: never fix blind. */
  needsInput?: string[];
  lastGates?: GateReport;
}

export interface ImplementOptions {
  /** Packages already done (resume): not run again. */
  done?: Iterable<string>;
  /** Called after every package that ran (state persistence). */
  onPackage?: (id: string, status: PackageStatus, failure?: string) => void;
}

/** Implements every package in DAG order; a failed package cascade-skips its dependents. */
export async function implementPackages(ctx: RunContext, opts: ImplementOptions = {}): Promise<ImplementOutcome> {
  const failures: Record<string, string> = {};
  const alreadyDone = new Set(opts.done ?? []);
  const done: string[] = ctx.plan.packages.map((p) => p.id).filter((id) => alreadyDone.has(id));
  let needsInput: string[] | undefined;
  let lastGates: GateReport | undefined;

  const status = await runInDagOrder(ctx.plan.packages, async (pkg) => {
    if (alreadyDone.has(pkg.id)) return true;
    const ok = await implementOne(pkg);
    opts.onPackage?.(pkg.id, ok ? "done" : "failed", failures[pkg.id]);
    return ok;
  });

  async function implementOne(pkg: Package): Promise<boolean> {
    if (needsInput) {
      failures[pkg.id] = "not run: needs_input";
      return false;
    }
    ctx.events.emit({ step: "implement", event: "step_started", data: { package: pkg.id } });
    const sessionKey = `${ctx.runId}-implement-${pkg.id}`;
    let prompt = await packagePrompt(ctx, pkg);
    let reason = "";
    let report: GateReport | undefined;
    for (let attempt = 1; attempt <= MAX_GATE_ATTEMPTS; attempt++) {
      checkDeadline(ctx);
      const turn = await implementerTurn(ctx, "implement", { sessionKey, packageId: pkg.id, prompt });
      if (!turn.handoff) {
        reason = `invalid handoff: ${turn.errors.join("; ")}`;
        break;
      }
      setHandoff(ctx, turn.handoff);
      writeJson(ctx, `handoff-${pkg.id}.json`, turn.handoff);
      report = await runGates(ctx, "fast", [...done, pkg.id]);
      lastGates = report;
      if (report.green) {
        await dropStrayHandoff(ctx, "implement");
        await commitAll(ctx.worktree, `feat(${pkg.id}): ${pkg.title}`, gitAuthor(ctx));
        done.push(pkg.id);
        ctx.events.emit({ step: "implement", event: "step_finished", data: { package: pkg.id, status: "done", attempts: attempt } });
        return true;
      }
      reason = `fast gates red after ${attempt} attempt(s)`;
      prompt = `Gates are red. Fix the failures, then reply with the updated handoff.\n\n${failureSummary(report)}\n\n${HANDOFF_SHAPE.replace("<id>", pkg.id)}`;
    }
    failures[pkg.id] = reason;
    const firstOfBug = ctx.plan.type === "bug" && done.length === 0;
    if (firstOfBug && report?.repro_red_on_base === false) {
      needsInput = [
        `Could not produce a failing repro test for the bug within ${MAX_GATE_ATTEMPTS} attempts. ` +
          `Tried: ${ctx.handoffs.find((h) => h.package === pkg.id)?.done.join("; ") || "(no handoff)"}. ` +
          "How can the bug be reproduced?",
      ];
    }
    ctx.handoffs = ctx.handoffs.filter((h) => h.package !== pkg.id);
    await discardChanges(ctx.worktree);
    ctx.events.emit({ step: "implement", event: "step_finished", data: { package: pkg.id, status: "failed", reason } });
    return false;
  }

  for (const [id, s] of status) {
    if (s !== "skipped") continue;
    ctx.events.emit({ step: "implement", event: "step_finished", data: { package: id, status: "skipped" } });
    opts.onPackage?.(id, "skipped");
  }
  return { status, failures, needsInput, lastGates };
}
