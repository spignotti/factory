import { commitAll, diffText, headSha, stageAll } from "../git.js";
import { asData } from "../prompts.js";
import type { Handoff } from "../schemas/handoff.js";
import { failureSummary, type GateReport, runGates } from "../steps/gates.js";
import { gitAuthor, implementerTurn, MAX_GATE_ATTEMPTS } from "../steps/implement.js";
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

/** loop { fast gates → review → merge → exit? → fix } (SPEC §6, §6.7). */
export async function reviewLoop(ctx: RunContext, initialGates: GateReport, state: FixState = { gateFailures: 0 }): Promise<LoopOutcome> {
  const maxRounds = ctx.repo.review.max_rounds;
  let findings: TrackedFinding[] = [];
  let gates = initialGates;
  let lastReviewedSha: string | undefined;
  for (let round = 1; ; round++) {
    checkDeadline(ctx);
    const reviews = await reviewRound(ctx, { round, gates, findings, lastReviewedSha });
    lastReviewedSha = await headSha(ctx.worktree);
    const merged = mergeRound(findings, round, reviews, ctx.repo.review.max_nits);
    findings = merged.findings;
    writeJson(ctx, `merged-${round}.json`, { ...merged, findings });
    const open = openFindings(findings);
    const decision = decideExit({ round, maxRounds, stalemate: isStalemate(merged), open });
    ctx.events.emit({
      step: "review",
      event: "round_finished",
      data: { round, open: open.length, open_bugs: open.filter((f) => f.severity === "bug").length, added: merged.added.length, dropped: merged.dropped, decision },
    });
    if (decision.action !== "fix") return { result: decision.action, reason: decision.reason, rounds: round, findings, gates };

    const fixed = await fixStep(ctx, String(round), { open }, state);
    if (!fixed.ok) return { result: "needs_human", reason: fixed.reason, rounds: round, findings, gates };
    gates = fixed.gates;
  }
}
