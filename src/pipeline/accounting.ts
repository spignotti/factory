import type { FactoryEvent, StopCause } from "../events.js";
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

/** Wait class of a machine-readable stop cause. `unknown` has no class: the text fallback stays honest. */
const CLASS_BY_CAUSE: Partial<Record<StopCause, WaitClass>> = {
  technical_repair: "technical_repair",
  // Spent budgets are not a mechanical retry. A person must decide; #179 does not grant a reset.
  budget_exhausted: "human_decision",
  transient_retry: "provider",
  // Explicit usage-window reset, not a generic 429. No reset is scheduled in #179.
  provider_window_wait: "provider",
  explicit_decision: "human_decision",
  human_approval: "human_decision",
};

/** Classify one stored reason. An empty reason is unclassified and is not a zero wait. */
export function classifyWait(reason: string, result?: string, cause?: StopCause): WaitClass {
  // A stored cause is machine-readable and wins; `unknown` and legacy stops fall back to the text.
  if (cause && CLASS_BY_CAUSE[cause]) return CLASS_BY_CAUSE[cause]!;
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

/**
 * Interval-based delivery funnel (#185). Pure reporting: it counts what the stored records and a
 * GitHub reconciliation say, and keeps everything the data cannot support as `unknown` instead of
 * inventing a number. It changes no scheduling, recovery or merge behavior.
 */

/** Live PR state as the funnel sees it. A read failure is not a state: the funnel gets `null`. */
export interface FunnelPrState {
  state: "open" | "merged" | "closed";
  draft: boolean;
  ci?: "green" | "red" | "pending" | "none";
  behind?: boolean;
  conflicting?: boolean;
}

/** One deduplicated run, prepared by the caller. Absent fields stay null/unknown, never a guess. */
export interface FunnelSource {
  run_id: string;
  /**
   * Repository this issue belongs to (checkout path, as stored). Ticket and merge keys are
   * repository plus issue. Omitted means the caller has a single repository. `null` or `""`
   * is not an identity: that ticket stays unknown instead of collapsing onto another repo.
   */
  repo?: string | null;
  /** From the stored outcome: a number, null (a task with no ticket) or "unknown" (legacy). */
  ticket: number | null | "unknown";
  /** UTC ms of the first attempt this record can prove, or null when no run id supports it. */
  first_attempt: number | null;
  /** UTC ms the run finished (merge time first, then last event), null while unfinished. */
  finished: number | null;
  /** `result.json` stored `merged`. A GitHub merge alone is never `confirmed`. */
  merged_stored: "no" | "confirmed" | "unknown";
  /** Whether the stored record carries an `outcome` at all (recovery and attempt counts come from it). */
  has_outcome: boolean;
  pr: string | null;
  /** Live PR state; null when there is no PR or GitHub could not be asked. */
  pr_state: FunnelPrState | null;
  /** A PR exists but its state could not be read (partial API failure). Not merged. */
  merge_status_unknown: boolean;
  merge_policy: string | null;
  /** Still waiting on a person (needs_human / needs_input) at read time. */
  unresolved_decision: boolean;
  /** Still queued for a lock. A queued run is never a merge. */
  queued?: boolean;
  /** Stored result kind. `done` alone is not a merge. */
  result?: string | null;
  /** Stored reason, used only to classify a blocker the PR flags do not name. */
  reason?: string | null;
  /**
   * Successful automatic recoveries the caller already proved, and that occurred inside the interval.
   * A recovery on a run that later finishes in the interval is not enough.
   */
  recoveries: number;
  /**
   * Idle-slot minutes an event in this run actually recorded (`data.idle_slot_ms`).
   * Absent when the log has no such event. Lock-wait `waited_ms` is not this number.
   */
  idle_slot_minutes?: number;
}

const BLOCKER_CLASSES: Record<string, WaitClass> = {
  draft: "human_decision",
  "CI red": "ci_runner",
  "CI pending": "ci_runner",
  "CI none": "ci_runner",
  "CI missing": "ci_runner",
  behind: "technical_repair",
  conflicting: "technical_repair",
  needs_human: "human_decision",
  "pr status unknown": "unclassified",
};

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new Error(`invalid --timezone ${tz} (use an IANA zone, e.g. Europe/Berlin)`);
  }
}

/**
 * The explicit `--since` window ending at the read. Bounds are UTC instants; `timezone` names the
 * zone a cross-midnight finish is read in. The window never extends into the future.
 */
export function resolveInterval(now: number, span: number, tz: string): { from: number; to: number; timezone: string } {
  assertTimezone(tz);
  return { from: now - span, to: now, timezone: tz };
}

/**
 * Idle-slot minutes recorded on events (`data.idle_slot_ms`). No such event stays null.
 * A lock wait (`waited_ms`) is not an idle slot, and a missing sample is not zero.
 */
export function idleSlotMinutes(events: FactoryEvent[]): number | null {
  let ms = 0;
  let seen = false;
  for (const event of events) {
    const idle = event.data.idle_slot_ms;
    if (typeof idle === "number" && Number.isFinite(idle) && idle >= 0) {
      ms += idle;
      seen = true;
    }
  }
  return seen ? Math.round((ms / 60_000) * 10) / 10 : null;
}

/**
 * Automatic recoveries the log shows succeeded. A retry or fallback counts only when the next
 * agent outcome for that same role is `agent_finished`. A later finish of another role, a
 * role-less event, or a finish after an intervening error or another retry is not proof.
 * A mechanical repair counts when a later gate passes. A retry event alone is not success.
 * With `bounds`, the proving event must fall inside them: a recovery is not counted for an interval
 * merely because the run later finishes there.
 */
export function successfulRecoveries(events: FactoryEvent[], bounds?: { from: number; to: number }): number {
  const occurredIn = (event: FactoryEvent): boolean => {
    if (!bounds) return true;
    const t = Date.parse(event.ts);
    return Number.isFinite(t) && t >= bounds.from && t <= bounds.to;
  };
  let n = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const retry = event.event === "model_retry" || event.event === "step_retry" || event.event === "model_fallback";
    const repair = event.event === "progress" && typeof event.data.repair === "string";
    if (!retry && !repair) continue;
    const proved = retry
      ? event.role ? nextAgentOutcome(events, i + 1, event.role) : undefined
      : events.slice(i + 1).find((next) => next.event === "gate_result" && (next.data.status === "pass" || next.data.status === "green"));
    if (!proved || (retry && proved.event !== "agent_finished")) continue;
    if (occurredIn(proved)) n++;
  }
  return n;
}

/** Next agent outcome for `role`. Events with no role are not that outcome. */
function nextAgentOutcome(events: FactoryEvent[], from: number, role: string): FactoryEvent | undefined {
  for (let j = from; j < events.length; j++) {
    const next = events[j]!;
    if (next.role !== role) continue;
    if (
      next.event === "agent_finished" ||
      next.event === "agent_error" ||
      next.event === "model_retry" ||
      next.event === "step_retry" ||
      next.event === "model_fallback"
    ) {
      return next;
    }
  }
  return undefined;
}

function dedupeSources(sources: FunnelSource[]): FunnelSource[] {
  const byId = new Map<string, FunnelSource>();
  for (const s of sources) {
    const prev = byId.get(s.run_id);
    if (!prev || (s.finished ?? -1) >= (prev.finished ?? -1)) byId.set(s.run_id, s);
  }
  return [...byId.values()];
}

/** `undefined` is the single-repo bucket. `null` or blank is not an identity. */
function identityRepo(repo: string | null | undefined): string | null {
  if (repo === undefined) return "";
  if (repo === null) return null;
  const trimmed = repo.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Repository plus issue. Missing identity stays null so numbers do not collapse across repos. */
function ticketKey(repo: string | null | undefined, issue: number): string | null {
  const part = identityRepo(repo);
  return part === null ? null : JSON.stringify([part, issue]);
}

function sourceTicketKey(s: { repo?: string | null; ticket: number | null | "unknown" }): string | null {
  return typeof s.ticket === "number" ? ticketKey(s.repo, s.ticket) : null;
}

/** PR keys include the repository. A ticket fallback does too. A run id is the last resort. */
function mergeKeyOf(s: FunnelSource): string {
  const part = identityRepo(s.repo);
  if (s.pr && part !== null) return JSON.stringify(["pr", part, s.pr]);
  const ticket = sourceTicketKey(s);
  if (ticket) return JSON.stringify(["ticket", ticket]);
  return `run:${s.run_id}`;
}

interface OpenAttempt {
  time: number;
  run_id: string;
  ready: boolean;
  ticket: string | null;
  reasons: { reason: string; cls: WaitClass }[];
}

function observationTime(s: FunnelSource): number {
  return s.finished ?? s.first_attempt ?? Number.NEGATIVE_INFINITY;
}

/** Later finish wins. Equal time: the lexicographically greater run id wins. */
function laterAttempt(a: OpenAttempt, b: OpenAttempt): boolean {
  if (a.time !== b.time) return a.time > b.time;
  return a.run_id > b.run_id;
}

/** The funnel report. `null` numbers mean the data does not support them, never zero. */
export interface DeliveryFunnel {
  interval: { from: string; to: string; timezone: string };
  /** Null when a queue file could not be read: a partial queue is not a complete total. */
  offered_tickets: number | null;
  admitted_tickets: number;
  attempts: number;
  first_attempted_in_interval: number;
  work_first_attempted_before: number;
  /** Null when a queue file could not be read. */
  backlog_parked_before: number | null;
  unknowns: { tickets: number; first_attempts: number; merge_status: number; outcomes: number; queues: number };
  merges: { confirmed: number; github_only: number; closed_without_merge: number };
  /** A confirmed or GitHub merge does not prove the factory merged it. Never guessed. */
  factory_provenance: null;
  ready_awaiting_approval: { prs: number; tickets: number };
  blocker_prs: number;
  blockers: { reason: string; cls: WaitClass; prs: number; tickets: number }[];
  recovered_without_human: number;
  idle_slot_minutes: number | null;
}

/**
 * Aggregate the funnel. A source is in the interval when the time it can prove (finish, else first
 * attempt) falls inside `[from, to]`. Tickets and merge keys are repository plus issue, so the
 * same number in two repositories does not collapse. Merges reconcile with the observed PR state
 * and dedupe by that key. Open, queued, CI-pending and a bare `done` never merge. An unreadable
 * PR stays unknown, counted once per PR rather than once per run.
 * One open PR is never both ready and a blocker: the later attempt decides (finish time, else
 * first attempt; equal times break by run id). If it is ready, earlier blocker rows for that PR
 * are dropped. If it is not, blocker reasons are the union of the attempts that were not ready.
 * Blockers dedupe by reason; ticket and PR counts inside a reason are distinct.
 */
export function ticketFunnel(input: {
  interval: { from: number; to: number; timezone: string };
  sources: FunnelSource[];
  /** Queue entries across repos: a distinct ticket, when it was added, whether it is still open. */
  queue: { repo?: string | null; ticket: number; added: number; unfinished: boolean }[];
  /** Queue files that could not be read. Offered and parked-before then stay unknown, not a partial sum. */
  queue_unreadable?: number;
}): DeliveryFunnel {
  const { from, to } = input.interval;
  const rows = dedupeSources(input.sources);
  const inInterval = rows.filter((s) => {
    const t = s.finished ?? s.first_attempt;
    return t !== null && t >= from && t <= to;
  });

  // Earliest provable attempt per repository+issue, across ALL rows (also those outside the interval),
  // so a cross-midnight or resumed ticket is not mistaken for work started within it.
  const firstByTicket = new Map<string, number>();
  for (const s of rows) {
    const id = sourceTicketKey(s);
    if (!id || s.first_attempt === null) continue;
    const prev = firstByTicket.get(id);
    if (prev === undefined || s.first_attempt < prev) firstByTicket.set(id, s.first_attempt);
  }

  const known = new Set<string>();
  const unknownTickets = new Set<string>();
  let attempts = 0;
  let outcomeUnknown = 0;
  let recovered = 0;
  const confirmedKeys = new Set<string>();
  const githubOnlyKeys = new Set<string>();
  const closedKeys = new Set<string>();
  const mergeUnknownKeys = new Set<string>();
  const knownStatusKeys = new Set<string>();
  const readyPrs = new Set<string>();
  const readyTickets = new Set<string>();
  const blockerPrs = new Set<string>();
  const blockerRows = new Map<string, { reason: string; cls: WaitClass; prs: Set<string>; tickets: Set<string> }>();
  const openAttempts = new Map<string, OpenAttempt[]>();
  const addBlocker = (reason: string, prKey: string | null, ticket: string | null, cls?: WaitClass) => {
    const resolved = cls ?? BLOCKER_CLASSES[reason] ?? "unclassified";
    const row = blockerRows.get(reason) ?? { reason, cls: resolved, prs: new Set<string>(), tickets: new Set<string>() };
    if (prKey) {
      row.prs.add(prKey);
      blockerPrs.add(prKey);
    }
    if (ticket) row.tickets.add(ticket);
    blockerRows.set(reason, row);
  };
  const noteUnknown = (s: FunnelSource) => mergeUnknownKeys.add(mergeKeyOf(s));
  const noteKnown = (s: FunnelSource) => knownStatusKeys.add(mergeKeyOf(s));
  const recordOpen = (s: FunnelSource, ready: boolean, reasons: { reason: string; cls: WaitClass }[]) => {
    if (!s.pr) return;
    const key = mergeKeyOf(s);
    const list = openAttempts.get(key) ?? [];
    list.push({ time: observationTime(s), run_id: s.run_id, ready, ticket: sourceTicketKey(s), reasons });
    openAttempts.set(key, list);
  };
  let idleSum = 0;
  let idleSeen = false;

  for (const s of inInterval) {
    attempts++;
    const ticket = sourceTicketKey(s);
    if (ticket) known.add(ticket);
    else if (s.ticket === "unknown" || typeof s.ticket === "number") unknownTickets.add(s.run_id);
    if (!s.has_outcome) outcomeUnknown++;
    if (typeof s.idle_slot_minutes === "number") {
      idleSeen = true;
      idleSum += s.idle_slot_minutes;
    }
    if (s.recoveries > 0 && s.has_outcome && s.finished !== null && !s.unresolved_decision && !s.queued) recovered += s.recoveries;
    const reasonClass = s.reason ? classifyWait(s.reason, s.result ?? undefined) : null;
    const reasonBlocks = reasonClass === "dependency" || reasonClass === "capacity" || reasonClass === "provider";
    const reasonRow = (): { reason: string; cls: WaitClass } | null =>
      reasonBlocks && s.reason && reasonClass ? { reason: s.reason.trim().slice(0, 160), cls: reasonClass } : null;
    const blockerReasons = (): { reason: string; cls: WaitClass }[] => {
      const reasons: { reason: string; cls: WaitClass }[] = [];
      if (!s.pr_state) return reasons;
      if (s.pr_state.draft) reasons.push({ reason: "draft", cls: "human_decision" });
      const ci = s.pr_state.ci;
      if (ci === "red") reasons.push({ reason: "CI red", cls: "ci_runner" });
      else if (ci === "pending") reasons.push({ reason: "CI pending", cls: "ci_runner" });
      else if (ci === "none") reasons.push({ reason: "CI none", cls: "ci_runner" });
      else if (ci === undefined) reasons.push({ reason: "CI missing", cls: "ci_runner" });
      if (s.pr_state.behind) reasons.push({ reason: "behind", cls: "technical_repair" });
      if (s.pr_state.conflicting) reasons.push({ reason: "conflicting", cls: "technical_repair" });
      if (s.unresolved_decision) reasons.push({ reason: "needs_human", cls: "human_decision" });
      const extra = reasonRow();
      if (extra) reasons.push(extra);
      return reasons;
    };
    const applyLoose = (reason: string, cls: WaitClass) => {
      if (s.pr) recordOpen(s, false, [{ reason, cls }]);
      else addBlocker(reason, null, ticket, cls);
    };
    // Open, queued, CI-pending, or a result of `done` without a reconciled merge is not a merge.
    if (s.queued || s.pr_state?.ci === "pending") {
      if (s.pr_state?.state === "merged" || (s.queued && s.merged_stored === "confirmed")) {
        noteUnknown(s);
        continue;
      }
    }
    if (s.pr && s.pr_state === null) {
      if (s.merge_status_unknown) {
        noteUnknown(s);
        const reasons: { reason: string; cls: WaitClass }[] = [{ reason: "pr status unknown", cls: "unclassified" }];
        const extra = reasonRow();
        if (extra) reasons.push(extra);
        recordOpen(s, false, reasons);
      } else {
        const extra = reasonRow();
        if (extra) applyLoose(extra.reason, extra.cls);
      }
      continue;
    }
    if (s.pr_state) {
      const observed = observeMerge({ stored: s.merged_stored, github: s.pr_state.state });
      const key = mergeKeyOf(s);
      if (observed.presentation === "actually_merged") {
        confirmedKeys.add(key);
        noteKnown(s);
      } else if (observed.presentation === "unknown_origin") {
        githubOnlyKeys.add(key);
        noteKnown(s);
      } else if (observed.presentation === "closed_without_merge") {
        closedKeys.add(key);
        noteKnown(s);
      } else if (observed.presentation === "unmerged") {
        noteKnown(s);
        const ready =
          !reasonBlocks &&
          s.merge_policy === "human_review" &&
          !s.pr_state.draft &&
          s.pr_state.ci === "green" &&
          !s.pr_state.behind &&
          !s.pr_state.conflicting &&
          !s.unresolved_decision;
        if (s.pr) recordOpen(s, ready, ready ? [] : blockerReasons());
        else if (ready) {
          readyPrs.add(s.run_id);
          if (ticket) readyTickets.add(ticket);
        } else {
          for (const row of blockerReasons()) addBlocker(row.reason, null, ticket, row.cls);
        }
      }
    } else if (s.unresolved_decision) {
      applyLoose("needs_human", "human_decision");
      const extra = reasonRow();
      if (extra && extra.reason !== "needs_human") applyLoose(extra.reason, extra.cls);
    } else {
      const extra = reasonRow();
      if (extra) applyLoose(extra.reason, extra.cls);
    }
  }
  for (const key of confirmedKeys) {
    githubOnlyKeys.delete(key);
    closedKeys.delete(key);
  }
  for (const key of knownStatusKeys) mergeUnknownKeys.delete(key);
  // A merged or closed PR is not also ready or blocking. Otherwise the later open attempt wins,
  // and a ready winner drops every blocker row for that PR.
  for (const [key, attemptsForPr] of openAttempts) {
    if (confirmedKeys.has(key) || githubOnlyKeys.has(key) || closedKeys.has(key)) continue;
    const winner = attemptsForPr.reduce((best, next) => (laterAttempt(next, best) ? next : best));
    if (winner.ready) {
      readyPrs.add(key);
      if (winner.ticket) readyTickets.add(winner.ticket);
      continue;
    }
    for (const attempt of attemptsForPr) {
      if (attempt.ready) continue;
      for (const row of attempt.reasons) addBlocker(row.reason, key, attempt.ticket, row.cls);
    }
  }

  // A ticket is counted where its earliest provable attempt sits: inside the interval or before it.
  // A known ticket without any provable start time stays unknown, never silently in or out.
  let firstIn = 0;
  let before = 0;
  let firstUnknown = 0;
  for (const id of known) {
    const first = firstByTicket.get(id);
    if (first === undefined) firstUnknown++;
    else if (first >= from && first <= to) firstIn++;
    else before++;
  }

  const offered = new Set<string>(known);
  const queueBefore = new Set<string>();
  for (const q of input.queue) {
    const id = ticketKey(q.repo, q.ticket);
    if (!id) continue;
    if (q.added >= from && q.added <= to) offered.add(id);
    // Parked before the interval, and not a first attempt inside it. The two buckets stay separate.
    if (q.added < from && q.unfinished) {
      const first = firstByTicket.get(id);
      if (first === undefined || first < from || first > to) queueBefore.add(id);
    }
  }

  const queueUnreadable = input.queue_unreadable ?? 0;
  return {
    interval: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: input.interval.timezone },
    offered_tickets: queueUnreadable > 0 ? null : offered.size,
    admitted_tickets: known.size,
    attempts,
    first_attempted_in_interval: firstIn,
    work_first_attempted_before: before,
    backlog_parked_before: queueUnreadable > 0 ? null : queueBefore.size,
    unknowns: { tickets: unknownTickets.size, first_attempts: firstUnknown, merge_status: mergeUnknownKeys.size, outcomes: outcomeUnknown, queues: queueUnreadable },
    merges: { confirmed: confirmedKeys.size, github_only: githubOnlyKeys.size, closed_without_merge: closedKeys.size },
    factory_provenance: null,
    ready_awaiting_approval: { prs: readyPrs.size, tickets: readyTickets.size },
    blocker_prs: blockerPrs.size,
    blockers: [...blockerRows.values()]
      .sort((a, b) => a.reason.localeCompare(b.reason))
      .map((row) => ({ reason: row.reason, cls: row.cls, prs: row.prs.size, tickets: row.tickets.size })),
    recovered_without_human: recovered,
    idle_slot_minutes: idleSeen ? Math.round(idleSum * 10) / 10 : null,
  };
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

/**
 * A resume that deleted `result.json` and now owns the run. Events before the latest such marker
 * belong to an earlier attempt. A locked resume (`base_red_resume: "locked"`, draft notes) does not.
 */
function startsCurrentAttempt(event: FactoryEvent): boolean {
  if (event.step !== "resume") return false;
  if (event.event === "progress") {
    const recovery = event.data.recovery;
    return recovery !== null && typeof recovery === "object";
  }
  if (event.event !== "step_started") return false;
  return event.data.base_red_resume === true || "previous_result" in event.data;
}

/** Events of the attempt that currently owns the run. No resume marker: the whole log is that attempt. */
export function currentAttemptEvents(events: FactoryEvent[]): FactoryEvent[] {
  let start = 0;
  for (let i = 0; i < events.length; i++) if (startsCurrentAttempt(events[i]!)) start = i;
  return events.slice(start);
}

/**
 * Finish instant of the current attempt. A previous attempt's `run_finished` or `merged_at` is not
 * this finish. No `result.json` and no `run_finished` on this attempt stays null: the last event of
 * an unfinished attempt is not a finish time.
 */
export function attemptFinishMs(events: FactoryEvent[], hasResult: boolean): number | null {
  const attempt = currentAttemptEvents(events);
  if (!hasResult && !attempt.some((event) => event.event === "run_finished")) return null;
  return mergeTimestamp(attempt) ?? lastEventTime(attempt);
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
