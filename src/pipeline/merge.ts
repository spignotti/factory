import type { FindingResponse } from "../schemas/handoff.js";
import type { Finding, Reviewer, ReviewOutput } from "../schemas/review.js";

export type FindingStatus = "open" | "resolved" | "accepted_wontfix";

export interface TrackedFinding extends Finding {
  id: string;
  reviewer: Reviewer;
  round: number;
  status: FindingStatus;
  response?: FindingResponse;
}

export function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Dedupe key: file + line + normalized claim. Anything less exact is kept as two findings. */
export function findingKey(f: Pick<Finding, "file" | "line" | "claim">): string {
  return `${f.file}:${f.line}:${normalizeClaim(f.claim)}`;
}

/** At most `maxNits` nits per reviewer per round; other severities are never capped. */
export function capNits(findings: Finding[], maxNits: number): Finding[] {
  let nits = 0;
  return findings.filter((f) => f.severity !== "nit" || ++nits <= maxNits);
}

export interface MergeResult {
  findings: TrackedFinding[];
  added: TrackedFinding[];
  /** Resolved findings reported again. */
  reopened: string[];
  /** Prior findings whose wontfix the reviewer rejected. */
  stalemate: string[];
  dropped: { repeats: number; nits: number };
}

/** Applies one round of reviews: verdicts on prior findings, then capped and deduped new findings. */
export function mergeRound(prior: TrackedFinding[], round: number, reviews: ReviewOutput[], maxNits: number): MergeResult {
  const findings = prior.map((f) => ({ ...f }));
  const byId = new Map(findings.map((f) => [f.id, f]));
  const stalemate: string[] = [];
  for (const review of reviews) {
    for (const v of review.prior) {
      const f = byId.get(v.finding_id);
      if (!f || f.reviewer !== review.reviewer) continue;
      if (v.verdict === "resolved") f.status = "resolved";
      else if (v.verdict === "accept_wontfix") f.status = "accepted_wontfix";
      else {
        f.status = "open";
        if (v.verdict === "reject_wontfix") stalemate.push(f.id);
      }
    }
  }

  const known = new Map(findings.map((f) => [findingKey(f), f]));
  const seen = new Set<string>();
  const added: TrackedFinding[] = [];
  const reopened: string[] = [];
  let repeats = 0;
  let nitsDropped = 0;
  for (const review of reviews) {
    const capped = capNits(review.findings, maxNits);
    nitsDropped += review.findings.length - capped.length;
    let n = 0;
    for (const f of capped) {
      const key = findingKey(f);
      const prev = known.get(key);
      if (prev?.status === "resolved" && !seen.has(key)) {
        // Reported again after it was resolved: a regression, not a repeat.
        prev.status = "open";
        reopened.push(prev.id);
        seen.add(key);
        continue;
      }
      if (prev || seen.has(key)) {
        repeats++;
        continue;
      }
      seen.add(key);
      const tracked: TrackedFinding = { ...f, id: `R${round}-${review.reviewer}-${++n}`, reviewer: review.reviewer, round, status: "open" };
      added.push(tracked);
      findings.push(tracked);
    }
  }
  return { findings, added, reopened, stalemate, dropped: { repeats, nits: nitsDropped } };
}

export const openFindings = (fs: TrackedFinding[]): TrackedFinding[] => fs.filter((f) => f.status === "open");

/** Stalemate: a reviewer rejected an implementer's wontfix. */
export function isStalemate(merge: Pick<MergeResult, "stalemate">): boolean {
  return merge.stalemate.length > 0;
}

export interface ExitDecision {
  action: "done" | "needs_human" | "fix";
  rule: 1 | 2 | 3 | 4 | 5 | 6;
  reason: string;
}

/** SPEC §6.7 exit rules, in order. */
export function decideExit(input: { round: number; maxRounds: number; stalemate: boolean; open: TrackedFinding[] }): ExitDecision {
  const { round, maxRounds, stalemate, open } = input;
  const openBugs = open.filter((f) => f.severity === "bug").length;
  if (stalemate) return { action: "needs_human", rule: 1, reason: "stalemate: reviewer rejected a wontfix" };
  if (open.length === 0) return { action: "done", rule: 2, reason: "no open findings" };
  if (round >= maxRounds && openBugs === 0) return { action: "done", rule: 3, reason: "max rounds reached, no open bug" };
  if (round === maxRounds) return { action: "fix", rule: 4, reason: "max rounds reached with open bug: one extra round" };
  if (round > maxRounds) return { action: "needs_human", rule: 5, reason: `open bug after ${round} rounds` };
  return { action: "fix", rule: 6, reason: `${open.length} open finding(s)` };
}
