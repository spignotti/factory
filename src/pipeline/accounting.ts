import type { FactoryEvent } from "../events.js";
import type { RunRecord } from "../runs.js";

/**
 * Wait classes the status and stats text name. Replan, retry and review rounds are not
 * classes: they are counted beside these so a repair loop is not relabelled as waiting.
 */
export const WAIT_CLASSES = ["dependency", "capacity", "ci_runner", "provider", "human_decision", "technical_repair", "unclassified"] as const;
export type WaitClass = (typeof WAIT_CLASSES)[number];

const DEPENDENCY = /\bafter #\d+|\bdependency\b|\bcycle\b|\bblocked by\b|\bpredecessor\b|\bwaiting for #\d+/i;
const CAPACITY = /global coding cap|max_runs|coding slot|waiting for lock|resource .+ held/i;
const CI = /\bCI\b|\brunner\b|\bworkflow\b|base_red|base CI|\bactions\b/i;
const PROVIDER = /provider|quota|rate limit|connection error|\bTLS\b|capacity error/i;
const HUMAN = /needs_human|needs_input|needs-decision|needs a decision|human_review/i;
const REPAIR = /\bformat\b|\blint\b|\btypecheck\b|\brepair\b|gate fail|formatter/i;
const ROUND_NOTE = /^(replan|retry|review round|review)\b/i;

/** Classify one stored reason. An empty reason is unclassified and is not a zero wait. */
export function classifyWait(reason: string, result?: string): WaitClass {
  const text = reason.trim();
  if (ROUND_NOTE.test(text)) return "unclassified";
  if (DEPENDENCY.test(text)) return "dependency";
  if (CAPACITY.test(text)) return "capacity";
  if (CI.test(text) || result === "base_red") return "ci_runner";
  if (PROVIDER.test(text)) return "provider";
  if (HUMAN.test(text) || result === "needs_human" || result === "needs_input") return "human_decision";
  if (REPAIR.test(text)) return "technical_repair";
  return "unclassified";
}

export interface MergeObservation {
  /**
   * True only when the stored outcome is `confirmed` and GitHub does not say the PR is still
   * open or closed without merge. A matching login never sets this.
   */
  autonomous: boolean;
  presentation: "unmerged" | "actually_merged" | "closed_without_merge" | "unknown_origin";
}

/**
 * How to show a merge. `actorLogin` and `factoryLogin` are accepted so a caller can pass them
 * through; equality is not a confirmation. An unknown actor stays unknown.
 */
export function observeMerge(input: {
  stored?: "no" | "confirmed" | "unknown";
  github?: "open" | "merged" | "closed";
  actorLogin?: string | null;
  factoryLogin?: string | null;
}): MergeObservation {
  const storedConfirmed = input.stored === "confirmed";
  const sameLogin = input.actorLogin != null && input.actorLogin.length > 0 && input.actorLogin === input.factoryLogin;
  if (input.github === "closed") return { autonomous: false, presentation: "closed_without_merge" };
  if (!storedConfirmed && (input.github === "merged" || sameLogin)) return { autonomous: false, presentation: input.github === "merged" ? "unknown_origin" : "unmerged" };
  if (storedConfirmed && input.github !== "open") return { autonomous: true, presentation: "actually_merged" };
  return { autonomous: false, presentation: "unmerged" };
}

function attemptScore(run: RunRecord): number {
  const attempts = run.result?.outcome?.attempts;
  return (run.result ? 2 : 0) + (typeof attempts === "number" ? attempts : 0);
}

/** One row per run id. Resume and a second read of the same id keep the later attempt, not both. */
export function dedupeRuns(runs: RunRecord[]): RunRecord[] {
  const byId = new Map<string, RunRecord>();
  for (const run of runs) {
    const prev = byId.get(run.run_id);
    if (!prev || attemptScore(run) >= attemptScore(prev)) byId.set(run.run_id, run);
  }
  return [...byId.values()];
}

/** Sum of recorded `waited_ms` values, in minutes. No sample stays null, not zero. */
export function waitedMinutes(events: FactoryEvent[]): number | null {
  let ms = 0;
  let seen = false;
  for (const event of events) {
    const waited = event.data.waited_ms;
    if (typeof waited === "number" && Number.isFinite(waited) && waited >= 0) {
      ms += waited;
      seen = true;
    }
  }
  return seen ? Math.round((ms / 60_000) * 10) / 10 : null;
}

/** `data.merged_at` on any event. Absent stays null so a finish time is not treated as a merge time. */
export function mergeTimestamp(events: FactoryEvent[]): number | null {
  for (const event of events) {
    const at = event.data.merged_at;
    if (typeof at !== "string") continue;
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function lastEventTime(events: FactoryEvent[]): number | null {
  let last: number | null = null;
  for (const event of events) {
    const parsed = Date.parse(event.ts);
    if (!Number.isFinite(parsed)) continue;
    if (last === null || parsed > last) last = parsed;
  }
  return last;
}

/** Replan, retry and review counts from the event log. A missing log is the caller's empty list. */
export function roundKinds(events: FactoryEvent[]): { replan: number; retry: number; review: number } {
  let planStarts = 0;
  let replan = 0;
  let retry = 0;
  let reviewFinished = 0;
  let reviewCalls = 0;
  for (const event of events) {
    if (event.event === "model_retry" || event.event === "step_retry") retry++;
    if (event.data.kind === "replan") replan++;
    else if (event.event === "step_started" && event.step.startsWith("plan")) {
      planStarts++;
      if (planStarts > 1) replan++;
    }
    if (event.event === "round_finished" && `${event.step} ${event.role ?? ""}`.includes("review")) reviewFinished++;
    if ((event.event === "agent_finished" || event.event === "agent_error") && (event.role ?? "").startsWith("review")) reviewCalls++;
  }
  return { replan, retry, review: reviewFinished > 0 ? reviewFinished : reviewCalls };
}

/** Reason strings worth classifying. Blank reasons are left out so they are not a fake class. */
export function waitLabels(run: RunRecord, events: FactoryEvent[]): { reason: string; result?: string }[] {
  const out: { reason: string; result?: string }[] = [];
  const push = (reason: unknown, result?: string) => {
    if (typeof reason !== "string" || !reason.trim()) return;
    out.push({ reason: reason.trim().slice(0, 160), ...(result ? { result } : {}) });
  };
  push(run.state?.reason, run.state?.result ?? undefined);
  push(run.result?.reason, run.result?.result);
  if (run.result?.result === "base_red") push(run.result.reason || "base CI", "base_red");
  for (const event of events) {
    if (event.event === "queued") push("waiting for lock");
    push(event.data.reason);
    if (event.event === "agent_error" && event.data.class === "capacity") push("provider capacity");
    if (event.event === "agent_error" && (event.data.class === "network" || event.data.class === "transport")) push("provider connection error");
  }
  return out;
}
