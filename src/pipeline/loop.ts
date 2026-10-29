import { commitAll, diffText, headSha, stageAll } from "../git.js";
import { asData } from "../prompts.js";
import type { Handoff } from "../schemas/handoff.js";
import type { ReviewOutput } from "../schemas/review.js";
import { failureSummary, type GateReport, runGates } from "../steps/gates.js";
import { gitAuthor, implementerTurn, MAX_GATE_ATTEMPTS } from "../steps/implement.js";
import { evaluateRound } from "../steps/evaluate.js";
import { reviewRound } from "../steps/review.js";
import { checkDeadline, type RunContext, writeJson } from "./context.js";
import { decideExit, isStalemate, mergeRound, openFindings, type TrackedFinding } from "./merge.js";

export interface LoopOutcome {
  result: "done" | "needs_human";
  reason: string;
  rounds: number;
  findings: TrackedFinding[];
  gates?: GateReport;
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
  await stageAll(ctx.worktree);
  const diff = await diffText(ctx.worktree, ctx.baseSha);
  const findings = input.open.map(({ id, severity, file, line, claim, evidence, fix }) => ({ id, severity, file, line, claim, evidence, fix }));
  let prompt = [
    "Fix round. Fix the class, not the instance: search for the same pattern and fix all occurrences.",
    findings.length ? "Answer every finding id with fixed or wontfix + reason in `responses`." : "",
    asData("plan", JSON.stringify(ctx.plan, null, 2)),
    asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
    asData("diff", diff),
    findings.length ? asData("open_findings", JSON.stringify(findings, null, 2)) : "",
    input.gates && !input.gates.green ? asData("gate_failures", failureSummary(input.gates)) : "",
    'Reply with handoff.json as a ```json block with "package":"fix".',
  ].filter(Boolean).join("\n\n");
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
    const gates = await runGates(ctx, input.tier ?? "fast", ctx.plan.packages.map((p) => p.id));
    if (gates.green) {
      await commitAll(ctx.worktree, `fix: ${label === "finalize" ? "finalize gates" : `address review round ${label}`}`, gitAuthor(ctx));
      return { ok: true, gates };
    }
    if (++state.gateFailures >= MAX_GATE_ATTEMPTS) return { ok: false, reason: `gates still red after ${MAX_GATE_ATTEMPTS} fix attempts` };
    prompt = `Gates are red. Fix the failures, then reply with the updated handoff.\n\n${failureSummary(gates)}`;
  }
}

export interface ReviewLoopOptions {
  /**
   * Round number to start at (resume continues the numbering so finding ids stay unique). A resumed
   * loop starts with fresh findings and a fresh round budget: the human fix supersedes them.
   */
  firstRound?: number;
  /** Called after every round (state persistence). */
  onRound?: (round: number, findings: TrackedFinding[]) => void;
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

/** loop { fast gates → evaluate → review → merge → exit? → fix }. */
export async function reviewLoop(
  ctx: RunContext,
  initialGates: GateReport,
  opts: ReviewLoopOptions = {},
  state: FixState = { gateFailures: 0 },
): Promise<LoopOutcome> {
  // Fast lane: at most one fix round, no extra round for an open bug.
  const fast = () => ctx.lane === "fast";
  const maxRounds = () => (fast() ? Math.min(2, ctx.repo.review.max_rounds) : ctx.repo.review.max_rounds);
  const firstRound = opts.firstRound ?? 1;
  let findings: TrackedFinding[] = [];
  let gates = initialGates;
  let lastReviewedSha: string | undefined;
  for (let round = firstRound; ; round++) {
    checkDeadline(ctx);
    const evaluation = await evaluateFirst(ctx, round, findings);
    const skipReview = evaluation.bugs > 0;
    const reviews = skipReview ? [] : await reviewRound(ctx, { round, gates, findings, lastReviewedSha });
    if (evaluation.review) reviews.push(evaluation.review);
    // Reviewers that were skipped have not seen this HEAD: their next diff starts where they stopped.
    if (!skipReview) lastReviewedSha = await headSha(ctx.worktree);
    const merged = mergeRound(findings, round, reviews, ctx.repo.review.max_nits);
    findings = merged.findings;
    writeJson(ctx, `merged-${round}.json`, { ...merged, findings });
    const open = openFindings(findings);
    opts.onRound?.(round, findings);
    const decision = decideExit({ round: round - firstRound + 1, maxRounds: maxRounds(), stalemate: isStalemate(merged), open, extraRound: !fast() });
    ctx.events.emit({
      step: "review",
      event: "round_finished",
      data: { round, head: lastReviewedSha, review_skipped: skipReview, open: open.length, open_bugs: open.filter((f) => f.severity === "bug").length, added: merged.added.length, dropped: merged.dropped, decision },
    });
    if (decision.action !== "fix") return { result: decision.action, reason: decision.reason, rounds: round, findings, gates };

    const fixed = await fixStep(ctx, String(round), { open }, state);
    if (!fixed.ok) return { result: "needs_human", reason: fixed.reason, rounds: round, findings, gates };
    gates = fixed.gates;
  }
}
