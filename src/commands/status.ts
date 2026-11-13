import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub, PrStatus } from "../gh.js";
import { assertTimezone, attemptFinishMs, classifyWait, dedupeRuns, idleSlotMinutes, observeMerge, resolveInterval, successfulRecoveries, ticketFunnel, type DeliveryFunnel, type FunnelPrState, type FunnelSource, type WaitClass } from "../pipeline/accounting.js";
import { readOutcome, stopCauseOf } from "../pipeline/outcome.js";
import { MAX_CONTINUATIONS, MAX_GATE_ATTEMPTS } from "../pipeline/recovery.js";
import { coverageOfRepo } from "../standards.js";
import { activeHolders } from "../pipeline/lock.js";
import { branchesHeldByLiveRuns, daysUnchanged, isStaleDraft, staleDraftDaysAt } from "../pipeline/path-claim.js";
import { openAuditTickets } from "../proposals.js";
import { loadRepoConfig } from "../schemas/repo.js";
import type { FactoryEvent, StopCause } from "../events.js";
import { listRuns, runStartedAt, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";
import type { z } from "zod";
import type { StatusReportSchema } from "../schemas/reports.js";
import { loadReadableQueues } from "../queue/store.js";
import { currentCheckName, currentStepRetry, eventsForRun, isQueuedWaiter, lastEventMs, orphanedRunIds, queuedFromEvents } from "../run-health.js";
import { summarizeQueues } from "../queue/store.js";
import { parseSince } from "./stats.js";

/** `factory status --json` (schema `schemas/status.schema.json`). */
export type StatusReport = z.infer<typeof StatusReportSchema>;

const repoOf = (r: RunRecord) => r.state?.repo ?? r.result?.repo ?? "";
const taskOf = (r: RunRecord) => r.state?.task.ref ?? r.result?.task ?? "";

const RISK = new Set(["low", "medium", "high"]);
const DIFF_REASON = /^diff \d+ lines > \d+$/;

/** Bucket a `riskClass` reason. The review-exit `reason` is not a risk cause. */
function riskCause(reason: string): "diff size" | "protected paths" | "risk" {
  if (DIFF_REASON.test(reason) || /\bdiff size\b|max_diff_lines/i.test(reason)) return "diff size";
  if (/human_only_paths|protected/i.test(reason)) return "protected paths";
  return "risk";
}

/**
 * Why a done `human_review` PR is not auto-merged, from `result.json` `risk_reasons` only.
 * Labels are `risk`, `diff size`, `protected paths`; the `riskClass` strings follow so a medium
 * rating is not collapsed to `risk`. A low rating with no reasons is the policy, not the review exit.
 */
function humanReviewReasons(input: { risk_reasons?: string[]; risk?: string | null }): string[] {
  const reasons = input.risk_reasons ?? [];
  const causes = new Set(reasons.map(riskCause));
  const out: string[] = [];
  if (causes.has("risk") || ((input.risk === "medium" || input.risk === "high") && reasons.length === 0)) out.push("risk");
  if (causes.has("diff size")) out.push("diff size");
  if (causes.has("protected paths")) out.push("protected paths");
  if (!out.length) out.push("human_review");
  return [...out, ...reasons];
}

/**
 * Machine-readable recovery explanation for a stopped run: which bounded budgets are already
 * spent, so `status` says when recovery is exhausted instead of leaving the reason text alone.
 * Only the persisted stop cause and the persisted budget numbers are read, never free-text matching.
 */
function recoveryNote(st: { stop?: unknown; repair?: { gate_attempts?: number } | null; continuation_attempts?: number | null }): string {
  const cause = stopCauseOf(st.stop);
  if (!cause) return "";
  const spent: string[] = [];
  const cont = st.continuation_attempts ?? 0;
  if (cont >= MAX_CONTINUATIONS) spent.push(`post-push repair ${cont}/${MAX_CONTINUATIONS}`);
  const gates = st.repair?.gate_attempts ?? 0;
  if (gates >= MAX_GATE_ATTEMPTS) spent.push(`gate repair ${gates}/${MAX_GATE_ATTEMPTS}`);
  if (cause === "budget_exhausted") {
    if (!spent.length) spent.push("wall-time or attempt budget");
    return `; budgets spent (${spent.join(", ")}); not reset, explicit grant required`;
  }
  return spent.length ? `; recovery exhausted: ${spent.join(", ")}` : "";
}

function resultFinishedMs(run: RunRecord): number | undefined {
  if (!run.result) return undefined;
  try {
    return statSync(join(run.dir, "result.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

function blockersOf(result: string, live: PrStatus | undefined, prError: string | undefined): string[] {
  const out: string[] = [];
  if (live?.draft) out.push("draft");
  if (live?.ci === "red") out.push("CI red");
  if (live?.ci === "pending") out.push("CI pending");
  // `none` and a rollup that was not read are not green: an empty check list must not land in human_review.
  if (live && live.ci !== "green" && live.ci !== "red" && live.ci !== "pending") out.push(live.ci === "none" ? "CI none" : "CI missing");
  if (live?.behind) out.push("behind");
  if (live?.conflicting) out.push("conflicting");
  if (result === "needs_human") out.push("needs_human");
  if (prError) out.push("pr status unknown");
  return out;
}

/**
 * Finished-window summary. Reads `result.json` (mtime is when the run finished) and live PR state.
 * Does not read `events.jsonl`: that file is the trace, not this view.
 */
async function sinceFinished(
  runs: RunRecord[],
  opts: {
    since: string;
    now: number;
    skip: Set<string>;
    loadPr: (repo: string, pr: string) => Promise<PrStatus | Error>;
  },
): Promise<NonNullable<StatusReport["since"]>> {
  const span = parseSince(opts.since);
  const from = opts.now - span;
  const view: NonNullable<StatusReport["since"]> = {
    since: opts.since,
    from: new Date(from).toISOString(),
    merged: [],
    human_review: [],
    blocked: [],
    failed: [],
    base_red: [],
    needs_input: [],
    funnel: null,
  };
  const recent = runs.filter((r) => {
    if (opts.skip.has(r.run_id)) return false;
    const finished = resultFinishedMs(r);
    return finished !== undefined && finished >= from;
  });
  recent.sort((a, b) => b.run_id.localeCompare(a.run_id));
  for (const r of recent) {
    const res = r.result!;
    const kind = res.result;
    if (typeof kind !== "string") continue;
    const row = { run_id: r.run_id, repo: res.repo ?? "", task: res.task ?? "" };
    const reason = res.reason ?? "";
    if (kind === "failed") {
      view.failed.push({ ...row, reason, pr: res.pr ?? null });
      continue;
    }
    if (kind === "base_red") {
      view.base_red.push({ ...row, reason });
      continue;
    }
    if (kind === "needs_input") {
      view.needs_input.push({ ...row, reason, questions: res.questions ?? [] });
      continue;
    }
    if (kind !== "done" && kind !== "needs_human") continue;
    let live: PrStatus | undefined;
    let prError: string | undefined;
    if (res.pr) {
      const got = await opts.loadPr(res.repo ?? "", res.pr);
      if (got instanceof Error) prError = got.message.slice(0, 200);
      else live = got;
    }
    // A thrown prStatus is not proof the PR is still open (it may already be merged).
    // Closed without merge stays in this list with pr_state closed. A GitHub merge is not autonomous
    // unless the stored outcome says confirmed. The same login is not consulted.
    if (live && live.state !== "open" && res.pr) {
      const observed = observeMerge({ stored: readOutcome(res).merged, github: live.state });
      if (live.state === "closed" || observed.presentation === "closed_without_merge") {
        view.merged.push({ ...row, pr: res.pr, pr_state: "closed", result: kind });
      } else {
        view.merged.push({ ...row, pr: res.pr, pr_state: "merged", result: kind, origin: observed.autonomous ? "confirmed" : "unknown" });
      }
      continue;
    }
    const blockers = blockersOf(kind, live, prError);
    if (blockers.length && (res.pr || kind === "needs_human")) {
      view.blocked.push({ ...row, pr: res.pr ?? null, blockers, reason, ...(prError ? { error: prError } : {}) });
      continue;
    }
    if (live?.state === "open" && res.pr && kind === "done" && res.merge_policy === "human_review" && live.ci === "green" && !live.behind && !live.conflicting) {
      const risk = res.risk && RISK.has(res.risk) ? res.risk : null;
      view.human_review.push({ ...row, pr: res.pr, risk, review_reasons: humanReviewReasons({ risk_reasons: res.risk_reasons, risk: res.risk }) });
    }
  }
  return view;
}

/**
 * Queued before `waiter_pid` was stored, and the lock was never recorded as acquired.
 * `isQueuedWaiter` ignores that shape once state or result exists. The funnel must not then
 * treat a GitHub merge as this run's merge. A later agent call or finish means the run left
 * the queue. Status's queued list is unchanged.
 */
function legacyQueuedRun(events: FactoryEvent[]): boolean {
  const q = events.findLastIndex((e) => e.event === "queued");
  if (q < 0) return false;
  if (typeof events[q]!.data.waiter_pid === "number") return false;
  const later = events.slice(q + 1);
  if (later.some((e) => e.event === "progress" && e.data.lock_acquired !== undefined)) return false;
  // A later agent call, retry or finish means the run left the queue, even when lock_acquired was not logged.
  const left = new Set(["agent_finished", "agent_error", "step_started", "run_finished", "gate_result", "step_retry", "model_retry", "model_fallback"]);
  return !later.some((e) => left.has(e.event));
}

/**
 * The interval funnel for `status --since`: distinct offered/admitted tickets, deduplicated
 * attempts, merges reconciled with GitHub, ready PRs, remaining blockers and idle-slot time.
 * Everything the records cannot prove stays unknown (#185). No scheduling or merge behavior changes.
 */
async function buildFunnel(
  runs: RunRecord[],
  opts: { since: string; now: number; timezone: string; factoryHome: string; loadPr: (repo: string, pr: string) => Promise<PrStatus | Error> },
): Promise<DeliveryFunnel> {
  const span = parseSince(opts.since);
  const interval = resolveInterval(opts.now, span, opts.timezone);
  const sources: FunnelSource[] = [];
  for (const r of dedupeRuns(runs)) {
    const res = r.result;
    const st = r.state;
    if (!res && !st) continue;
    const outcome = readOutcome(res);
    const events = eventsForRun(r);
    const pr = res?.pr ?? st?.pr ?? null;
    let prState: FunnelPrState | null = null;
    let prUnknown = false;
    if (pr) {
      const got = await opts.loadPr(res?.repo ?? st?.repo ?? "", pr);
      if (got instanceof Error) prUnknown = true;
      else prState = { state: got.state, draft: got.draft, ci: got.ci, behind: got.behind, conflicting: got.conflicting };
    }
    const resultKind = res?.result ?? st?.result ?? null;
    const queued = isQueuedWaiter(r, events) || legacyQueuedRun(events);
    const idle = idleSlotMinutes(events.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= interval.from && t <= interval.to;
    }));
    // Finish and merge instants belong to the attempt that owns the run. A historical
    // run_finished is not the finish of a later resume whose result.json is still absent.
    // An unfinished attempt has no finish time: its last event must not pull it into the interval.
    const finished = attemptFinishMs(events, res !== undefined);
    sources.push({
      run_id: r.run_id,
      repo: res?.repo ?? st?.repo ?? null,
      ticket: outcome.ticket,
      first_attempt: runStartedAt(r.run_id)?.getTime() ?? null,
      finished,
      merged_stored: outcome.merged,
      has_outcome: res?.outcome !== undefined,
      pr,
      pr_state: prState,
      merge_status_unknown: prUnknown,
      merge_policy: res?.merge_policy ?? null,
      unresolved_decision: resultKind === "needs_human" || resultKind === "needs_input",
      queued,
      result: resultKind,
      reason: res?.reason || st?.reason || null,
      recoveries: successfulRecoveries(events, interval),
      ...(idle !== null ? { idle_slot_minutes: idle } : {}),
    });
  }
  const queue: { repo: string; ticket: number; added: number; unfinished: boolean }[] = [];
  const readable = loadReadableQueues(opts.factoryHome);
  for (const q of readable.queues) {
    for (const entry of q.entries) {
      const added = Date.parse(entry.added_at);
      if (!Number.isFinite(added)) continue;
      queue.push({ repo: q.repo, ticket: entry.issue, added, unfinished: entry.status !== "done" });
    }
  }
  return ticketFunnel({ interval, sources, queue, queue_unreadable: readable.unreadable });
}

export async function statusReport(opts: { factoryHome: string; github: GitHub; since?: string; timezone?: string; now?: () => number }): Promise<StatusReport> {
  const now = opts.now?.() ?? Date.now();
  const timezone = opts.timezone ?? "UTC";
  assertTimezone(timezone);
  const holders = new Map(activeHolders(opts.factoryHome).filter((h) => h.runId).map((h) => [h.runId!, h.pid]));
  const orphanedIds = orphanedRunIds(opts.factoryHome);
  const report: StatusReport = {
    generated_at: new Date(now).toISOString(),
    running: [],
    queued: [],
    waiting: [],
    interrupted: [],
    orphaned: [],
    stalled: [],
    prs: [],
    stale_drafts: [],
    audit_tickets: openAuditTickets(opts.factoryHome),
    queues: summarizeQueues(opts.factoryHome),
    since: null,
    brief: { running: [], waiting_on: [], actually_merged: [], closed_without_merge: [], needs_silas: [], artifacts: [] },
    automation: [],
  };
  const mergedLive = new Map<string, { run_id: string; pr: string; origin: "confirmed" | "unknown" }>();
  const closedLive = new Map<string, { run_id: string; pr: string }>();
  // Stored causes of the current attempts, for brief classification (never the reason text).
  const stopCauses = new Map<string, StopCause>();
  const prCache = new Map<string, Promise<PrStatus | Error>>();
  const loadPr = (repo: string, pr: string) => {
    if (!prCache.has(pr)) prCache.set(pr, opts.github.prStatus(repo, pr).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
    return prCache.get(pr)!;
  };

  const runs = listRuns(opts.factoryHome);
  for (const r of runs) {
    const events = eventsForRun(r);
    // A current lock holder is running, even if an earlier `queued` (e.g. path overlap) has no
    // matching lock_acquired event.
    if (!holders.has(r.run_id) && isQueuedWaiter(r, events)) {
      const q = queuedFromEvents(events);
      const lockRepo = events.findLast((e) => e.event === "queued")?.data.repo;
      report.queued.push({
        run_id: r.run_id,
        repo: typeof lockRepo === "string" ? lockRepo : repoOf(r),
        task: taskOf(r) || r.result?.task || "",
        holder_run_id: q.holder_run_id,
        holder_pid: q.holder_pid,
        minutes: Math.round(((now - r.started_at.getTime()) / 60_000) * 10) / 10,
      });
      continue;
    }

    const st = r.state;
    if (!st) continue;
    const pid = holders.get(r.run_id);
    if (pid !== undefined) {
      const entry = {
        run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step, lane: st.lane ?? "standard", pid,
        minutes: Math.round(((now - r.started_at.getTime()) / 60_000) * 10) / 10, branch: st.branch, pr: st.pr,
        check: currentCheckName(events),
        retry: currentStepRetry(events),
      };
      report.running.push(entry);
      try {
        const stallMin = loadRepoConfig(st.repo).limits.stall_minutes;
        const lastMs = lastEventMs(events);
        if (lastMs !== undefined && now - lastMs > 2 * stallMin * 60_000) {
          report.stalled.push({ ...entry, silent_minutes: Math.round(((now - lastMs) / 60_000) * 10) / 10 });
        }
      } catch {
        // repo config unreadable: stall not determinable
      }
      continue;
    }
    if (st.result === null && st.step !== "finished") {
      const row = { run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step };
      if (orphanedIds.has(r.run_id)) report.orphaned.push(row);
      else report.interrupted.push(row);
      continue;
    }
    let pr: PrStatus | Error | undefined;
    if (st.pr && !st.gc_at) pr = await loadPr(repoOf(r), st.pr);
    const closed = pr && !(pr instanceof Error) && pr.state !== "open";
    if (st.pr && pr && !(pr instanceof Error) && pr.state !== "open") {
      const observed = observeMerge({ stored: readOutcome(r.result).merged, github: pr.state });
      if (observed.presentation === "closed_without_merge") closedLive.set(r.run_id, { run_id: r.run_id, pr: st.pr });
      else if (observed.presentation === "actually_merged" || observed.presentation === "unknown_origin") {
        mergedLive.set(r.run_id, { run_id: r.run_id, pr: st.pr, origin: observed.autonomous ? "confirmed" : "unknown" });
      }
    }
    if ((st.result === "needs_human" || st.result === "needs_input") && !closed && !st.gc_at) {
      const cause = stopCauseOf(st.stop);
      if (cause) stopCauses.set(r.run_id, cause);
      report.waiting.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), result: st.result, reason: st.reason + recoveryNote(st),
        questions: r.result?.questions ?? [], pr: st.pr, branch: st.branch, worktree: st.worktree,
      });
    }
    if (st.pr && pr && !closed) {
      report.prs.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), pr: st.pr,
        state: pr instanceof Error ? "unknown" : "open", draft: pr instanceof Error ? null : pr.draft,
        merge_policy: r.result?.merge_policy ?? null, risk: r.result?.risk ?? null, result: st.result,
        ...(pr instanceof Error ? { error: pr.message.slice(0, 200) } : {}),
      });
    }
  }
  if (opts.since) {
    const skip = new Set([...report.running, ...report.queued, ...report.interrupted, ...report.orphaned, ...report.stalled].map((r) => r.run_id));
    report.since = await sinceFinished(runs, { since: opts.since, now, skip, loadPr });
    report.since.funnel = await buildFunnel(runs, { since: opts.since, now, timezone, factoryHome: opts.factoryHome, loadPr });
  }
  const repos = new Set<string>([...runs.map(repoOf), ...report.queues.map((q) => q.repo)].filter((r) => r.length > 0));
  const heldByRepo = branchesHeldByLiveRuns(opts.factoryHome);
  for (const repo of [...repos].sort()) {
    let open;
    try {
      open = await opts.github.openFactoryPrFiles(repo);
    } catch {
      continue;
    }
    const days = staleDraftDaysAt(repo);
    const held = heldByRepo.get(resolve(repo));
    for (const pr of open) {
      if (!isStaleDraft(pr, days, now, held) || !pr.headChangedAt) continue;
      report.stale_drafts.push({ repo, pr: pr.number, branch: pr.branch, days_unchanged: daysUnchanged(pr.headChangedAt, now) });
    }
  }
  report.stale_drafts.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
  for (const repo of [...repos].sort()) {
    try {
      const coverage = coverageOfRepo(repo);
      if (coverage) report.automation.push({ repo, ...coverage });
    } catch {
      // unreadable standards stay unknown rather than a zero
    }
  }
  report.brief = buildBrief(report, runs, mergedLive, closedLive, stopCauses);
  return report;
}

function artifactLine(run: RunRecord): string {
  const parts = [`${run.dir}/result.json`];
  if (existsSync(join(run.dir, "recovery.json"))) parts.push(`${run.dir}/recovery.json`);
  const provenance = run.result?.provenance;
  if (provenance) parts.push(`provenance ${provenance.factory_version} prompt ${provenance.prompt_revision} effort ${provenance.effort}`);
  return parts.join("; ");
}

function buildBrief(
  report: StatusReport,
  runs: RunRecord[],
  mergedLive: Map<string, { run_id: string; pr: string; origin: "confirmed" | "unknown" }>,
  closedLive: Map<string, { run_id: string; pr: string }>,
  stopCauses: Map<string, StopCause>,
): StatusReport["brief"] {
  const links = new Map(runs.map((run) => [run.run_id, artifactLine(run)]));
  const link = (id: string) => links.get(id) ?? id;
  const actually = new Map(mergedLive);
  const closed = new Map(closedLive);
  for (const row of report.since?.merged ?? []) {
    if (row.pr_state === "closed") {
      closed.set(row.run_id, { run_id: row.run_id, pr: row.pr });
      actually.delete(row.run_id);
    } else {
      actually.set(row.run_id, { run_id: row.run_id, pr: row.pr, origin: row.origin ?? "unknown" });
    }
  }
  const waiting_on: StatusReport["brief"]["waiting_on"] = [];
  const seen = new Set<string>();
  const addWait = (cls: WaitClass, detail: string, artifact: string) => {
    const key = `${cls}\n${detail}\n${artifact}`;
    if (seen.has(key)) return;
    seen.add(key);
    waiting_on.push({ class: cls, detail, artifact });
  };
  for (const row of report.queued) addWait("capacity", "waiting for lock", link(row.run_id));
  for (const row of report.stalled) addWait("unclassified", `no event for ${row.silent_minutes} min`, link(row.run_id));
  for (const row of report.waiting) addWait(classifyWait(row.reason, row.result, stopCauses.get(row.run_id)), row.reason || row.result, link(row.run_id));
  for (const queue of report.queues) {
    for (const next of queue.next) {
      if (!next.reason) continue;
      addWait(classifyWait(next.reason), next.reason, `queue ${queue.repo} #${next.issue}`);
    }
  }
  for (const row of report.since?.blocked ?? []) {
    for (const blocker of row.blockers) addWait(classifyWait(blocker, blocker === "needs_human" ? "needs_human" : undefined), blocker, row.pr ?? link(row.run_id));
  }
  for (const row of report.since?.base_red ?? []) addWait("ci_runner", row.reason || "base CI", link(row.run_id));
  const needs = new Map<string, { run_id: string; reason: string; artifact: string }>();
  const addNeed = (run_id: string, reason: string, artifact: string) => {
    if (!needs.has(run_id)) needs.set(run_id, { run_id, reason, artifact });
  };
  for (const row of report.waiting) addNeed(row.run_id, row.reason || row.result, link(row.run_id));
  for (const row of report.since?.human_review ?? []) addNeed(row.run_id, row.review_reasons.join(", ") || "human_review", link(row.run_id));
  for (const row of report.since?.needs_input ?? []) addNeed(row.run_id, row.reason || "needs_input", link(row.run_id));
  for (const queue of report.queues) {
    for (const next of queue.next) {
      if (!next.reason || classifyWait(next.reason) !== "human_decision") continue;
      addNeed(`queue#${next.issue}`, next.reason, `queue ${queue.repo} #${next.issue}`);
    }
  }
  const artifacts = [
    ...new Set(
      [...actually.keys(), ...closed.keys(), ...report.running.map((row) => row.run_id), ...report.waiting.map((row) => row.run_id)]
        .map((id) => links.get(id))
        .filter((item): item is string => item !== undefined),
    ),
  ];
  if (!artifacts.length) artifacts.push("result.json, recovery.json and provenance on each run; factory status --since for merges");
  return {
    running: report.running.map((row) => `${row.run_id} ${row.step} — ${link(row.run_id)}`),
    waiting_on,
    actually_merged: [...actually.values()],
    closed_without_merge: [...closed.values()],
    needs_silas: [...needs.values()],
    artifacts,
  };
}

function retryNote(retry: StatusReport["running"][number]["retry"]): string {
  if (!retry) return "";
  const pkg = retry.package ? ` ${retry.package}` : "";
  return ` [${retry.class} retry ${retry.attempt}/${retry.max}${pkg}]`;
}

function reviewText(reasons: string[], risk: string | null): string {
  return reasons.map((r) => (r === "risk" && risk ? `risk ${risk}` : r)).join(", ");
}

function renderBrief(s: StatusReport): string[] {
  const running = s.brief.running.length ? s.brief.running.join("; ") : "none";
  const waiting = s.brief.waiting_on.length ? s.brief.waiting_on.map((row) => `${row.class}: ${row.detail} (${row.artifact})`).join("; ") : "none";
  const merged = s.brief.actually_merged.length
    ? s.brief.actually_merged.map((row) => `${row.run_id} ${row.pr} (${row.origin === "confirmed" ? "autonomous merge" : "origin unknown"})`).join("; ")
    : "none";
  const closed = s.brief.closed_without_merge.length ? s.brief.closed_without_merge.map((row) => `${row.run_id} ${row.pr}`).join("; ") : "none";
  const silas = s.brief.needs_silas.length ? s.brief.needs_silas.map((row) => `${row.run_id} ${row.reason} — ${row.artifact}`).join("; ") : "none";
  const automation = s.automation.length
    ? s.automation.map((row) => `${row.repo} full ${row.full.length}, partial ${row.partial.length}, review scope ${row.review_scope.length}`).join("; ")
    : "no standards file (coverage is not zero and not a check-count quotient)";
  return [
    `running: ${running}`,
    `waiting on: ${waiting}`,
    `actually merged: ${merged}`,
    `closed without merge: ${closed}`,
    `needs Silas: ${silas}`,
    `artifacts: ${s.brief.artifacts.join("; ")}`,
    `automation: ${automation}`,
  ];
}

export function renderStatus(s: StatusReport): string {
  const out: string[] = [...renderBrief(s), ""];
  const section = (title: string, lines: string[]) => out.push(`${title} (${lines.length})${lines.length ? `:\n${lines.map((l) => `  ${l}`).join("\n")}` : ""}`);
  section("running", s.running.map((r) => `${r.run_id} ${r.task} — ${r.step}${r.check ? ` (${r.check})` : ""}${retryNote(r.retry)}, ${r.lane}, ${r.minutes} min (${r.repo})`));
  section("queues", s.queues.map((q) => {
    const next = q.next.map((n) => {
      const extra = n.status === "running" && n.run_id ? ` ${n.run_id}` : n.reason ? ` ${n.reason}` : "";
      return `#${n.issue} ${n.status}${extra}`;
    }).join(", ");
    return `${q.repo} — pending ${q.pending}, running ${q.running}, parked ${q.parked}${next ? `; next ${next}` : ""}`;
  }));
  section("queued", s.queued.map((r) => `${r.run_id} ${r.task} — waiting for lock (holder ${r.holder_run_id ?? "?"}), ${r.minutes} min (${r.repo})`));
  section("stalled", s.stalled.map((r) => `${r.run_id} ${r.task} — no event for ${r.silent_minutes} min, still in ${r.step}${r.check ? ` (${r.check})` : ""}${retryNote(r.retry)} (${r.repo})`));
  section("waiting", s.waiting.map((r) => `${r.run_id} ${r.task} — ${r.result}: ${r.reason}${r.pr ? ` ${r.pr}` : ""}`));
  section("orphaned", s.orphaned.map((r) => `${r.run_id} ${r.task} — lock holder gone in ${r.step}; factory resume ${r.run_id} or factory status`));
  section("interrupted", s.interrupted.map((r) => `${r.run_id} ${r.task} — stopped in ${r.step}; factory resume ${r.run_id}`));
  section("open PRs", s.prs.map((p) => `${p.pr} ${p.task} — ${p.state}${p.draft ? ", draft" : ""}, merge policy ${p.merge_policy ?? "?"}, risk ${p.risk ?? "?"}`));
  section("stale drafts", s.stale_drafts.map((p) => `#${p.pr} ${p.branch} — unchanged for ${p.days_unchanged} days; close the PR or resume the run (${p.repo})`));
  section("open audit tickets", s.audit_tickets.map((t) => `${t.repo} [${t.type}] ${t.id} — ${t.goal} (${t.plan_path})`));
  if (s.since) {
    const fin = s.since;
    out.push(`since ${fin.since}:`);
    section("merged", fin.merged.map((r) => `${r.run_id} ${r.task} — ${r.pr_state} ${r.pr}`));
    section("open, green, human_review", fin.human_review.map((r) => `${r.run_id} ${r.task} — ${reviewText(r.review_reasons, r.risk)} ${r.pr}`));
    const unknownPr = fin.blocked.filter((r) => r.blockers.includes("pr status unknown"));
    const openBlocked = fin.blocked.filter((r) => !r.blockers.includes("pr status unknown"));
    section("open, blocked", openBlocked.map((r) => {
      const why = r.blockers.join(", ");
      const reason = r.blockers.includes("needs_human") && r.reason ? `: ${r.reason}` : "";
      return `${r.run_id} ${r.task} — ${why}${reason}${r.pr ? ` ${r.pr}` : ""}`;
    }));
    if (unknownPr.length) {
      section("pr status unknown", unknownPr.map((r) => {
        const human = r.blockers.includes("needs_human") && r.reason ? `; needs_human: ${r.reason}` : "";
        return `${r.run_id} ${r.task} — ${r.error ?? "pr status unknown"}${human}${r.pr ? ` ${r.pr}` : ""}`;
      }));
    }
    section("failed", fin.failed.map((r) => `${r.run_id} ${r.task} — ${r.reason}`));
    section("base_red", fin.base_red.map((r) => `${r.run_id} ${r.task} — ${r.reason}`));
    section("needs_input", fin.needs_input.map((r) => `${r.run_id} ${r.task} — ${r.reason}${r.questions.length ? ` (${r.questions.join("; ")})` : ""}`));
    const fn = fin.funnel;
    if (fn) {
      out.push(`funnel ${fn.interval.from} .. ${fn.interval.to} (${fn.interval.timezone}):`);
      const shown = (n: number | null) => (n === null ? "unknown" : String(n));
      out.push(
        `  offered ${shown(fn.offered_tickets)}, admitted ${fn.admitted_tickets}, attempts ${fn.attempts}, first attempted in interval ${fn.first_attempted_in_interval}, started before ${fn.work_first_attempted_before}, parked backlog before interval ${shown(fn.backlog_parked_before)}`,
      );
      out.push(`  merged ${fn.merges.confirmed} confirmed (provenance unknown; GitHub merged without stored confirmation ${fn.merges.github_only}; closed without merge ${fn.merges.closed_without_merge})`);
      out.push(`  ready awaiting approval ${fn.ready_awaiting_approval.prs} PR (${fn.ready_awaiting_approval.tickets} tickets); blocking PR ${fn.blocker_prs}: ${fn.blockers.length ? fn.blockers.map((b) => `${b.reason} (${b.cls}, ${b.tickets} tickets, ${b.prs} PR)`).join("; ") : "none"}`);
      out.push(`  recovered without human ${fn.recovered_without_human}; idle slot ${fn.idle_slot_minutes === null ? "unknown" : `${fn.idle_slot_minutes} min`}; unknown: ticket ${fn.unknowns.tickets}, first attempt ${fn.unknowns.first_attempts}, merge status ${fn.unknowns.merge_status}, outcome ${fn.unknowns.outcomes}, queue ${fn.unknowns.queues}`);
    }
  }
  return out.join("\n") + "\n";
}

export async function statusCommand(opts: { factoryHome: string; github: GitHub; since?: string; timezone?: string; json: boolean; now?: () => number }, io: Io): Promise<number> {
  const report = await statusReport(opts);
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderStatus(report));
  return 0;
}
