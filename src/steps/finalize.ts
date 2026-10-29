import { existsSync } from "node:fs";
import { join } from "node:path";
import { publishEvidence, evidenceUrl } from "../evaluate/evidence.js";
import { criterionEvidence, type EvidenceLink, evaluationMarkdown } from "../evaluate/pr.js";
import { baseRef, changedFiles, diffFiles, diffStat, isAncestor, mergeRef, revParse } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { callAgent, type RunContext, throwIfInterrupted, WallTimeExceeded, writeRunFile } from "../pipeline/context.js";
import type { PackageStatus } from "../pipeline/dag.js";
import { fixStep } from "../pipeline/loop.js";
import { openFindings, type TrackedFinding } from "../pipeline/merge.js";
import { protectedFiles } from "../gates/builtin.js";
import { type MergePolicy, mergePolicy, riskClass, type RiskAssessment } from "../pipeline/risk.js";
import type { RoleUsage } from "../events.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { type GateReport, runGates } from "./gates.js";
import { type EvaluateReport, evidenceDir, latestEvaluateReport } from "./evaluate.js";
import { gitAuthor } from "./implement.js";

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
  /** Resume: the run already opened this PR; update it instead of creating one. */
  existingPr?: { url: string; draft: boolean };
}

/** Label of every PR that changes `human_only_paths`. */
export const PROTECTED_LABEL = "factory:protected-config";

/** The PR section of a run that changes protected config: declared changes and the exact diff. */
export function protectedSection(ctx: Pick<RunContext, "plan">, files: string[], diff: string): string {
  if (!files.length) return "";
  const declared = new Map(ctx.plan.protected_changes.map((c) => [c.file, c]));
  const items = files.map((f) => {
    const c = declared.get(f);
    return c ? `- \`${f}\`: ${c.change} (why: ${c.reason})` : `- \`${f}\`: not declared in the plan`;
  });
  const fence = diff.includes("```") ? "~~~~" : "```";
  const MAX = 30_000; // GitHub caps PR bodies at 65536 characters
  const shown = diff.length > MAX ? `${diff.slice(0, MAX)}\n… diff truncated, see the PR's Files tab` : diff;
  return [
    "## ⚠️ Changes protected config (CI / factory)",
    "",
    "This PR changes files under `human_only_paths`. It is never auto-merged and needs a human's approval.",
    "The factory's gates ran with the base branch's `.factory/repo.yaml`, not the changed one; CI on this PR runs the changed workflow files.",
    "",
    ...items,
    "",
    "<details open><summary>Exact diff of the protected files</summary>",
    "",
    `${fence}diff`,
    shown.trimEnd(),
    fence,
    "",
    "</details>",
    "",
  ].join("\n");
}

export interface FinalizeOutput {
  result: "done" | "needs_human";
  reason: string;
  risk: RiskAssessment;
  mergePolicy: MergePolicy;
  pr: string | null;
  /** Whether the PR is (still) a draft; null without a PR. */
  draft: boolean | null;
}

/**
 * Base moved since intake → merge the base into the branch (as git.author; never a rebase, so the
 * branch never needs a force-push) and re-run the full gates. Conflict (merge aborted) or red gates
 * → needs_human.
 */
export async function syncBase(ctx: RunContext, step = "finalize"): Promise<{ ok: boolean; reason: string; gates?: GateReport }> {
  const ref = await baseRef(ctx.repoDir, ctx.repo.base_branch);
  const current = await revParse(ctx.repoDir, ref);
  if (current === ctx.baseSha || (await isAncestor(ctx.worktree, current))) {
    ctx.baseSha = current;
    return { ok: true, reason: "" };
  }
  ctx.events.emit({ step, event: "progress", data: { base_moved: { from: ctx.baseSha, to: current } } });
  const merged = await mergeRef(ctx.worktree, current, `chore: merge ${ctx.repo.base_branch} into ${ctx.branch}`, gitAuthor(ctx));
  if (!merged.ok) {
    ctx.events.emit({ step, event: "progress", data: { merge_conflict: merged.conflicts } });
    const where = merged.conflicts.length ? `merge conflict in ${merged.conflicts.join(", ")}` : `merge failed: ${merged.error.slice(0, 200)}`;
    return { ok: false, reason: `base ${ctx.repo.base_branch} moved (${current.slice(0, 8)}): ${where}` };
  }
  ctx.baseSha = current;
  const gates = await runGates(ctx, "full", ctx.plan.packages.map((p) => p.id));
  return gates.green
    ? { ok: true, reason: "", gates }
    : { ok: false, reason: `base ${ctx.repo.base_branch} moved: gates red after merging it`, gates };
}

/**
 * Cost lines of the PR stats: USD only for metered providers; subscription usage (OpenCode Go,
 * ChatGPT login) is shown in tokens, since a per-call price does not apply there.
 */
export function costLines(usage: RoleUsage[]): string[] {
  const sub = usage.filter((u) => u.billing === "subscription");
  const metered = usage.filter((u) => u.billing !== "subscription");
  const lines: string[] = [];
  if (sub.length) {
    const tin = sub.reduce((a, u) => a + u.tokens_in, 0);
    const tout = sub.reduce((a, u) => a + u.tokens_out, 0);
    lines.push(`- subscription tokens: ${tin} in / ${tout} out`);
  }
  if (metered.length || !sub.length) lines.push(`- cost (metered providers): $${metered.reduce((a, u) => a + u.cost_usd, 0).toFixed(4)}`);
  return lines;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderPrBody(ctx: RunContext, v: {
  summary: string;
  input: FinalizeInput;
  out: Omit<FinalizeOutput, "pr" | "draft">;
  gates?: GateReport;
  changed: string[];
  /** Latest evaluate report and links to its published evidence. */
  evaluation?: { report?: EvaluateReport; link: EvidenceLink; notes: string[] };
  /** Rendered protectedSection, "" when no protected file changed. */
  protectedConfig?: string;
}): string {
  const { plan, handoffs } = ctx;
  const { input, out } = v;
  const link = v.evaluation?.link ?? (() => undefined);
  const evidence = (id: string) => [
    ...handoffs.flatMap((h) => h.evidence.filter((e) => e.acceptance_id === id).map((e) => `${e.kind}: \`${e.ref}\``)),
    // An evaluator criterion counts as evidenced only when the evaluator found it met.
    ...[criterionEvidence(v.evaluation?.report, id, link)].filter((c) => c?.met).map((c) => c!.cell),
  ];
  const pkgDone = (id: string) => input.packages.get(id) === "done";
  const rows = plan.acceptance.map((a) => {
    const ev = evidence(a.id);
    const verified = pkgDone(a.package) && (ev.length > 0 || a.verify === "review");
    const unmet = criterionEvidence(v.evaluation?.report, a.id, link);
    const shown = ev.length ? ev : unmet && !unmet.met ? [unmet.cell] : [];
    return `| ${verified ? "[x]" : "[ ]"} | ${a.id} | ${cell(a.text)} | ${a.verify} | ${cell(shown.join(", ") || (a.verify === "review" ? "reviewer verdict" : "—"))} |`;
  });
  const unverified = plan.acceptance.filter((a) => !pkgDone(a.package) || (evidence(a.id).length === 0 && a.verify !== "review"));
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- none");
  const migrations = v.changed.filter((f) => f.includes("migrations/"));
  const fill: Record<string, string> = {
    summary: v.summary,
    protected: v.protectedConfig ? `\n${v.protectedConfig}` : "",
    risk: out.risk.risk,
    merge_policy: out.mergePolicy,
    risk_reasons: list(out.risk.reasons),
    revert_notes: migrations.length ? `Migrations changed (${migrations.join(", ")}): roll them back explicitly.` : "",
    packages: plan.packages.map((p) => `- ${p.id} ${p.title}: ${input.packages.get(p.id) ?? "not run"}${input.failures[p.id] ? ` (${input.failures[p.id]})` : ""}`).join("\n"),
    acceptance: rows.join("\n"),
    evaluation: evaluationMarkdown(v.evaluation?.report, link, v.evaluation?.notes ?? []),
    unverified: unverified.length ? `Unverified criteria: ${unverified.map((a) => a.id).join(", ")}` : "All criteria have evidence.",
    deviations: list(handoffs.flatMap((h) => [
      ...h.deviations_from_plan.map((d) => `deviation (${h.package}): ${d}`),
      ...h.skipped.map((d) => `skipped (${h.package}): ${d}`),
      ...h.uncertain.map((d) => `uncertain (${h.package}): ${d}`),
    ])),
    gates: v.gates ? v.gates.checks.map((c) => `- ${c.status === "pass" ? "✅" : c.status === "flaky" ? "⚠️" : "❌"} ${c.name} (${c.kind}${c.status === "flaky" ? ", flaky" : ""})`).join("\n") : "- not run",
    review: list(input.findings.filter((f) => f.status !== "open").map((f) => `${f.id} ${f.severity}: ${f.status}`)),
    stats: [
      ctx.laneEscalation.length
        ? `- lane: fast → standard (${ctx.laneEscalation.join("; ")})`
        : `- lane: ${ctx.lane}${ctx.lane === "fast" ? " (lean review, at most one fix round)" : ""}`,
      `- rounds: ${input.rounds}`,
      `- duration: ${((Date.now() - input.startedAt) / 60_000).toFixed(1)} min`,
      `- tokens: ${ctx.events.totals.tokens_in} in / ${ctx.events.totals.tokens_out} out`,
      ...costLines(ctx.events.usage()),
      "- models (role: model, calls, tokens in/out, cost or subscription):",
      ...ctx.events.usage().map(
        (u) => `  - ${u.role}: \`${u.model}\` ×${u.calls}${u.errors ? ` (${u.errors} failed)` : ""}, ${u.tokens_in}/${u.tokens_out}, ${u.billing === "subscription" ? "subscription" : `$${u.cost_usd.toFixed(4)}`}`,
      ),
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
      system: rolePrompt("pr_writer", ctx.deps.prompts),
      prompt: [asData("plan", JSON.stringify(ctx.plan, null, 2)), asData("handoffs", JSON.stringify(ctx.handoffs, null, 2))].join("\n\n"),
    });
    return res.text.trim() || ctx.plan.goal;
  } catch (e) {
    if (e instanceof Interrupted || e instanceof WallTimeExceeded) throw e;
    ctx.events.emit({ step: "finalize", event: "progress", data: { pr_writer_failed: (e as Error).message.slice(0, 200) } });
    return ctx.plan.goal;
  }
}

/**
 * Publishes the latest evaluate report's evidence on the `factory-evidence` branch (only when a PR
 * is opened or updated). A failure is a note in the PR, never a run failure.
 */
async function publishRunEvidence(ctx: RunContext, publish: boolean): Promise<{ report?: EvaluateReport; link: EvidenceLink; notes: string[] } | undefined> {
  const report = latestEvaluateReport(ctx.runDir);
  if (!report) return undefined;
  const none: EvidenceLink = () => undefined;
  if (!publish) return { report, link: none, notes: [] };
  const dir = evidenceDir(ctx.runDir);
  const files = [...new Set(report.evidence.map((e) => e.file).concat(report.pages.flatMap((p) => (p.base ? [p.base] : []))))].filter((f) => existsSync(join(dir, f)));
  if (!files.length) return { report, link: none, notes: [] };
  try {
    const pub = await publishEvidence(ctx.repoDir, { runId: ctx.runId, dir, files, author: gitAuthor(ctx) });
    ctx.events.emit({ step: "finalize", event: "progress", data: { evidence: { sha: pub.sha, files: pub.paths.size, skipped: pub.skipped.length } } });
    const slug = pub.slug;
    const link: EvidenceLink = (f) => {
      const path = pub.paths.get(f);
      return path && slug ? evidenceUrl(slug, pub.sha, path) : undefined;
    };
    const notes = [
      ...(slug ? [] : [`evidence: branch factory-evidence @ ${pub.sha.slice(0, 12)}, folder ${ctx.runId}/`]),
      ...pub.skipped.map((s) => `evidence not published: ${s}`),
    ];
    return { report, link, notes };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    ctx.events.emit({ step: "finalize", event: "progress", data: { evidence_error: msg } });
    return { report, link: none, notes: [`evidence not published: ${msg}`] };
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
  const risk = riskClass({ changed, diffLines, repo: ctx.repo, laneEscalated: ctx.laneEscalation.length > 0 });
  const guarded = protectedFiles(changed, ctx.repo.human_only_paths);
  // Protected config never merges on its own, whatever the merge settings say.
  const policy: MergePolicy = guarded.length ? "human_review" : mergePolicy(risk.risk, result, ctx.repo.merge);
  const out = { result, reason, risk, mergePolicy: policy };
  const hasCommits = (await revParse(ctx.worktree, "HEAD")) !== ctx.baseSha;
  const evaluation = await publishRunEvidence(ctx, !input.noPr && hasCommits);
  const protectedConfig = protectedSection(ctx, guarded, await diffFiles(ctx.worktree, ctx.baseSha, guarded));
  if (guarded.length) ctx.events.emit({ step: "finalize", event: "progress", data: { protected_changes: guarded } });
  const body = ctx.events.redact(renderPrBody(ctx, { summary: await summarize(ctx), input, out, gates, changed, evaluation, protectedConfig }));
  writeRunFile(ctx, "pr.md", body);

  throwIfInterrupted(ctx.deps);
  let pr: string | null = input.existingPr?.url ?? null;
  let draft: boolean | null = input.existingPr?.draft ?? null;
  if (!input.noPr && hasCommits) {
    const prefix = ctx.plan.type === "bug" ? "fix" : ctx.plan.type === "chore" ? "chore" : "feat";
    const title = ctx.events.redact(`${prefix}: ${ctx.plan.goal}`);
    try {
      // Plain push: the branch only ever gains commits (merges, never rebases), so no force-push.
      await ctx.deps.github.push(ctx.worktree, ctx.branch);
      if (input.existingPr) {
        await ctx.deps.github.updatePr(ctx.worktree, input.existingPr.url, { title, body });
        if (guarded.length) await ctx.deps.github.addLabel(ctx.worktree, input.existingPr.url, PROTECTED_LABEL);
        if (result === "done" && input.existingPr.draft) {
          await ctx.deps.github.markReady(ctx.worktree, input.existingPr.url);
          draft = false;
        }
      } else {
        pr = await ctx.deps.github.createPr({ repoDir: ctx.worktree, head: ctx.branch, base: ctx.repo.base_branch, title, body, draft: result !== "done", labels: guarded.length ? [PROTECTED_LABEL] : [] });
        draft = result !== "done";
      }
      if (policy === "auto") await ctx.deps.github.enableAutoMerge(ctx.worktree, pr!);
    } catch (e) {
      const msg = `PR step failed: ${(e as Error).message.slice(0, 300)}`;
      ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: msg } });
      return { result: "needs_human", reason: result === "done" ? msg : `${reason}; ${msg}`, risk, mergePolicy: "human_review", pr, draft };
    }
  } else if (!input.noPr) {
    reason = reason ? `${reason}; no commits, no PR` : "no commits, no PR";
  }
  ctx.events.emit({ step: "finalize", event: "step_finished", data: { result, risk: risk.risk, merge_policy: policy, pr } });
  return { ...out, reason, pr, draft };
}
