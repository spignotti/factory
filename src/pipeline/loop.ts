import { existsSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, commitAll, diffText, headSha, stageAll } from "../git.js";
import { asData, taskBlock } from "../prompts.js";
import type { Handoff } from "../schemas/handoff.js";
import type { ReviewOutput } from "../schemas/review.js";
import { blockedRepairReason, clearRepair, ensureBudget, recoverRedGates } from "./recovery.js";
import { failureSummary, type GateReport, runGates } from "../steps/gates.js";
import { dropStrayHandoff, gitAuthor, handoffShape, implementerTurn } from "../steps/implement.js";
import { evaluateRound } from "../steps/evaluate.js";
import { reviewRound } from "../steps/review.js";
import { checkDeadline, type RunContext, writeJson } from "./context.js";
import { decideExit, isStalemate, mergeRound, openFindings, type TrackedFinding } from "./merge.js";
import { settlePlanDispute } from "./plan-authority.js";
import { invalidateAffected, reviewCoversHead } from "./review-bind.js";

export interface LoopOutcome {
  result: "done" | "needs_human";
  reason: string;
  rounds: number;
  findings: TrackedFinding[];
  gates?: GateReport;
  /** SHA the last completed review covered. Absent when this entry did not review. */
  reviewedSha?: string;
}

/** Every open id answered with fixed or wontfix + reason (validated in code). */
export function validateResponses(handoff: Handoff, open: TrackedFinding[]): string[] {
  const errors: string[] = [];
  for (const f of open) {
    const r = handoff.responses.find((x) => x.finding_id === f.id);
    if (!r) errors.push(`no response for ${f.id}`);
    else if (r.status === "wontfix" && !r.response.trim()) errors.push(`wontfix for ${f.id} needs a reason`);
  }
  return errors;
}

/** Shared fix attempt counter: gate failures in fix rounds count against it, not against review rounds. */
interface FixState {
  gateFailures: number;
}

/**
 * One fix session (fresh per round): findings and/or gate failures in, handoff with responses out,
 * fast gates after, failure tail back into the same session. Returns the gate report or an error.
 */
export async function fixStep(
  ctx: RunContext,
  label: string,
  input: { open: TrackedFinding[]; gates?: GateReport; tier?: "fast" | "full" },
  state: FixState,
): Promise<{ ok: true; gates: GateReport } | { ok: false; reason: string }> {
  const blocked = await blockedRepairReason(ctx);
  if (blocked) return { ok: false, reason: blocked };
  if (ctx.budget) state.gateFailures = ctx.budget.gateAttempts;
  await stageAll(ctx.worktree);
  const diff = await diffText(ctx.worktree, ctx.baseSha);
  const findings = input.open.map(({ id, severity, file, line, claim, evidence, fix }) => ({ id, severity, file, line, claim, evidence, fix }));
  const tier = input.tier ?? "fast";
  const packages = ctx.plan.packages.map((p) => p.id);
  const commitFix = async (gates: GateReport): Promise<{ ok: true; gates: GateReport }> => {
    clearRepair(ensureBudget(ctx));
    state.gateFailures = 0;
    ctx.persist?.();
    await dropStrayHandoff(ctx, "fix");
    await commitAll(ctx.worktree, `fix: ${label === "finalize" ? "finalize gates" : `address review round ${label}`}`, gitAuthor(ctx));
    return { ok: true, gates };
  };
  let prompt = [
    "Fix round. Fix the class, not the instance: search for the same pattern and fix all occurrences.",
    findings.length ? "Answer every finding id with fixed or wontfix + reason in `responses`." : "",
    asData("plan", JSON.stringify(ctx.plan, null, 2)),
    taskBlock(ctx),
    asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
    asData("diff", diff),
    findings.length ? asData("open_findings", JSON.stringify(findings, null, 2)) : "",
    input.gates && !input.gates.green ? asData("gate_failures", failureSummary(input.gates)) : "",
    handoffShape(ctx, "fix"),
  ].filter(Boolean).join("\n\n");
  if (input.gates && !input.gates.green) {
    const prepared = await recoverRedGates(ctx, input.gates, { tier, packages, spend: false });
    if (prepared.action === "stop") return { ok: false, reason: prepared.reason };
    if (prepared.action === "green") return commitFix(prepared.gates);
    const timeoutNote = prepared.gates.checks.some((c) => c.status === "timeout")
      ? "A timed-out check was killed and is inconclusive, not a failing test.\n\n"
      : "";
    prompt += `\n\nGates are red. Fix the failures, then reply with the updated handoff.\n\n${timeoutNote}${asData("current_gate_failures", failureSummary(prepared.gates))}`;
  }
  const sessionKey = `${ctx.runId}-fix-${label}`;
  for (;;) {
    checkDeadline(ctx);
    const turn = await implementerTurn(ctx, "fix", {
      sessionKey,
      packageId: "fix",
      prompt,
      validate: (h) => validateResponses(h, input.open),
    });
    if (!turn.handoff) return { ok: false, reason: `invalid fix handoff: ${turn.errors.join("; ")}` };
    const handoff = turn.handoff;
    writeJson(ctx, `handoff-fix-${label}.json`, handoff);
    const pkg = `fix-${label}`;
    ctx.handoffs = [...ctx.handoffs.filter((h) => h.package !== pkg), { ...handoff, package: pkg }];
    for (const f of input.open) {
      const r = handoff.responses.find((x) => x.finding_id === f.id);
      if (r) f.response = r;
    }
    const gates = await runGates(ctx, tier, packages);
    if (gates.green) return commitFix(gates);
    const recovered = await recoverRedGates(ctx, gates, { tier, packages, spend: true });
    state.gateFailures = ensureBudget(ctx).gateAttempts;
    if (recovered.action === "green") return commitFix(recovered.gates);
    if (recovered.action === "stop") return { ok: false, reason: recovered.reason };
    const timeoutNote = recovered.gates.checks.some((c) => c.status === "timeout")
      ? "A timed-out check was killed and is inconclusive, not a failing test.\n\n"
      : "";
    prompt = `Gates are red. Fix the failures, then reply with the updated handoff.\n\n${timeoutNote}${asData("current_gate_failures", failureSummary(recovered.gates))}`;
  }
}

export interface ReviewLoopOptions {
  /**
   * Round number to start at (resume continues the numbering so finding ids stay unique).
   * Pass the checkpoint findings and reviewed SHA: an unchanged tree is not reviewed again,
   * and a moved tree reviews the delta.
   */
  firstRound?: number;
  findings?: TrackedFinding[];
  reviewedSha?: string;
  /** Called after every round (state persistence). */
  onRound?: (round: number, findings: TrackedFinding[], reviewedSha?: string) => void;
}

/**
 * Evaluate before the reviewers: any evaluator bug skips the reviewers this round and goes
 * straight to fix, so reviewers never read code that does not work. Without a ui change the
 * evaluator's still open findings are resolved (the change no longer touches the app).
 */
export async function evaluateFirst(ctx: RunContext, round: number, findings: TrackedFinding[]): Promise<{ review?: ReviewOutput; bugs: number }> {
  const report = await evaluateRound(ctx, round, findings);
  if (!report) {
    const prior = findings.filter((f) => f.reviewer === "evaluator" && f.status === "open");
    return prior.length ? { review: { reviewer: "evaluator", prior: prior.map((f) => ({ finding_id: f.id, verdict: "resolved" })), findings: [] }, bugs: 0 } : { bugs: 0 };
  }
  return { review: report.review, bugs: report.review.findings.filter((f) => f.severity === "bug").length };
}

function applyPlanSettlement(ctx: RunContext, findings: TrackedFinding[]): string | undefined {
  const exists = (file: string) => existsSync(join(ctx.worktree, file));
  const settled = settlePlanDispute(ctx.plan, ctx.task.text, findings, exists);
  if (settled.decision) return settled.decision;
  if (!settled.notes.length) return;
  const resolved = new Set(settled.resolvedIds);
  for (const finding of findings) if (resolved.has(finding.id)) finding.status = "resolved";
  ctx.plan.packages = settled.plan.packages;
  ctx.plan.acceptance = settled.plan.acceptance;
  ctx.plan.out_of_scope = settled.plan.out_of_scope;
  writeJson(ctx, "plan.json", ctx.plan);
  ctx.events.emit({ step: "review", event: "progress", data: { plan_corrected: settled.notes } });
  return;
}

/** One review of the commits since `reviewedSha`. An open bug on that delta blocks; it does not start another fix. */
export async function reviewDelta(
  ctx: RunContext,
  input: { round: number; gates: GateReport; findings: TrackedFinding[]; reviewedSha: string },
): Promise<{ ok: true; findings: TrackedFinding[]; reviewedSha: string } | { ok: false; reason: string; findings: TrackedFinding[] }> {
  const delta = await changedFiles(ctx.worktree, input.reviewedSha);
  const prior = invalidateAffected(input.findings, delta);
  const reviews = await reviewRound(ctx, { round: input.round, gates: input.gates, findings: prior, lastReviewedSha: input.reviewedSha });
  const merged = mergeRound(prior, input.round, reviews, ctx.repo.review.max_nits);
  const dispute = applyPlanSettlement(ctx, merged.findings);
  if (dispute) return { ok: false, reason: dispute, findings: merged.findings };
  const openBugs = openFindings(merged.findings).filter((f) => f.severity === "bug");
  if (openBugs.length) {
    return { ok: false, reason: `open bug on the final tree: ${openBugs.map((b) => b.claim).join("; ")}`, findings: merged.findings };
  }
  return { ok: true, findings: merged.findings, reviewedSha: await headSha(ctx.worktree) };
}

/** loop { fast gates → evaluate → review → merge → exit? → fix }. */
export async function reviewLoop(
  ctx: RunContext,
  initialGates: GateReport,
  opts: ReviewLoopOptions = {},
  state: FixState = { gateFailures: 0 },
): Promise<LoopOutcome> {
  const maxRounds = ctx.repo.review.max_rounds;
  const firstRound = opts.firstRound ?? 1;
  let findings: TrackedFinding[] = opts.findings ?? [];
  let gates = initialGates;
  let lastReviewedSha = opts.reviewedSha;
  const heldRounds = Math.max(0, firstRound - 1);
  if (lastReviewedSha) {
    const head = await headSha(ctx.worktree);
    const openBugs = openFindings(findings).filter((f) => f.severity === "bug");
    const cover = reviewCoversHead(lastReviewedSha, head, openBugs.length);
    if (cover === "skip_clean") {
      return { result: "done", reason: "reviewed commit unchanged", rounds: heldRounds, findings, gates, reviewedSha: lastReviewedSha };
    }
    if (cover === "block_bug") {
      return {
        result: "needs_human",
        reason: `open bug on the reviewed commit: ${openBugs.map((b) => `${b.id}: ${b.claim}`).join("; ")}`,
        rounds: heldRounds,
        findings,
        gates,
        reviewedSha: lastReviewedSha,
      };
    }
  }
  for (let round = firstRound; ; round++) {
    checkDeadline(ctx);
    if (lastReviewedSha) findings = invalidateAffected(findings, await changedFiles(ctx.worktree, lastReviewedSha));
    const evaluation = await evaluateFirst(ctx, round, findings);
    const skipReview = evaluation.bugs > 0;
    const reviews = skipReview ? [] : await reviewRound(ctx, { round, gates, findings, lastReviewedSha });
    if (evaluation.review) reviews.push(evaluation.review);
    // Reviewers that were skipped have not seen this HEAD: their next diff starts where they stopped.
    if (!skipReview) lastReviewedSha = await headSha(ctx.worktree);
    const merged = mergeRound(findings, round, reviews, ctx.repo.review.max_nits);
    findings = merged.findings;
    const dispute = applyPlanSettlement(ctx, findings);
    writeJson(ctx, `merged-${round}.json`, { ...merged, findings });
    const open = openFindings(findings);
    opts.onRound?.(round, findings, lastReviewedSha);
    if (dispute) {
      return { result: "needs_human", reason: dispute, rounds: round, findings, gates, reviewedSha: lastReviewedSha };
    }
    const decision = decideExit({ round: round - firstRound + 1, maxRounds, stalemate: isStalemate(merged), open });
    ctx.events.emit({
      step: "review",
      event: "round_finished",
      data: { round, head: lastReviewedSha, review_skipped: skipReview, open: open.length, open_bugs: open.filter((f) => f.severity === "bug").length, added: merged.added.length, dropped: merged.dropped, decision },
    });
    if (decision.action !== "fix") return { result: decision.action, reason: decision.reason, rounds: round, findings, gates, reviewedSha: lastReviewedSha };

    const fixed = await fixStep(ctx, String(round), { open }, state);
    if (!fixed.ok) return { result: "needs_human", reason: fixed.reason, rounds: round, findings, gates, reviewedSha: lastReviewedSha };
    gates = fixed.gates;
  }
}
