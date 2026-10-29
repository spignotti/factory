import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseRef, changedFiles, diffStat, gitOk, revParse } from "../git.js";
import { callAgent, type RunContext } from "../pipeline/context.js";
import type { PackageStatus } from "../pipeline/dag.js";
import { fixStep } from "../pipeline/loop.js";
import { openFindings, type TrackedFinding } from "../pipeline/merge.js";
import { type MergePolicy, mergePolicy, riskClass, type RiskAssessment } from "../pipeline/risk.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { type GateReport, runGates } from "./gates.js";

export interface FinalizeInput {
  result: "done" | "needs_human";
  reason: string;
  rounds: number;
  findings: TrackedFinding[];
  packages: Map<string, PackageStatus>;
  failures: Record<string, string>;
  gates?: GateReport;
  noPr: boolean;
  startedAt: number;
}

export interface FinalizeOutput {
  result: "done" | "needs_human";
  reason: string;
  risk: RiskAssessment;
  mergePolicy: MergePolicy;
  pr: string | null;
}

/** Base moved since intake → rebase + re-run gates; conflict or red → needs_human. */
async function syncBase(ctx: RunContext): Promise<{ ok: boolean; reason: string; gates?: GateReport }> {
  const ref = await baseRef(ctx.repoDir, ctx.repo.base_branch);
  const current = await revParse(ctx.repoDir, ref);
  if (current === ctx.baseSha) return { ok: true, reason: "" };
  ctx.events.emit({ step: "finalize", event: "progress", data: { base_moved: { from: ctx.baseSha, to: current } } });
  if (!(await gitOk(ctx.worktree, ["-c", "user.name=factory", "-c", "user.email=factory@localhost", "rebase", "-q", current]))) {
    await gitOk(ctx.worktree, ["rebase", "--abort"]);
    return { ok: false, reason: "base moved: rebase conflict" };
  }
  ctx.baseSha = current;
  const gates = await runGates(ctx, "full", ctx.plan.packages.map((p) => p.id));
  return gates.green ? { ok: true, reason: "", gates } : { ok: false, reason: "base moved: gates red after rebase", gates };
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderPrBody(ctx: RunContext, v: {
  summary: string;
  input: FinalizeInput;
  out: Omit<FinalizeOutput, "pr">;
  gates?: GateReport;
  changed: string[];
}): string {
  const { plan, handoffs } = ctx;
  const { input, out } = v;
  const evidence = (id: string) =>
    handoffs.flatMap((h) => h.evidence.filter((e) => e.acceptance_id === id).map((e) => `${e.kind}: \`${e.ref}\``));
  const pkgDone = (id: string) => input.packages.get(id) === "done";
  const rows = plan.acceptance.map((a) => {
    const ev = evidence(a.id);
    const verified = pkgDone(a.package) && (ev.length > 0 || a.verify === "review");
    return `| ${verified ? "[x]" : "[ ]"} | ${a.id} | ${cell(a.text)} | ${a.verify} | ${cell(ev.join(", ") || (a.verify === "review" ? "reviewer verdict" : "—"))} |`;
  });
  const unverified = plan.acceptance.filter((a) => !pkgDone(a.package) || (evidence(a.id).length === 0 && a.verify !== "review"));
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- none");
  const migrations = v.changed.filter((f) => f.includes("migrations/"));
  const fill: Record<string, string> = {
    summary: v.summary,
    risk: out.risk.risk,
    merge_policy: out.mergePolicy,
    risk_reasons: list(out.risk.reasons),
    revert_notes: migrations.length ? `Migrations changed (${migrations.join(", ")}): roll them back explicitly.` : "",
    packages: plan.packages.map((p) => `- ${p.id} ${p.title}: ${input.packages.get(p.id) ?? "not run"}${input.failures[p.id] ? ` (${input.failures[p.id]})` : ""}`).join("\n"),
    acceptance: rows.join("\n"),
    unverified: unverified.length ? `Unverified criteria: ${unverified.map((a) => a.id).join(", ")}` : "All criteria have evidence.",
    deviations: list(handoffs.flatMap((h) => [
      ...h.deviations_from_plan.map((d) => `deviation (${h.package}): ${d}`),
      ...h.skipped.map((d) => `skipped (${h.package}): ${d}`),
      ...h.uncertain.map((d) => `uncertain (${h.package}): ${d}`),
    ])),
    gates: v.gates ? v.gates.checks.map((c) => `- ${c.status === "pass" ? "✅" : c.status === "flaky" ? "⚠️" : "❌"} ${c.name} (${c.kind}${c.status === "flaky" ? ", flaky" : ""})`).join("\n") : "- not run",
    review: list(input.findings.filter((f) => f.status !== "open").map((f) => `${f.id} ${f.severity}: ${f.status}`)),
    stats: [
      `- rounds: ${input.rounds}`,
      `- duration: ${((Date.now() - input.startedAt) / 60_000).toFixed(1)} min`,
      `- tokens: ${ctx.events.totals.tokens_in} in / ${ctx.events.totals.tokens_out} out`,
      `- cost: $${ctx.events.totals.cost_usd.toFixed(4)}`,
    ].join("\n"),
    blockers: out.result === "needs_human"
      ? `\n## Blockers (needs_human)\n\n${out.reason}\n${list(openFindings(input.findings).filter((f) => f.severity === "bug").map((f) => `${f.id}: ${f.claim} (${f.file}:${f.line})`))}\n`
      : "",
    closes: ctx.task.issue !== undefined && out.result === "done" ? `\nCloses #${ctx.task.issue}\n` : "",
  };
  return asset("standards/pr-template.md").replace(/\{\{(\w+)\}\}/g, (_, k: string) => fill[k] ?? "");
}

async function summarize(ctx: RunContext): Promise<string> {
  try {
    const res = await callAgent(ctx, "finalize", {
      role: "pr_writer",
      cwd: ctx.worktree,
      tools: "none",
      system: rolePrompt("pr_writer"),
      prompt: [asData("plan", JSON.stringify(ctx.plan, null, 2)), asData("handoffs", JSON.stringify(ctx.handoffs, null, 2))].join("\n\n"),
    });
    return res.text.trim() || ctx.plan.goal;
  } catch (e) {
    ctx.events.emit({ step: "finalize", event: "progress", data: { pr_writer_failed: (e as Error).message.slice(0, 200) } });
    return ctx.plan.goal;
  }
}

export async function finalize(ctx: RunContext, input: FinalizeInput): Promise<FinalizeOutput> {
  ctx.events.emit({ step: "finalize", event: "step_started", data: { result: input.result } });
  let result = input.result;
  let reason = input.reason;
  let gates = input.gates;
  if (result === "done") {
    gates = await runGates(ctx, "full", ctx.plan.packages.map((p) => p.id));
    if (!gates.green) {
      const fixed = await fixStep(ctx, "finalize", { open: [], gates, tier: "full" }, { gateFailures: 0 });
      if (fixed.ok) gates = fixed.gates;
      else {
        result = "needs_human";
        reason = fixed.reason;
      }
    }
  }
  if (result === "done") {
    const synced = await syncBase(ctx);
    if (synced.gates) gates = synced.gates;
    if (!synced.ok) {
      result = "needs_human";
      reason = synced.reason;
    }
  }

  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const diffLines = [...(await diffStat(ctx.worktree, ctx.baseSha)).values()].reduce((a, b) => a + b, 0);
  const risk = riskClass({ changed, diffLines, repo: ctx.repo });
  const policy = mergePolicy(risk.risk, result, ctx.repo.merge);
  const out = { result, reason, risk, mergePolicy: policy };
  const body = renderPrBody(ctx, { summary: await summarize(ctx), input, out, gates, changed });
  writeFileSync(join(ctx.runDir, "pr.md"), body);

  let pr: string | null = null;
  const hasCommits = (await revParse(ctx.worktree, "HEAD")) !== ctx.baseSha;
  if (!input.noPr && hasCommits) {
    const prefix = ctx.plan.type === "bug" ? "fix" : ctx.plan.type === "chore" ? "chore" : "feat";
    try {
      await ctx.deps.github.push(ctx.worktree, ctx.branch);
      pr = await ctx.deps.github.createPr({
        repoDir: ctx.worktree,
        head: ctx.branch,
        base: ctx.repo.base_branch,
        title: `${prefix}: ${ctx.plan.goal}`,
        body,
        draft: result !== "done",
      });
      if (policy === "auto") await ctx.deps.github.enableAutoMerge(ctx.worktree, pr);
    } catch (e) {
      const msg = `PR step failed: ${(e as Error).message.slice(0, 300)}`;
      ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: msg } });
      return { result: "needs_human", reason: result === "done" ? msg : `${reason}; ${msg}`, risk, mergePolicy: "human_review", pr };
    }
  } else if (!input.noPr) {
    reason = reason ? `${reason}; no commits, no PR` : "no commits, no PR";
  }
  ctx.events.emit({ step: "finalize", event: "step_finished", data: { result, risk: risk.risk, merge_policy: policy, pr } });
  return { ...out, reason, pr };
}
