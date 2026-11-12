import { existsSync } from "node:fs";
import { join } from "node:path";
import { publishEvidence, evidenceUrl } from "../evaluate/evidence.js";
import { criterionEvidence, type EvidenceLink, evaluationMarkdown } from "../evaluate/pr.js";
import { baseRef, changedFiles, diffCountFields, diffFiles, diffTotals, isAncestor, linesCountingTests, mergeRef, repoDiffStat, revParse } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { callAgent, type RunContext, throwIfInterrupted, WallTimeExceeded, writeRunFile } from "../pipeline/context.js";
import type { PackageStatus } from "../pipeline/dag.js";
import { fixStep, reviewDelta } from "../pipeline/loop.js";
import { openFindings, type TrackedFinding } from "../pipeline/merge.js";
import { protectedFiles } from "../gates/builtin.js";
import { diffSizeSignal, type MergePolicy, mergePolicy, riskClass, riskReasonLine, type RiskAssessment, securityRows } from "../pipeline/risk.js";
import type { HostSteps } from "../schemas/plan.js";
import type { RoleUsage } from "../events.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { closesFooter, fulfilledIssues } from "../queue/admit.js";
import { pauseRequested } from "../queue/pause.js";
import { formatGateResults, type GateReport, runGates, skippedSecurityGates } from "./gates.js";
import { type EvaluateReport, evidenceDir, latestEvaluateReport } from "./evaluate.js";
import { gitAuthor } from "./implement.js";
import { ensurePrDraft } from "./pr-draft.js";
import { pollCommitCi } from "../pipeline/ci-wait.js";
import { mayEnableAutoMerge, waitingOnMergeCi } from "../pipeline/merge-ready.js";
import { ensureChangedPathClaim } from "../pipeline/path-claim.js";

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
  /** SHA the in-run review covered. A later commit is reviewed as a delta before merge. */
  reviewedSha?: string;
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
    "This PR changes files under `human_only_paths`.",
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
  result: "done" | "needs_human" | "locked";
  reason: string;
  risk: RiskAssessment;
  mergePolicy: MergePolicy;
  pr: string | null;
  /** Whether the PR is (still) a draft; null without a PR. */
  draft: boolean | null;
  /** Security gates that did not scan. Omitted when none were skipped. */
  skipped_gates?: string[];
  /** SHA the runner approved after local gates. Absent when the run did not finish a PR. */
  approvedSha?: string;
  /** Head CI still unsettled. The auto policy stays; auto-merge waits for this SHA. */
  ciWait?: "pending" | "none";
  /** SHA the review evidence covers after a delta review. */
  reviewedSha?: string;
}

function skippedField(gates: GateReport | undefined): { skipped_gates?: string[] } {
  const skipped_gates = skippedSecurityGates(gates?.checks ?? []);
  return skipped_gates.length ? { skipped_gates } : {};
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
    : { ok: false, reason: baseSyncFailureReason(ctx.repo.base_branch, gates), gates };
}

/** Why a post-merge gate run did not go green. A timeout is named as inconclusive, not as a red base. */
export function baseSyncFailureReason(branch: string, gates: GateReport): string {
  const timed = gates.checks.filter((c) => c.status === "timeout").map((c) => c.name);
  if (timed.length) return `base ${branch} moved: ${timed.join(", ")} timed out (inconclusive, not a red result)`;
  return `base ${branch} moved: gates red after merging it`;
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

/** Copy-paste host commands. Empty when the repo has no section title or the plan has no steps. */
export function hostStepsMarkdown(title: string | undefined, steps: HostSteps | undefined): string {
  if (!title || !steps) return "";
  const host = /mac/i.test(title) ? "production Mac host" : "production host";
  const script = steps.commands.join("\n");
  const fence = [script, steps.verify, steps.rollback].some((s) => s.includes("```")) ? "~~~~" : "```";
  return [
    `## ${title}`,
    "",
    `Run these on the ${host}, in order:`,
    "",
    fence,
    script,
    fence,
    "",
    "**Verify**",
    "",
    steps.verify.trim(),
    "",
    "**Roll back**",
    "",
    steps.rollback.trim(),
    "",
  ].join("\n");
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
  /** Diff-size signal. It is not a risk reason and does not force a human gate. */
  sizeSignal?: string | null;
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
    risk_reason: cell([riskReasonLine(out.risk), v.sizeSignal ? `size signal (does not change risk): ${v.sizeSignal}` : ""].filter(Boolean).join("; ")),
    security_rows: securityRows(v.changed)
      .map((r) => `| ${cell(r.area)} | ${r.touched ? "yes" : "no"} | ${cell(r.note)} |`)
      .join("\n"),
    host_steps: (() => {
      const md = hostStepsMarkdown(ctx.repo.pr?.host_steps_section, ctx.plan.host_steps);
      return md ? `\n${md}` : "";
    })(),
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
    gates: v.gates ? formatGateResults(v.gates.checks) : "- not run",
    review: list(input.findings.filter((f) => f.status !== "open").map((f) => `${f.id} ${f.severity}: ${f.status}`)),
    stats: [
      "- lane: standard",
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
    closes: closesFooter(
      ctx.task.issue,
      out.result,
      fulfilledIssues(
        plan,
        new Set(plan.acceptance.filter((a) => pkgDone(a.package) && (evidence(a.id).length > 0 || a.verify === "review")).map((a) => a.id)),
      ),
    ),
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

/**
 * Plain push (the branch only ever gains commits: merges, never rebases, so no force-push). A push that
 * errors (e.g. a network timeout after the server already took it) counts as done when origin's branch is
 * at `head`.
 */
async function pushIdempotent(ctx: RunContext, head: string): Promise<void> {
  try {
    await ctx.deps.github.push(ctx.worktree, ctx.branch);
  } catch (e) {
    const remote = await ctx.deps.github.remoteBranchSha(ctx.worktree, ctx.branch).catch(() => null);
    if (remote !== head) throw e;
    ctx.events.emit({ step: "finalize", event: "progress", data: { push_error_ignored: { reason: (e as Error).message.slice(0, 200), remote_sha: remote } } });
  }
}

/** The open PR for the run's branch when its head is exactly `head`; undefined otherwise or when GitHub cannot be asked. */
async function adoptablePr(ctx: RunContext, head: string): Promise<{ url: string; draft: boolean } | undefined> {
  const open = await ctx.deps.github.findOpenPr(ctx.worktree, ctx.branch).catch(() => null);
  if (!open || open.headSha !== head) return undefined;
  ctx.events.emit({ step: "finalize", event: "progress", data: { pr_adopted: { pr: open.url, head } } });
  return { url: open.url, draft: open.draft };
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

  let reviewedSha = input.reviewedSha;
  if (result === "done" && reviewedSha && gates) {
    const headNow = await revParse(ctx.worktree, "HEAD");
    if (headNow !== reviewedSha) {
      const delta = await reviewDelta(ctx, { round: input.rounds + 1, gates, findings: input.findings, reviewedSha });
      input.findings = delta.findings;
      if (!delta.ok) {
        result = "needs_human";
        reason = delta.reason;
      } else reviewedSha = delta.reviewedSha;
    }
  }

  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const countTests = ctx.repo.limits.diff_count_tests;
  const totals = diffTotals(await repoDiffStat(ctx.worktree, ctx.baseSha, ctx.repo, { countTests }));
  // Final tree, after a base merge. Test lines stay in the size signal and do not raise the risk class.
  const diffLines = linesCountingTests(totals);
  const sizeSignal = diffSizeSignal(diffLines, ctx.repo.merge.low_max_diff_lines);
  if (sizeSignal) ctx.events.emit({ step: "finalize", event: "progress", data: { diff_signal: sizeSignal } });
  const diffReport = diffCountFields(totals, countTests);
  if (diffReport) {
    ctx.events.diffCount = diffReport;
    ctx.events.emit({ step: "finalize", event: "progress", data: { ...diffReport } });
  }
  const risk = riskClass({ changed, diffLines, repo: ctx.repo });
  const guarded = protectedFiles(changed, ctx.repo.human_only_paths);
  // Protected config never merges on its own, whatever the merge settings say.
  let policy: MergePolicy = guarded.length ? "human_review" : mergePolicy(risk.risk, result, ctx.repo.merge);
  const hasCommits = (await revParse(ctx.worktree, "HEAD")) !== ctx.baseSha;
  let blockPush = false;
  let githubClaimError: string | undefined;
  if (!input.noPr && hasCommits) {
    const claim = await ensureChangedPathClaim(ctx, changed, ctx.wait ?? false);
    if (!claim.ok && claim.kind === "pr") {
      // A ready PR must not stay ready when this resume stops locked (gates may already have failed).
      let draft: boolean | null = input.existingPr?.draft ?? null;
      if (input.existingPr) {
        try {
          const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, input.existingPr);
          draft = held.draft;
          if (held.changed) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_marked_draft: input.existingPr.url } });
        } catch (e) {
          const msg = `PR step failed: ${(e as Error).message.slice(0, 300)}`;
          ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: msg } });
          return { result: "needs_human", reason: `${claim.reason}; ${msg}`, risk, mergePolicy: "human_review", pr: input.existingPr.url, draft, ...(reviewedSha ? { reviewedSha } : {}), ...skippedField(gates) };
        }
      }
      return { result: "locked", reason: claim.reason, risk, mergePolicy: "human_review", pr: input.existingPr?.url ?? null, draft, ...(reviewedSha ? { reviewedSha } : {}) };
    }
    if (!claim.ok && claim.kind === "github") {
      githubClaimError = `PR step failed: ${claim.reason.slice(0, 300)}`;
      reason = result === "done" ? githubClaimError : `${reason}; ${githubClaimError}`;
      result = "needs_human";
      policy = "human_review";
      blockPush = true;
    } else if (!claim.ok) {
      result = "needs_human";
      reason = claim.reason;
      policy = "human_review";
      blockPush = true;
    }
  }
  const out = { result, reason, risk, mergePolicy: policy };
  const evaluation = await publishRunEvidence(ctx, !input.noPr && hasCommits && !blockPush);
  const protectedConfig = protectedSection(ctx, guarded, await diffFiles(ctx.worktree, ctx.baseSha, guarded));
  if (guarded.length) ctx.events.emit({ step: "finalize", event: "progress", data: { protected_changes: guarded } });
  const body = ctx.events.redact(renderPrBody(ctx, { summary: await summarize(ctx), input, out, gates, changed, evaluation, protectedConfig, sizeSignal }));
  writeRunFile(ctx, "pr.md", body);

  throwIfInterrupted(ctx.deps);
  let pr: string | null = input.existingPr?.url ?? null;
  let draft: boolean | null = input.existingPr?.draft ?? null;
  // A pull request is a draft while the run is not done. A done run marks it ready BEFORE the final
  // push (and creates a new PR as ready): a push to a draft starts a draft-hold run on the head that
  // GitHub may register only after markReady, and its deliberate failure would read as red CI.
  const willPush = !input.noPr && hasCommits && !blockPush;
  if (!input.noPr && input.existingPr && result !== "done") {
    try {
      const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, input.existingPr);
      draft = held.draft;
      if (held.changed) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_marked_draft: input.existingPr.url } });
    } catch (e) {
      const msg = `PR step failed: ${(e as Error).message.slice(0, 300)}`;
      ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: msg } });
      return { result: "needs_human", reason: `${reason}; ${msg}`, risk, mergePolicy: "human_review", pr, draft, ...(reviewedSha ? { reviewedSha } : {}), ...skippedField(gates) };
    }
  }
  if (githubClaimError) {
    ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: githubClaimError } });
    return { result: "needs_human", reason, risk, mergePolicy: "human_review", pr, draft, ...(reviewedSha ? { reviewedSha } : {}), ...skippedField(gates) };
  }
  let approvedSha: string | undefined;
  let ciWait: "pending" | "none" | undefined;
  if (willPush) {
    const prefix = ctx.plan.type === "bug" ? "fix" : ctx.plan.type === "chore" ? "chore" : "feat";
    const title = ctx.events.redact(`${prefix}: ${ctx.plan.goal}`);
    try {
      const head = await revParse(ctx.worktree, "HEAD");
      let readyAt: string | undefined;
      if (result === "done" && input.existingPr && draft !== false) {
        readyAt = new Date().toISOString();
        await ctx.deps.github.markReady(ctx.worktree, input.existingPr.url);
        draft = false;
        ctx.events.emit({ step: "finalize", event: "progress", data: { pr_ready: input.existingPr.url } });
      }
      try {
        await pushIdempotent(ctx, head);
      } catch (e) {
        // Marked ready but the final commit did not land: back to draft, so CI does not judge the old head.
        if (readyAt && input.existingPr) {
          const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, { url: input.existingPr.url, draft: false }).catch(() => ({ draft: false, changed: false }));
          draft = held.draft;
          if (held.changed) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_marked_draft: input.existingPr.url } });
        }
        throw e;
      }
      // The required `done` job reads this status. Post it as soon as the commit is on the remote,
      // before PR bookkeeping, so a pull_request run is not stuck waiting on an approval that
      // itself waits for `done`. A later head has no status until this runs again.
      if (result === "done") {
        await ctx.deps.github.approveHead(ctx.worktree, head);
        approvedSha = head;
      }
      // An open PR on this branch (an earlier attempt's create that looked failed, or one opened by hand)
      // is adopted, never duplicated. Known PRs were converted to draft before this push.
      let target = input.existingPr ? { url: input.existingPr.url, draft: draft !== false } : await adoptablePr(ctx, head);
      let created = false;
      if (!target) {
        try {
          const asDraft = result !== "done";
          pr = await ctx.deps.github.createPr({ repoDir: ctx.worktree, head: ctx.branch, base: ctx.repo.base_branch, title, body, draft: asDraft, labels: guarded.length ? [PROTECTED_LABEL] : [] });
          draft = asDraft;
          created = true;
          target = { url: pr, draft: asDraft };
          if (!asDraft) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_ready: pr } });
        } catch (e) {
          target = await adoptablePr(ctx, head);
          if (!target) throw e;
        }
      }
      if (target && !created) {
        pr = target.url;
        if (!target.draft && result !== "done") {
          const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, target);
          target = { url: target.url, draft: held.draft };
          if (held.changed) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_marked_draft: target.url } });
        }
        draft = result === "done" ? target.draft : true;
        await ctx.deps.github.updatePr(ctx.worktree, target.url, { title, body });
        if (guarded.length) await ctx.deps.github.addLabel(ctx.worktree, target.url, PROTECTED_LABEL);
      }
      // A done run is ready by now unless an adopted PR was still a draft: mark that one ready here. Then CI is polled.
      if (target && result === "done") {
        if (target.draft) {
          readyAt = new Date().toISOString();
          await ctx.deps.github.markReady(ctx.worktree, target.url);
          ctx.events.emit({ step: "finalize", event: "progress", data: { pr_ready: target.url } });
        }
        draft = false;
      } else if (target) {
        draft = true;
      }
      // None and pending are the same wait: checks often register after markReady.
      // They are not a failure, but they are not a green head, so auto-merge stays off.
      // Red checks send the PR back to draft and end the run needs_human.
      let headGreen = false;
      if (result === "done" && pr) {
        const ci = await pollCommitCi({
          github: ctx.deps.github,
          repoDir: ctx.worktree,
          sha: head,
          waitMinutes: ctx.repo.limits.pr_ci_wait_minutes,
          pollMs: ctx.deps.baseCiPollMs ?? 30_000,
          sleep: ctx.deps.sleep,
          signal: ctx.deps.signal,
          waitWhile: ["pending", "none"],
          since: readyAt,
          onUpdate: (info) =>
            ctx.events.emit({
              step: "finalize",
              event: "progress",
              data: {
                pr_ci:
                  info.phase === "waiting"
                    ? { status: info.status, sha: head, waiting_up_to_minutes: ctx.repo.limits.pr_ci_wait_minutes }
                    : { status: info.status, sha: head, waited_ms: info.waitedMs },
              },
            }),
        });
        ctx.deadline.extend?.(ci.waitedMs);
        headGreen = ci.status === "green";
        if (ci.status === "red") {
          result = "needs_human";
          reason = `CI on the PR head (${head.slice(0, 8)}) is red`;
          const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, { url: pr, draft: false });
          draft = held.draft;
          if (held.changed) ctx.events.emit({ step: "finalize", event: "progress", data: { pr_marked_draft: pr } });
          await ctx.deps.github.updatePr(ctx.worktree, pr, { title, body: `${body}\n\n## CI\n\nChecks on \`${head.slice(0, 8)}\` are red; the run is needs_human.\n` });
        } else if (waitingOnMergeCi({ policy, ci: ci.status, draft: draft === true, state: "open" })) {
          // The same predicate as the worker. A later commit is a different SHA and is not approved.
          ciWait = ci.status === "pending" ? "pending" : "none";
        }
      }
      // Merge only. Deploy is a separate action and is not called here.
      // Re-read the open head after the CI poll: a push that landed since approveHead is not this SHA.
      let liveSha: string | null = null;
      try {
        liveSha = (await ctx.deps.github.findOpenPr(ctx.worktree, ctx.branch))?.headSha ?? null;
      } catch (e) {
        ctx.events.emit({ step: "finalize", event: "progress", data: { pr_head_unreadable: (e as Error).message.slice(0, 200) } });
      }
      let requiredChecks: readonly string[] | null = null;
      try {
        requiredChecks = (await ctx.deps.github.repoSettings(ctx.worktree, ctx.repo.base_branch)).required_checks;
      } catch (e) {
        ctx.events.emit({ step: "finalize", event: "progress", data: { repo_settings: (e as Error).message.slice(0, 200) } });
      }
      const pause = pauseRequested(ctx.deps.factoryHome, { runId: ctx.runId });
      if (pause && result === "done") {
        // The queue asked this run to stop. A green head is not a reason to merge.
        result = "needs_human";
        reason = `paused: ${pause}; resume with \`factory resume ${ctx.runId}\``;
        const held = await ensurePrDraft(ctx.deps.github, ctx.worktree, { url: pr!, draft: false });
        draft = held.draft;
      } else if (
        result === "done" &&
        liveSha === head &&
        mayEnableAutoMerge({
          policy,
          approvedSha,
          headSha: liveSha,
          reviewedSha,
          ci: headGreen ? "green" : "pending",
          draft: draft === true,
          state: "open",
          requiredChecks,
        })
      ) {
        await ctx.deps.github.enableAutoMerge(ctx.worktree, pr!, head);
      }
    } catch (e) {
      const msg = `PR step failed: ${(e as Error).message.slice(0, 300)}`;
      ctx.events.emit({ step: "finalize", event: "progress", data: { pr_error: msg } });
      return { result: "needs_human", reason: result === "done" ? msg : `${reason}; ${msg}`, risk, mergePolicy: "human_review", pr, draft, ...(reviewedSha ? { reviewedSha } : {}), ...skippedField(gates) };
    }
  } else if (!input.noPr) {
    reason = reason ? `${reason}; no commits, no PR` : "no commits, no PR";
  }
  if (result !== "done") policy = "human_review";
  ctx.events.emit({ step: "finalize", event: "step_finished", data: { result, risk: risk.risk, merge_policy: policy, pr } });
  return {
    ...out,
    result,
    reason,
    mergePolicy: policy,
    pr,
    draft,
    ...(approvedSha && result === "done" ? { approvedSha } : {}),
    ...(ciWait && result === "done" ? { ciWait } : {}),
    ...(reviewedSha ? { reviewedSha } : {}),
    ...skippedField(gates),
  };
}
