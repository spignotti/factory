import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realSleep, type Sleep } from "../agents/fake-runner.js";
import { EventLog, ResultSchema, type RunResult } from "../events.js";
import type { GitHub, Issue, OpenFactoryPr, PrStatus } from "../gh.js";
import { baseRef, revParse } from "../git.js";
import { activeHolders, claimResources, releaseResourceClaims, tryPathLock } from "../pipeline/lock.js";
import { mayEnableAutoMerge, selfMergePolicy, waitingOnMergeCi } from "../pipeline/merge-ready.js";
import { readState, type RunState, saveState } from "../pipeline/state.js";
import { baseCheckGate, baseProblem, type BaseCheckRecord, readBaseCheck, writeBaseCheck } from "../pipeline/base-check.js";
import { deliveryForDone, isProviderRetryCause, readStop, stopCauseOf } from "../pipeline/outcome.js";
import { closableTarget, isFailedExit, keepsPr, reportFailure } from "../pipeline/failure.js";
import { newRunId } from "../pipeline/run.js";
import { continuationLimit } from "../pipeline/recovery.js";
import { suspendSlackMs } from "../pipeline/watchdog.js";
import { postQuestions } from "../pipeline/questions.js";
import { listRuns, type RunRecord } from "../runs.js";
import { ESTIMATED_WINDOW_MS } from "../agents/models.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { admissionHold } from "./admission.js";
import { clearWorkerIdentity, executingRelease, publishWorkerIdentity, type ReleaseIdentity } from "./identity.js";
import type { Io } from "../commands/gates.js";
import { admissionBlock, cycleReasons, isAdmissionPauseReason, issueRevision, mutualBundle, priorityRank, rankPending, updateNeedsDecision } from "./admit.js";
import { clearWorkerMode, readWorkerMode } from "./control.js";
import { clearPause, pausePaths, pauseRequested, requestPause, type PauseKey } from "./pause.js";
import { advanceMergeBatch, batchBusy } from "./batch.js";
import { loadAllQueues, loadQueueByKey, queueDir, repoQueueKey, type QueueEntry, type QueueFile, updateQueue } from "./store.js";

/** Transient `needs_human` goes to the back at most this many times, then parks. */
export const MAX_REQUEUES = 2;
/**
 * How many times an entry may wait for a provider usage window (#177) before it parks permanently.
 * A separate budget from `requeues`; a window reset never gives it back.
 */
export const MAX_WINDOW_WAITS = 2;
/**
 * Total assumed waiting for usage windows whose reset time the provider did not report. Those waits
 * do not spend `MAX_WINDOW_WAITS`: a one-hour guess for a five-hour or weekly window would use it up early.
 */
export const MAX_ESTIMATED_WAIT_MS = 12 * 60 * 60_000;
/** One wait step is capped to this: a far window wakes for a bounded periodic recheck, not only at the reset. */
export const MAX_WINDOW_WAIT_MS = 6 * 60 * 60_000;
/** A run whose `events.jsonl` has not grown for `stall_minutes` times this is killed. */
const STALL_FACTOR = 2;
/** After SIGTERM, SIGKILL the process group if it is still alive. Slot stays taken until then. */
export const STALL_KILL_GRACE_MS = 60_000;
export const DEFAULT_SLOTS = 2;
const DEFAULT_POLL_MS = 15_000;
/** Idle and failed ticks never wait longer than this. */
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Backoff for an idle or failed tick. `streak` 0 stays at `baseMs`.
 * Later streaks double until {@link MAX_BACKOFF_MS}, then jitter keeps 80–100% of that.
 * A model is not called from here.
 */
export function nextPollMs(baseMs: number, streak: number, random: () => number = Math.random): number {
  const base = Math.max(1, Math.floor(baseMs));
  const step = Math.min(Math.max(0, Math.floor(streak)), 6);
  const exp = Math.min(base * 2 ** step, MAX_BACKOFF_MS);
  const unit = random();
  const clamped = Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0;
  return Math.max(base, Math.round(exp * (0.8 + 0.2 * clamped)));
}
/** GitHub and git calls from a tick. A hung `gh`/`git` must not freeze stall detection. */
export const WORKER_CALL_TIMEOUT_MS = 60_000;
/** State written and lock not taken yet: treat as live so a restart does not start a second run. */
const STARTING_GRACE_MS = 15_000;

export interface StartedRun {
  /** Resolves with `result.json` once the run process exits. */
  done: Promise<RunResult>;
  pid: number;
  runId: () => string | undefined;
  /** Stall: SIGTERM, then SIGKILL. In-process tests abort the run instead of signalling this process. */
  kill: (signal?: NodeJS.Signals) => void;
  /** Worker exit: stop watching, do not kill. A restarted worker adopts a live run. */
  unref: () => void;
}

export interface StartRunRequest {
  repo: string;
  issue: number;
  factoryHome: string;
  /** Id the resource claim and the child process share. */
  runId?: string;
  /** Set when the saved plan and worktree still match the issue text. */
  resumeRunId?: string;
  /** Extra issues in a mutual bundle. They are not started on their own. */
  bundle?: number[];
}

/** Injected so tests run the worker in-process. The CLI passes `spawnFactoryRun`. */
export type StartRun = (req: StartRunRequest) => StartedRun;

export interface RunQueueOptions {
  factoryHome: string;
  github: GitHub;
  /** One repo, or every queue file when omitted. */
  repo?: string;
  slots?: number;
  /** Epoch ms. No new starts at or after this; live runs finish. */
  untilMs?: number;
  pollMs?: number;
  /** Cap for one git/gh call in a tick. Default {@link WORKER_CALL_TIMEOUT_MS}. */
  netTimeoutMs?: number;
  sleep?: Sleep;
  now?: () => number;
  signal?: AbortSignal;
  start: StartRun;
  io?: Io;
  /**
   * Keep the worker up when nothing is queued. Idle ticks back off.
   * Does not raise `slots` or the repo cap. `--until` still ends the window.
   */
  stay?: boolean;
  /** Unit interval for {@link nextPollMs}. Tests pin it. */
  random?: () => number;
  /**
   * Release this worker runs. Defaults to the installed build; a handoff starts a worker from a
   * staged candidate and the child inherits its identity. Published as `queue/worker.json`, and
   * stamped on every entry this worker starts, so live work keeps its own release after a switch.
   */
  release?: ReleaseIdentity;
}

interface Tracked {
  repo: string;
  issue: number;
  settled?: RunResult;
  failed?: string;
  kill: (signal?: NodeJS.Signals) => void;
  unref: () => void;
  runId: () => string | undefined;
  pid: number;
  /** Stall already decided the outcome; the exit result must not reclassify it. */
  ignoreResult: boolean;
}

interface StallWatch {
  size: number;
  since: number;
}

interface Terminating {
  since: number;
  sigkill: boolean;
  mins: number;
}

interface TickCtx {
  factoryHome: string;
  github: GitHub;
  slots: number;
  untilMs?: number;
  pastUntil: boolean;
  /** Pause, drain, or past `--until`: do not discover issues and do not start runs. */
  holdStarts: boolean;
  /** A release handoff holds admissions: classify finished runs, and change nothing else. */
  releaseHold: boolean;
  /** A GitHub or git call in this tick failed. The next sleep backs off. */
  netFailed: boolean;
  nowMs: number;
  /** Wall clock jumped by much more than the tick: stall windows restart, they do not fire. */
  jumped: boolean;
  netTimeoutMs: number;
  start: StartRun;
  io: Io;
  handles: Map<string, Tracked>;
  stall: Map<string, StallWatch>;
  terminating: Map<string, Terminating>;
  behindUpdated: Map<string, number>;
  /** `update-branch` still running after a tick timeout. One per repo; a later tick does not start another. */
  behindFlight: Map<string, Promise<unknown>>;
  redLogged: Set<string>;
  /** `pr@sha` already asked to auto-merge in this process. */
  mergeEnabled: Set<string>;
  /** `repo#pr` whose update-branch hit a conflict. Not retried. */
  behindConflict: Set<string>;
  /** Release this worker runs; stamped on every entry it starts. */
  release: ReleaseIdentity;
}

interface BehindWatch {
  /** A behind PR whose run ended `done` still needs `update-branch` (failed, or not tried). */
  needsUpdate: boolean;
  /** Open factory PR whose run ended `done`: behind, or still waiting for auto-merge. */
  openDone: boolean;
}

function alive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function handleKey(repo: string, issue: number): string {
  return `${resolve(repo)}#${issue}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** True when `p` has not settled. Yields once so an already-rejected call is not treated as in flight. */
async function stillPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  return !settled;
}

/** `ps -o command= -p PID`. Empty when the pid is gone or ps cannot be asked. */
export function pidCommand(pid: number): string | undefined {
  if (!pid || pid === process.pid) return undefined;
  try {
    // -ww: otherwise ps truncates to the terminal width and drops the run id.
    const out = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    const text = out.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** The pid is this run's process only when it is alive and its command line still contains the run id. */
export function pidOwnsRun(pid: number | undefined, runId: string | undefined): boolean {
  if (!pid || !runId || !alive(pid)) return false;
  const cmd = pidCommand(pid);
  return cmd !== undefined && cmd.includes(runId);
}

export function factoryIssueOfBranch(branch: string): number | undefined {
  const m = /^factory\/(\d+)(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

/** PR number from a URL (`…/pull/17`, `…/pr/17`) or a decimal string. Never a suffix match. */
export function prNumberOf(ref: string): number | undefined {
  const text = ref.trim();
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  const m = /\/(?:pull|pr)\/([1-9]\d*)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Run ids in `planned paths overlap active runs: <id> (…)` / `… overlap another factory run: <id> …`. */
export function overlapRunIds(reason: string): string[] {
  if (!/overlap (active runs|another factory run)/i.test(reason)) return [];
  return [...new Set(reason.match(/\b\d{8}-\d{6}-[0-9a-f]{6}\b/g) ?? [])];
}

/**
 * A provider stop the worker may retry within its bounded requeues. Only a canonical
 * `transient_retry` pair requeues. Present but malformed stop metadata fails closed and does not
 * fall through to a stale `transient` flag. The flag remains only for results written before #179
 * that carry no stop metadata. Unclassified legacy stops never gain recovery from reason text.
 * `provider_window_wait` is not a requeue: #177 parks the entry on its wait window instead.
 * Two valid stops that disagree also fail closed: a transient_retry result must not outrank a
 * human_approval, budget_exhausted or unknown state.
 */
export function isTransientNeedsHuman(result: RunResult, stateTransient = false, stateStop?: unknown): boolean {
  if (result.result !== "needs_human") return false;
  const resultPresent = result.stop !== undefined && result.stop !== null;
  const statePresent = stateStop !== undefined && stateStop !== null;
  if (resultPresent || statePresent) {
    const resultStop = resultPresent ? readStop(result.stop) : undefined;
    const stored = statePresent ? readStop(stateStop) : undefined;
    if (resultPresent && !resultStop) return false;
    if (statePresent && !stored) return false;
    if (resultStop && stored && (resultStop.cause !== stored.cause || resultStop.action !== stored.action)) return false;
    const chosen = resultStop ?? stored;
    return chosen !== undefined && isProviderRetryCause(chosen.cause);
  }
  return stateTransient || (result as { transient?: boolean }).transient === true;
}

function park(entry: QueueEntry, reason: string, runId?: string, blockedRuns?: string[]): void {
  entry.status = "parked";
  entry.reason = reason;
  if (runId) entry.run_id = runId;
  delete entry.blocked_by;
  if (blockedRuns?.length) entry.blocked_runs = blockedRuns;
  else delete entry.blocked_runs;
  delete entry.pid;
  // A park for another reason is no longer a window wait; the spent `window_waits` budget stays.
  delete entry.wait_until;
  delete entry.window_resets_at;
  delete entry.window_estimated;
  delete entry.awaiting_answer;
  delete entry.failed;
}

/**
 * The one failed exit of the queue: a park that waits for nobody. A later tick puts the reason on the
 * issue, swaps `factory-ready` for `factory-failed` and closes the run's PR (unless the run already
 * did: `reported`); the entry starts a fresh run once a human sets `factory-ready` again.
 */
function failEntry(entry: QueueEntry, reason: string, runId?: string, reported = false, keepPr = false): void {
  park(entry, reason, runId);
  entry.failed = { reported, ...(keepPr ? { keep_pr: true } : {}) };
}

/**
 * A run that died without a result (hard kill, crash) or could not be started: the same bounded retry
 * as a provider drop, then the failed exit. `keepRun`: a resumable checkpoint is continued, not redone.
 */
function requeueOrFail(q: QueueFile, entry: QueueEntry, reason: string, keepRun: boolean): "requeue" | "parked" {
  const n = (entry.requeues ?? 0) + 1;
  entry.requeues = n;
  if (n <= MAX_REQUEUES) {
    releaseToPending(entry, keepRun);
    moveToEnd(q, entry);
    return "requeue";
  }
  failEntry(entry, `${reason} (retried ${MAX_REQUEUES} times)`, entry.run_id);
  return "parked";
}

function moveToEnd(q: QueueFile, entry: QueueEntry): void {
  const i = q.entries.indexOf(entry);
  if (i >= 0) q.entries.splice(i, 1);
  q.entries.push(entry);
}

function releaseToPending(entry: QueueEntry, keepRun = false): void {
  entry.status = "pending";
  delete entry.reason;
  // Overlap unpark keeps the run id so a still-valid plan can resume. A fresh start drops it.
  if (!keepRun) {
    delete entry.run_id;
    delete entry.issue_rev;
    // A fresh run has no PR yet; a stale one must never be the target of a later failure report.
    delete entry.pr;
  }
  delete entry.blocked_by;
  delete entry.blocked_runs;
  delete entry.pid;
  delete entry.paused;
  delete entry.choice;
  delete entry.wait_until;
  delete entry.window_resets_at;
  delete entry.window_estimated;
  delete entry.awaiting_answer;
  delete entry.failed;
}

/**
 * True when the result's stop canonically says `provider_window_wait` (#177) and a stored state stop
 * does not contradict it. Never read from the reason text; a missing or malformed pair fails closed.
 */
function isWindowWaitStop(result: RunResult, stateStop?: unknown): boolean {
  if (result.stop === undefined || result.stop === null) return false;
  const rs = readStop(result.stop);
  if (rs?.cause !== "provider_window_wait") return false;
  if (stateStop !== undefined && stateStop !== null) {
    const ss = readStop(stateStop);
    if (!ss || ss.cause !== "provider_window_wait") return false;
  }
  return true;
}

const BASE_PROBLEM = "base problem:";

/**
 * A `base_red` from the local fast checks on the base. It got as far as its worktree; a GitHub-CI
 * `base_red` stops before that and is resumed by its own run once the base CI is green.
 */
function hours(ms: number): string {
  return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
}

export function isLocalBaseRed(result: RunResult): boolean {
  return result.result === "base_red" && !!result.worktree;
}

/**
 * `done` records the PR. Transient `needs_human` requeues. A local `base_red` goes back to pending. An explicit
 * usage window parks until the reset. A live-run overlap `locked` parks on those runs; any other `locked` goes
 * back to pending. Questions park until answered; a pause and a GitHub-CI `base_red` park as before.
 * Everything else, including a result nobody listed, is failed (`failEntry`). `paused`: a pause marker exists.
 */
export function applyOutcome(q: QueueFile, entry: QueueEntry, result: RunResult, opts?: { transient?: boolean; stateStop?: unknown; now?: number; paused?: boolean }): "done" | "requeue" | "parked" {
  entry.run_id = result.run_id;
  if (result.pr) entry.pr = result.pr;
  delete entry.pid;
  delete entry.awaiting_answer;
  if (result.result === "done") {
    entry.status = "done";
    entry.delivery = deliveryForDone(result);
    delete entry.reason;
    delete entry.blocked_by;
    return "done";
  }
  if (result.result === "needs_human" && isWindowWaitStop(result, opts?.stateStop)) {
    // Model fallback already had its chance in the run. The wait holds no coding slot; the persisted
    // wake-up survives a restart and the entry resumes with its original run, checkpoint and PR.
    const now = opts?.now ?? Date.now();
    const resetsAt = result.window_resets_at;
    const estimated = result.window_estimated === true;
    // An assumed window is charged at least its assumed length, so a reset already past still counts.
    const charged = estimated ? (entry.window_estimated_ms ?? 0) + Math.max(ESTIMATED_WINDOW_MS, (resetsAt ?? now) - now) : 0;
    const waits = (entry.window_waits ?? 0) + (estimated ? 0 : 1);
    if (estimated) entry.window_estimated_ms = charged;
    else entry.window_waits = waits;
    const budgetLeft = estimated ? charged <= MAX_ESTIMATED_WAIT_MS : waits <= MAX_WINDOW_WAITS;
    if (budgetLeft && resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0) {
      // A window that has already opened is due on the next tick. applyOutcome does not resume: the
      // worker revalidates issue revision, pause and stop authorization first.
      const budget = estimated ? `estimated; ${hours(charged)} of ${hours(MAX_ESTIMATED_WAIT_MS)} assumed waits` : `wait ${waits}/${MAX_WINDOW_WAITS}`;
      park(entry, `provider usage window resets ${new Date(resetsAt).toISOString()} (${budget}); factory resume ${result.run_id}`, result.run_id);
      entry.wait_until = resetsAt > now ? Math.min(resetsAt, now + MAX_WINDOW_WAIT_MS) : now;
      entry.window_resets_at = resetsAt;
      if (estimated) entry.window_estimated = true;
      return "parked";
    }
    // No usable window metadata, or the bounded wait budget is spent: the failed exit (the PR stays
    // open: the change itself was not judged), never a requeue and never a reset of the spent budgets.
    failEntry(
      entry,
      budgetLeft
        ? result.reason || result.result
        : estimated
          ? `estimated provider usage window waits exhausted (${hours(MAX_ESTIMATED_WAIT_MS)}); ${result.reason}`.slice(0, 400)
          : `provider usage window waits exhausted (${waits - 1}/${MAX_WINDOW_WAITS}); ${result.reason}`.slice(0, 400),
      result.run_id,
      false,
      true,
    );
    return "parked";
  }
  if (isTransientNeedsHuman(result, opts?.transient === true, opts?.stateStop)) {
    const n = (entry.requeues ?? 0) + 1;
    entry.requeues = n;
    if (n <= MAX_REQUEUES) {
      // A canonical retry keeps the original run and checkpoint. Legacy results (no stop) start fresh.
      releaseToPending(entry, stopCauseOf(result.stop) === "transient_retry");
      moveToEnd(q, entry);
      return "requeue";
    }
    failEntry(entry, `provider retries spent (${MAX_REQUEUES}/${MAX_REQUEUES}); ${result.reason}`.slice(0, 400), result.run_id, false, true);
    return "parked";
  }
  if (isLocalBaseRed(result)) {
    // The base, not this ticket, is red. The worker holds starts on the recorded base check, so the
    // ticket waits as pending and starts by itself once the base is green; no requeue budget is spent.
    releaseToPending(entry);
    entry.reason = `${BASE_PROBLEM} ${result.reason}`;
    return "requeue";
  }
  if (result.result === "locked") {
    // A live run claims these paths: wait for it to finish instead of parking for the night.
    const runs = overlapRunIds(result.reason);
    if (runs.length) {
      park(entry, result.reason, result.run_id, runs);
      return "parked";
    }
    // A repo slot or a resource held by another run: try again on a later tick, keeping a run that
    // already has a worktree (its work is not thrown away).
    releaseToPending(entry, !!result.worktree);
    return "requeue";
  }
  // The run decided it failed and reported it (or tried to): the queue does not judge it again.
  if (result.failure_reported !== undefined || isFailedExit(result, { paused: opts?.paused === true })) {
    failEntry(entry, result.reason || result.result, result.run_id, result.failure_reported === true, keepsPr(result.stop));
    return "parked";
  }
  park(entry, result.reason || result.result, result.run_id);
  // The questions travel with the entry: a retry of the post does not depend on the run directory.
  if (result.result === "needs_input" && result.questions?.length) {
    entry.awaiting_answer = { questions: result.questions, posted: result.questions_posted === true };
  }
  return "parked";
}

function issueOf(run: RunRecord): number | undefined {
  if (typeof run.state?.task.issue === "number") return run.state.task.issue;
  const task = run.result?.task ?? run.state?.task.ref;
  const m = /^#(\d+)$/.exec(task ?? "");
  return m ? Number(m[1]) : undefined;
}

function sameRepo(run: RunRecord, repo: string): boolean {
  const path = run.state?.repo ?? run.result?.repo ?? "";
  return resolve(path) === resolve(repo);
}

function holderIds(factoryHome: string): Set<string> {
  return new Set(activeHolders(factoryHome).map((h) => h.runId).filter((id): id is string => Boolean(id)));
}

function asResult(value: RunResult | undefined): RunResult | undefined {
  if (!value) return undefined;
  const parsed = ResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A lock holder, or a run dir touched in the last few seconds (lock not taken yet). A written result is not live. */
function runIsLive(factoryHome: string, run: RunRecord, holders: Set<string>): boolean {
  if (run.result) return false;
  if (holders.has(run.run_id)) return true;
  if (!run.state) return false;
  try {
    return Date.now() - statSync(join(run.dir, "state.json")).mtimeMs < STARTING_GRACE_MS;
  } catch {
    return false;
  }
}

function resourceNames(repo: string): string[] {
  try {
    return loadRepoConfig(repo).concurrency.resources;
  } catch {
    return [];
  }
}

function releaseEntryResources(factoryHome: string, repo: string, entry: QueueEntry): void {
  if (!entry.run_id) return;
  const names = resourceNames(repo);
  if (names.length) releaseResourceClaims(factoryHome, names, entry.run_id);
}

function settleBundle(q: QueueFile, entry: QueueEntry, factoryHome: string, io: Io): void {
  const extras = q.entries.filter((e) => e.bundled_with === entry.issue);
  if (!extras.length) return;
  // finalize wrote the partners its `Closes` footer names: accepted evidence only, bundle partners only.
  let met = new Set<number>();
  if (entry.run_id) {
    try {
      const file = JSON.parse(readFileSync(join(factoryHome, "runs", entry.run_id, "fulfilled.json"), "utf8")) as { issues?: unknown };
      met = new Set(Array.isArray(file.issues) ? file.issues.filter((n): n is number => typeof n === "number") : []);
    } catch {
      met = new Set();
    }
  }
  for (const extra of extras) {
    delete extra.bundled_with;
    if (met.has(extra.issue)) {
      extra.status = "done";
      extra.reason = `fulfilled with #${entry.issue}`;
      io.out(`queue: #${extra.issue} done (fulfilled with #${entry.issue})\n`);
    } else {
      extra.status = "pending";
      extra.reason = `not fulfilled with #${entry.issue}`;
      io.out(`queue: #${extra.issue} pending (not fulfilled with #${entry.issue})\n`);
    }
  }
}

function releaseBundle(q: QueueFile, issue: number): void {
  for (const extra of q.entries) {
    if (extra.bundled_with !== issue) continue;
    delete extra.bundled_with;
    if (extra.status !== "done") {
      extra.status = "pending";
      extra.reason = `bundle with #${issue} did not finish`;
    }
  }
}

function finishEntry(q: QueueFile, entry: QueueEntry, factoryHome: string, result: RunResult, io: Io, nowMs: number): ReturnType<typeof applyOutcome> {
  releaseEntryResources(factoryHome, q.repo, entry);
  const state = listRuns(factoryHome).find((r) => r.run_id === result.run_id)?.state;
  const paused = pauseRequested(factoryHome, { runId: result.run_id, repo: q.repo, issue: entry.issue }) !== undefined;
  const action = applyOutcome(q, entry, result, { transient: state?.transient === true, stateStop: state?.stop, now: nowMs, paused });
  if (action === "done") settleBundle(q, entry, factoryHome, io);
  else releaseBundle(q, entry.issue);
  return action;
}

/** A saved plan is reused only when the worktree exists and the issue text is unchanged. */
function canResume(factoryHome: string, entry: QueueEntry, issue: Issue): boolean {
  if (!entry.run_id || !entry.issue_rev) return false;
  if (entry.issue_rev !== issueRevision(issue.title, issue.body)) return false;
  const dir = join(factoryHome, "runs", entry.run_id);
  if (!existsSync(join(dir, "plan.json")) || !existsSync(join(dir, "worktree"))) return false;
  try {
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { step?: string };
    return st.step !== undefined && st.step !== "intake" && st.step !== "finished";
  } catch {
    return false;
  }
}

/** A plan and worktree from a dead process can resume. Intake and a finished step cannot. */
function checkpointResumable(factoryHome: string, runId: string): boolean {
  const dir = join(factoryHome, "runs", runId);
  if (!existsSync(join(dir, "plan.json")) || !existsSync(join(dir, "worktree"))) return false;
  try {
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { step?: string };
    return st.step !== undefined && st.step !== "intake" && st.step !== "finished";
  } catch {
    return false;
  }
}

function adopt(q: QueueFile, factoryHome: string, handles: Map<string, Tracked>, nowMs: number): void {
  const runs = listRuns(factoryHome).filter((r) => sameRepo(r, q.repo));
  const holders = holderIds(factoryHome);
  for (const entry of q.entries) {
    const tracked = handles.get(handleKey(q.repo, entry.issue));
    if (tracked?.ignoreResult) continue;
    if (tracked && tracked.settled === undefined && !tracked.failed) continue;
    const related = runs.filter((r) => r.run_id === entry.run_id || issueOf(r) === entry.issue);
    const own = entry.run_id ? related.find((r) => r.run_id === entry.run_id) : undefined;
    // result.json wins over a pid that merely looks alive (a recycled pid must not hide a finished run).
    if (entry.status === "running" && own?.result) {
      const finished = asResult(own.result);
      if (finished) {
        finishEntry(q, entry, factoryHome, finished, { out: () => {}, err: () => {} }, nowMs);
        continue;
      }
    }
    const pidLive = pidOwnsRun(entry.pid, entry.run_id);
    const live = related.find((r) => !r.result && (runIsLive(factoryHome, r, holders) || (pidLive && r.run_id === entry.run_id)));
    if ((live || pidLive) && (entry.status === "pending" || entry.status === "running")) {
      entry.status = "running";
      if (live) entry.run_id = live.run_id;
      continue;
    }
    if (entry.status !== "running") continue;
    const finished = asResult(entry.run_id ? undefined : related.filter((r) => r.result).at(-1)?.result);
    if (finished) {
      finishEntry(q, entry, factoryHome, finished, { out: () => {}, err: () => {} }, nowMs);
      continue;
    }
    if (!entry.run_id && !pidLive) {
      // Recorded running, but the child never created a run. Put it back instead of parking.
      entry.status = "pending";
      delete entry.pid;
      continue;
    }
    if (entry.run_id && !holders.has(entry.run_id) && !pidLive) {
      const dir = join(factoryHome, "runs", entry.run_id);
      const started = existsSync(join(dir, "state.json")) || existsSync(join(dir, "result.json"));
      const pidDead = !entry.pid || !alive(entry.pid);
      // Crash before the run wrote anything: put the issue back. A live foreign pid is not proof
      // the start happened, and it is not a reason to launch a second run.
      if (!started && pidDead) {
        releaseEntryResources(factoryHome, q.repo, entry);
        entry.status = "pending";
        delete entry.pid;
        delete entry.run_id;
        delete entry.issue_rev;
        continue;
      }
      // Crash after the checkpoint: same run id, no second PR.
      if (started && checkpointResumable(factoryHome, entry.run_id)) {
        releaseEntryResources(factoryHome, q.repo, entry);
        entry.status = "pending";
        delete entry.pid;
        continue;
      }
      releaseEntryResources(factoryHome, q.repo, entry);
      requeueOrFail(q, entry, "run ended without result.json", false);
    }
  }
}

function absorbHandles(q: QueueFile, handles: Map<string, Tracked>, io: Io, factoryHome: string, nowMs: number): void {
  for (const entry of [...q.entries]) {
    const key = handleKey(q.repo, entry.issue);
    const tracked = handles.get(key);
    if (!tracked || (tracked.settled === undefined && !tracked.failed)) continue;
    if (tracked.ignoreResult) {
      if (entry.status === "parked" && entry.reason?.startsWith("stalled:")) handles.delete(key);
      continue;
    }
    handles.delete(key);
    if (entry.status === "done" || (entry.status === "parked" && entry.reason?.startsWith("stalled:"))) continue;
    if (tracked.failed && !tracked.settled) {
      releaseEntryResources(factoryHome, q.repo, entry);
      releaseBundle(q, entry.issue);
      const keepRun = !!entry.run_id && checkpointResumable(factoryHome, entry.run_id);
      const action = requeueOrFail(q, entry, tracked.failed, keepRun);
      io.out(`queue: #${entry.issue} ${action === "requeue" ? `requeued (${entry.requeues}/${MAX_REQUEUES})` : "failed"}: ${tracked.failed}\n`);
      continue;
    }
    if (!tracked.settled) continue;
    const action = finishEntry(q, entry, factoryHome, tracked.settled, io, nowMs);
    if (action === "done") io.out(`queue: #${entry.issue} done${entry.pr ? ` ${entry.pr}` : ""}\n`);
    else if (action === "requeue" && tracked.settled.result === "locked") io.out(`queue: #${entry.issue} pending (repo lock held)\n`);
    else if (action === "requeue" && tracked.settled.result === "base_red") io.out(`queue: #${entry.issue} pending (${entry.reason})\n`);
    else if (action === "requeue") io.out(`queue: #${entry.issue} requeued (${entry.requeues}/${MAX_REQUEUES})\n`);
    else io.out(`queue: #${entry.issue} ${entry.failed ? "failed" : "parked"}: ${entry.reason}\n`);
  }
}

function eventsSize(factoryHome: string, runId: string): number {
  try {
    return statSync(join(factoryHome, "runs", runId, "events.jsonl")).size;
  } catch {
    return 0;
  }
}

/** Detached runs are their own process group. Signal the group, then the pid if it is not a leader. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!pid || pid === process.pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Signal the handle we spawned, or a stored pid whose command line still contains the run id. Never a recycled pid. */
function signalGroup(signal: NodeJS.Signals, tracked: Tracked | undefined, entry: QueueEntry): void {
  if (tracked) {
    tracked.kill(signal);
    return;
  }
  if (entry.pid && pidOwnsRun(entry.pid, entry.run_id)) signalPid(entry.pid, signal);
}

function canSignal(tracked: Tracked | undefined, entry: QueueEntry): boolean {
  return Boolean(tracked) || pidOwnsRun(entry.pid, entry.run_id);
}

function runExited(tracked: Tracked | undefined, entry: QueueEntry): boolean {
  if (tracked) {
    if (tracked.settled !== undefined || tracked.failed) return true;
    if (tracked.pid > 0 && !alive(tracked.pid)) return true;
    return false;
  }
  return Boolean(entry.pid) && !alive(entry.pid!);
}

function parkStalled(entry: QueueEntry, mins: number, ctx: TickCtx): void {
  const reason = `stalled: events.jsonl unchanged for ${mins} min`;
  failEntry(entry, reason, entry.run_id);
  if (entry.run_id) {
    ctx.terminating.delete(entry.run_id);
    ctx.stall.delete(entry.run_id);
  }
  ctx.io.out(`queue: #${entry.issue} parked: ${reason}\n`);
}

/**
 * Stall keeps the slot until the process has exited. SIGTERM first; SIGKILL the group after
 * {@link STALL_KILL_GRACE_MS}. A wall-clock jump (sleep) resets the windows instead of firing.
 */
function considerStall(entry: QueueEntry, repo: string, ctx: TickCtx, tracked: Tracked | undefined): void {
  if (entry.status !== "running" || !entry.run_id) return;
  const size = eventsSize(ctx.factoryHome, entry.run_id);
  if (ctx.jumped) {
    ctx.stall.set(entry.run_id, { size, since: ctx.nowMs });
    const term = ctx.terminating.get(entry.run_id);
    if (term && runExited(tracked, entry)) {
      parkStalled(entry, term.mins, ctx);
      return;
    }
    if (term && !term.sigkill) ctx.terminating.set(entry.run_id, { ...term, since: ctx.nowMs });
    return;
  }
  const term = ctx.terminating.get(entry.run_id);
  if (term) {
    if (runExited(tracked, entry)) {
      parkStalled(entry, term.mins, ctx);
      return;
    }
    if (!canSignal(tracked, entry)) {
      ctx.terminating.delete(entry.run_id);
      return;
    }
    if (!term.sigkill && ctx.nowMs - term.since >= STALL_KILL_GRACE_MS) {
      signalGroup("SIGKILL", tracked, entry);
      term.sigkill = true;
      ctx.io.out(`queue: #${entry.issue} stall: SIGKILL\n`);
    }
    return;
  }
  let limit: number;
  try {
    limit = loadRepoConfig(repo).limits.stall_minutes * STALL_FACTOR * 60_000;
  } catch {
    return;
  }
  const prev = ctx.stall.get(entry.run_id);
  if (!prev || prev.size !== size) {
    ctx.stall.set(entry.run_id, { size, since: ctx.nowMs });
    return;
  }
  if (ctx.nowMs - prev.since < limit) return;
  if (!canSignal(tracked, entry)) return;
  if (tracked) tracked.ignoreResult = true;
  signalGroup("SIGTERM", tracked, entry);
  const mins = Math.round((limit / 60_000) * 10) / 10;
  ctx.terminating.set(entry.run_id, { since: ctx.nowMs, sigkill: false, mins });
  ctx.io.out(`queue: #${entry.issue} stall: SIGTERM, waiting for exit\n`);
}

function localBookkeeping(q: QueueFile, repo: string, ctx: TickCtx): void {
  absorbHandles(q, ctx.handles, ctx.io, ctx.factoryHome, ctx.nowMs);
  adopt(q, ctx.factoryHome, ctx.handles, ctx.nowMs);
  for (const entry of q.entries) {
    if (entry.status !== "running") continue;
    const tracked = ctx.handles.get(handleKey(repo, entry.issue));
    noteRunId(entry, tracked);
    // A pause leaves the process running. Signalling it would drop the checkpoint.
    if (entry.paused) continue;
    considerStall(entry, repo, ctx, tracked);
  }
}

async function prGate(github: GitHub, repo: string, pr: string): Promise<"wait" | "go" | "park"> {
  const st = await github.prStatus(repo, pr);
  if (st.state === "merged") return "go";
  if (st.state === "closed") return "park";
  return "wait";
}

async function issueClosed(github: GitHub, repo: string, issue: number): Promise<boolean> {
  try {
    const row = await github.getIssue(repo, issue);
    return (row.state ?? "open") === "closed";
  } catch (e) {
    if (/not found/i.test((e as Error).message)) return false;
    throw e;
  }
}

async function afterGate(entry: QueueEntry, q: QueueFile, github: GitHub, repo: string, factoryHome: string): Promise<"wait" | "go" | "park"> {
  if (entry.after === undefined) return "go";
  const deps = q.entries.filter((e) => e.issue === entry.after);
  if (deps.some((e) => e.status !== "done")) return "wait";
  const pr = deps.map((e) => e.pr).filter((p): p is string => Boolean(p)).at(-1);
  if (pr) return prGate(github, repo, pr);
  if (deps.length) return "park";
  const runs = listRuns(factoryHome).filter((r) => sameRepo(r, repo) && issueOf(r) === entry.after);
  const external = runs.map((r) => r.result?.pr ?? r.state?.pr).filter((p): p is string => Boolean(p)).at(-1);
  if (external) {
    const gate = await prGate(github, repo, external);
    if (gate === "go") return "go";
    if (gate === "wait") return (await issueClosed(github, repo, entry.after)) ? "go" : "wait";
  }
  // Not in the queue (or its PR closed without merge): closed issue or a merged factory PR is enough.
  if (await issueClosed(github, repo, entry.after)) return "go";
  const found = await github.findFactoryPr(repo, entry.after);
  if (found?.state === "merged") return "go";
  if (found?.state === "open") return "wait";
  const open = await github.openFactoryPrFiles(repo);
  if (open.some((p) => factoryIssueOfBranch(p.branch) === entry.after)) return "wait";
  return "wait";
}

/**
 * Entries parked behind live runs come back once those runs have a result. An entry parked behind an
 * open factory PR (`blocked_by`, written before PR overlap stopped blocking) comes back on the next tick.
 */
function unparkReady(q: QueueFile, factoryHome: string): Set<number> {
  const ready = new Set<number>();
  const finished = new Set(listRuns(factoryHome).filter((r) => r.result).map((r) => r.run_id));
  for (const entry of q.entries) {
    if (entry.status !== "parked") continue;
    if (entry.blocked_by?.length) ready.add(entry.issue);
    else if (entry.blocked_runs?.length && entry.blocked_runs.every((id) => finished.has(id))) ready.add(entry.issue);
  }
  return ready;
}

function applyUnpark(q: QueueFile, ready: Set<number>, io: Io): void {
  for (const entry of q.entries) {
    if (!ready.has(entry.issue) || entry.status !== "parked" || !(entry.blocked_by?.length || entry.blocked_runs?.length)) continue;
    const byRun = (entry.blocked_runs?.length ?? 0) > 0;
    releaseToPending(entry, true);
    io.out(`queue: #${entry.issue} pending (${byRun ? "overlapping run finished" : "open PRs no longer block"})\n`);
  }
}

interface WindowDecision {
  /** issue -> keep the run/checkpoint (true) or start fresh (false). */
  release: Map<number, boolean>;
  /** issue -> next bounded recheck for a window that has not opened yet. */
  extend: Map<number, number>;
  /** Due waits whose stored stop no longer authorizes a resume. Wake-up dropped; budgets kept. */
  refuse: Set<number>;
  /** Admission pause no longer applies. Clear `paused` and the marker; a human pause is never in here. */
  clearAdmissionPause: Set<number>;
}

function pauseMarkerTexts(factoryHome: string, key: PauseKey): string[] {
  const out: string[] = [];
  for (const path of pausePaths(factoryHome, key)) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) out.push(text);
    } catch {
      // missing marker
    }
  }
  return out;
}

/** An operator or other non-admission marker. Revalidation must not clear or skip past it. */
function hasRealPause(factoryHome: string, key: PauseKey): boolean {
  return pauseMarkerTexts(factoryHome, key).some((text) => !isAdmissionPauseReason(text));
}

/**
 * A window resume is authorized only while every stored stop still says `provider_window_wait`.
 * A missing stop (the queue already accepted the wait) does not block. A present contradictory or
 * malformed stop fails closed: no resume, and no fresh implementation of the same checkpoint.
 */
function windowResumeAuthorized(factoryHome: string, runId: string | undefined): boolean {
  if (!runId) return true;
  const run = listRuns(factoryHome).find((r) => r.run_id === runId);
  if (!run) return true;
  const stored = (obj: object | undefined): boolean => {
    if (!obj || !Object.prototype.hasOwnProperty.call(obj, "stop")) return true;
    return readStop((obj as { stop?: unknown }).stop)?.cause === "provider_window_wait";
  };
  return stored(run.state) && stored(run.result);
}

/**
 * Provider window waits (#177). A parked entry with `wait_until` is examined once that time passes:
 * a window that has not opened yet only moves the next bounded recheck (no budget is spent, no run
 * starts); an opened window is revalidated — pause (run or issue), the stored stop's authorization,
 * the issue revision and the checkpoint decide whether the original run and PR are reused — and the
 * entry becomes pending again. A stop that no longer authorizes the wait drops the wake-up and does
 * not reset spent repair budgets or start a second implementation.
 * A ready-label pause left on the entry when the run hit the window is revalidated here: if admission
 * is back, the marker is cleared and the same checkpoint resumes. An operator pause is not cleared.
 * A temporary admission block does not drop `run_id` / `issue_rev`; a later start must not be a second
 * implementation with reset repair budgets.
 * Holds no coding slot: while it waits, the worker keeps its normal poll cadence (no busy-poll).
 */
async function windowWaits(snap: QueueFile, repo: string, ctx: TickCtx, noteFailure: () => void): Promise<WindowDecision> {
  const release = new Map<number, boolean>();
  const extend = new Map<number, number>();
  const refuse = new Set<number>();
  const clearAdmissionPause = new Set<number>();
  for (const entry of snap.entries) {
    if (entry.status !== "parked" || entry.wait_until === undefined || ctx.nowMs < entry.wait_until) continue;
    const pauseKey = { runId: entry.run_id, repo, issue: entry.issue };
    // A human pause stays until that human clears it. Do not resume and do not clear the marker.
    if (hasRealPause(ctx.factoryHome, pauseKey)) continue;
    const admissionPaused = entry.paused === true || pauseMarkerTexts(ctx.factoryHome, pauseKey).some((text) => isAdmissionPauseReason(text));
    if (entry.window_resets_at !== undefined && ctx.nowMs < entry.window_resets_at) {
      extend.set(entry.issue, Math.min(entry.window_resets_at, ctx.nowMs + MAX_WINDOW_WAIT_MS));
      continue;
    }
    if (!windowResumeAuthorized(ctx.factoryHome, entry.run_id)) {
      refuse.add(entry.issue);
      continue;
    }
    let issue: Issue;
    try {
      issue = await withTimeout(ctx.github.getIssue(repo, entry.issue), ctx.netTimeoutMs, `window issue #${entry.issue}`);
    } catch (e) {
      noteFailure();
      ctx.io.err(`factory: window revalidation #${entry.issue} failed: ${(e as Error).message.slice(0, 200)}\n`);
      continue;
    }
    if (admissionBlock(issue)) {
      // Temporarily not admissible. Dropping the run id here starts a duplicate implementation and
      // resets repair budgets once authorization returns. An admission pause stays parked so the
      // marker is rechecked; otherwise pending again, identity kept, and the candidate rules wait.
      if (!admissionPaused) release.set(entry.issue, true);
      continue;
    }
    if (admissionPaused) clearAdmissionPause.add(entry.issue);
    release.set(entry.issue, canResume(ctx.factoryHome, entry, issue));
  }
  return { release, extend, refuse, clearAdmissionPause };
}

interface BaseGate {
  block: boolean;
  /** A red local base check of the current base commit, as shown on pending entries. */
  problem?: string;
  /** The red local record is old enough: one run may check the base again. */
  recheck?: BaseCheckRecord;
}

/**
 * Red base CI, a red local base check that is still recent (when GitHub reports no CI), or a check we
 * could not read: start nothing for this repo this tick.
 */
async function baseBlocks(github: GitHub, repo: string, io: Io, redLogged: Set<string>, timeoutMs: number, record: { factoryHome: string; repoKey: string; nowMs: number }, onFailure?: () => void): Promise<BaseGate> {
  try {
    const cfg = loadRepoConfig(repo);
    const gitOpts = { timeoutMs };
    const sha = await revParse(repo, await baseRef(repo, cfg.base_branch, gitOpts), gitOpts);
    const status = await withTimeout(github.baseStatus(repo, sha), timeoutMs, "base CI");
    if (status !== "red") redLogged.delete(repo);
    else {
      if (!redLogged.has(repo)) io.err(`factory: base CI red, not starting (${repo})\n`);
      redLogged.add(repo);
      return { block: true };
    }
    const logKey = `${repo}#local`;
    const recorded = status === "none" ? readBaseCheck(record.factoryHome, record.repoKey) : undefined;
    const gate = baseCheckGate(recorded, sha, record.nowMs);
    if (gate === "start") {
      redLogged.delete(logKey);
      return { block: false };
    }
    const problem = baseProblem(recorded)!;
    if (gate === "recheck") return { block: false, problem, recheck: recorded! };
    if (!redLogged.has(logKey)) io.err(`factory: ${problem}; not starting (${repo})\n`);
    redLogged.add(logKey);
    return { block: true, problem };
  } catch (e) {
    onFailure?.();
    io.err(`factory: base CI check failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return { block: true };
  }
}

function runEndedDone(runs: RunRecord[], pr: OpenFactoryPr): boolean {
  return runs.some((r) => {
    const done = r.result?.result === "done" || r.state?.result === "done";
    if (!done) return false;
    const branch = r.state?.branch ?? r.result?.branch;
    if (branch && branch === pr.branch) return true;
    const url = r.result?.pr ?? r.state?.pr ?? "";
    return url !== "" && prNumberOf(url) === pr.number;
  });
}

/** Branch protection contexts, or null when they cannot be read. Null does not enable auto-merge. */
async function requiredChecksFor(github: GitHub, repo: string, timeoutMs: number): Promise<readonly string[] | null> {
  let branch = "main";
  try {
    branch = loadRepoConfig(repo).base_branch;
  } catch {
    // no repo.yaml (unit tests): settings still decide
  }
  return (await withTimeout(github.repoSettings(repo, branch), timeoutMs, "repo settings")).required_checks;
}

/**
 * Done runs whose policy is auto or bot_review: enable auto-merge once the approved SHA is the head and CI is green,
 * and `done` is required. bot_review also requires that head to be the reviewed SHA.
 * A live head that is not the approved SHA disables auto-merge and is not enabled.
 * Pending CI keeps the worker up only while `untilMs` is set; it does not take a coding slot.
 * Returns true when a PR is still waiting on CI.
 */
export async function enableReadyMerges(
  github: GitHub,
  repo: string,
  factoryHome: string,
  enabled: Set<string>,
  io: Io,
  timeoutMs: number,
  onFailure?: () => void,
): Promise<boolean> {
  const runs = listRuns(factoryHome).filter((run) => sameRepo(run, repo));
  let waiting = false;
  let requiredChecks: readonly string[] | null;
  try {
    requiredChecks = await requiredChecksFor(github, repo, timeoutMs);
  } catch (e) {
    onFailure?.();
    io.err(`factory: repo settings failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    requiredChecks = null;
  }
  for (const run of runs) {
    const policy = run.result?.merge_policy;
    const approved = run.state?.approved_sha;
    const pr = run.result?.pr ?? run.state?.pr ?? null;
    const branch = run.state?.branch ?? run.result?.branch ?? null;
    if (run.result?.result !== "done" || !pr || !approved) continue;
    if (run.run_id && pauseRequested(factoryHome, { runId: run.run_id })) continue;
    let status: PrStatus;
    try {
      status = await withTimeout(github.prStatus(repo, pr), timeoutMs, `pr status ${pr}`);
    } catch (e) {
      onFailure?.();
      io.err(`factory: pr status ${pr} failed: ${(e as Error).message.slice(0, 200)}\n`);
      waiting = true;
      continue;
    }
    let head: string | null = null;
    if (branch && status.state === "open") {
      try {
        head = (await withTimeout(github.findOpenPr(repo, branch), timeoutMs, `open pr ${branch}`))?.headSha ?? null;
      } catch (e) {
        onFailure?.();
        io.err(`factory: open pr ${pr} failed: ${(e as Error).message.slice(0, 200)}\n`);
        waiting = true;
        continue;
      }
    }
    if (status.state === "open" && head && head !== approved) {
      for (const key of [...enabled]) if (key.startsWith(`${pr}@`)) enabled.delete(key);
      try {
        await withTimeout(github.disableAutoMerge(repo, pr), timeoutMs, `disable auto-merge ${pr}`);
      } catch (e) {
        onFailure?.();
        io.err(`factory: disable auto-merge ${pr} failed: ${(e as Error).message.slice(0, 200)}\n`);
        waiting = true;
      }
      continue;
    }
    if (waitingOnMergeCi({ policy, ci: status.ci, draft: status.draft, state: status.state })) waiting = true;
    if (!mayEnableAutoMerge({ policy, approvedSha: approved, headSha: head, reviewedSha: run.state?.reviewed_sha, ci: status.ci, draft: status.draft, state: status.state, requiredChecks })) continue;
    const key = `${pr}@${approved}`;
    if (enabled.has(key)) continue;
    try {
      await withTimeout(github.enableAutoMerge(repo, pr, approved), timeoutMs, `auto-merge ${pr}`);
      enabled.add(key);
      io.out(`queue: auto-merge ${pr}\n`);
    } catch (e) {
      onFailure?.();
      io.err(`factory: auto-merge ${pr} failed: ${(e as Error).message.slice(0, 200)}\n`);
      waiting = true;
    }
  }
  return waiting;
}

function selfMergeRuns(runs: RunRecord[], pr: OpenFactoryPr): RunRecord[] {
  return runs.filter((r) => selfMergePolicy(r.result?.merge_policy) && runEndedDone([r], pr));
}

/** Revalidate through the existing pipeline. A poller never manufactures a review SHA. */
async function scheduleContinuations(ctx: TickCtx, repo: string): Promise<void> {
  const q = loadQueueByKey(ctx.factoryHome, await repoQueueKey(repo));
  if (!q) return;
  for (const run of listRuns(ctx.factoryHome).filter((r) => sameRepo(r, repo))) {
    const st = run.state;
    if (!st?.pr || !st.branch || !st.worktree || !run.result || st.gc_at) continue;
    // Only a done self-merge PR is revalidated here. A stopped run had its resolver turns in the run
    // and ended failed; nothing continues it. None of this grants merge permission.
    if (run.result.result !== "done") continue;
    if (!st.continuation && !selfMergePolicy(run.result.merge_policy)) continue;
    const entry = q.entries.find((e) => e.run_id === run.run_id);
    if (!entry || entry.status === "running" || entry.status === "pending" || !entry.issue_rev) continue;
    if (pauseRequested(ctx.factoryHome, { runId: run.run_id })) continue;
    if (!existsSync(st.worktree) || !existsSync(join(run.dir, "plan.json"))) continue;
    try {
      const status = await withTimeout(ctx.github.prStatus(repo, st.pr), ctx.netTimeoutMs, "continuation PR");
      if (status.state !== "open") continue;
      const head = await withTimeout(ctx.github.findOpenPr(repo, st.branch), ctx.netTimeoutMs, "continuation head");
      if (!head?.headSha || head.url !== st.pr) continue;
      const kind: "ci" | "head" | "base" | "blocker" | undefined = st.continuation
        ? st.continuation.kind
        : head.headSha !== st.approved_sha
          ? "head"
          : status.behind
            ? "base"
            : status.ci === "red"
              ? "ci"
              : undefined;
      if (!kind) continue;
      await withTimeout(ctx.github.disableAutoMerge(repo, st.pr), ctx.netTimeoutMs, "disable stale approval");
      if ((st.continuation_attempts ?? 0) >= continuationLimit(st.continuation_extra)) {
        await updateQueue(ctx.factoryHome, repo, (queue) => {
          const own = queue.entries.find((e) => e.run_id === run.run_id);
          // A done PR whose head or base moved under it: report, but leave the PR to a person.
          if (own) failEntry(own, `post-push repair exhausted (${st.continuation_attempts ?? 0}/${continuationLimit(st.continuation_extra)})`, undefined, false, true);
        });
        continue;
      }
      const issue = await withTimeout(ctx.github.getIssue(repo, entry.issue), ctx.netTimeoutMs, "continuation issue");
      if (admissionBlock(issue) || entry.issue_rev !== issueRevision(issue.title, issue.body)) continue;
      st.continuation = { kind, sha: head.headSha };
      if (st.step === "finished") st.step = "review";
      delete st.approved_sha;
      saveState({ runDir: run.dir, events: new EventLog(run.dir, run.run_id) }, st);
      await updateQueue(ctx.factoryHome, repo, (queue) => {
        const own = queue.entries.find((e) => e.run_id === run.run_id);
        if (own && own.status !== "running") releaseToPending(own, true);
      });
      ctx.io.out(`queue: #${entry.issue} resumes ${run.run_id} (${kind}; same PR)\n`);
    } catch (e) {
      ctx.netFailed = true;
      ctx.io.err(`factory: continuation ${run.run_id}: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
}

/**
 * Every behind `factory/*` PR whose run ended `done`, one `update-branch` at a time.
 * A failure is logged and left for a later tick; it does not skip the rest of the list.
 * `auto` and `bot_review` drop the old auto-merge and approve only the head this call just produced.
 */
const BEHIND_RETRY_MS = 10 * 60_000;

async function updateBehind(
  github: GitHub,
  repo: string,
  factoryHome: string,
  updated: Map<string, number>,
  flight: Map<string, Promise<unknown>>,
  conflicted: Set<string>,
  io: Io,
  timeoutMs: number,
  onFailure?: () => void,
): Promise<BehindWatch> {
  let prs: OpenFactoryPr[];
  try {
    prs = await withTimeout(github.openFactoryPrFiles(repo), timeoutMs, "open PRs");
  } catch (e) {
    onFailure?.();
    io.err(`factory: open PR list failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return { needsUpdate: true, openDone: false };
  }
  const runs = listRuns(factoryHome).filter((r) => sameRepo(r, repo));
  let needsUpdate = false;
  let openDone = false;
  for (const pr of prs) {
    if (!runEndedDone(runs, pr)) continue;
    const key = String(pr.number);
    let status: PrStatus;
    try {
      status = await withTimeout(github.prStatus(repo, key), timeoutMs, `pr status #${pr.number}`);
    } catch (e) {
      onFailure?.();
      io.err(`factory: pr status #${pr.number} failed: ${(e as Error).message.slice(0, 200)}\n`);
      needsUpdate = true;
      openDone = true;
      continue;
    }
    if (status.state !== "open") {
      updated.delete(key);
      continue;
    }
    openDone = true;
    if (!status.behind) {
      updated.delete(key);
      continue;
    }
    // Automatic runs merge locally under their normal slot, then run gates and a delta review.
    if (selfMergeRuns(runs, pr).length) continue;
    // A semantic conflict is a question for a person. Retrying update-branch would spin.
    if (conflicted.has(`${repo}#${pr.number}`)) continue;
    // A PR still behind 10 minutes after its last update fell behind again (another PR merged): update it again.
    const last = updated.get(key);
    if ((last !== undefined && Date.now() - last < BEHIND_RETRY_MS) || flight.has(repo)) {
      needsUpdate = true;
      continue;
    }
    const job = github.updateBranch(repo, key);
    const tracked = job.finally(() => {
      if (flight.get(repo) === tracked) flight.delete(repo);
    });
    void tracked.catch(() => undefined);
    flight.set(repo, tracked);
    try {
      await withTimeout(job, timeoutMs, `update-branch #${pr.number}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (updateNeedsDecision(msg)) {
        conflicted.add(`${repo}#${pr.number}`);
        io.err(`factory: update-branch #${pr.number} needs a decision: ${msg.slice(0, 200)}\n`);
        if (!(await stillPending(job))) flight.delete(repo);
        continue;
      }
      onFailure?.();
      io.err(`factory: update-branch #${pr.number} failed: ${msg.slice(0, 200)}\n`);
      needsUpdate = true;
      // Still running: do not start a second update. A settled failure is retried later and does not skip the rest.
      if (await stillPending(job)) break;
      flight.delete(repo);
      continue;
    }
    flight.delete(repo);
    updated.set(key, Date.now());
    needsUpdate = true;
    io.out(`queue: updated PR #${pr.number} (behind)\n`);
  }
  return { needsUpdate, openDone };
}

function track(started: StartedRun, repo: string, issue: number): Tracked {
  const tracked: Tracked = {
    repo,
    issue,
    kill: started.kill,
    unref: started.unref,
    runId: started.runId,
    pid: started.pid,
    ignoreResult: false,
  };
  started.done.then(
    (r) => {
      tracked.settled = r;
    },
    (e: unknown) => {
      tracked.failed = e instanceof Error ? e.message : String(e);
    },
  );
  return tracked;
}

function noteRunId(entry: QueueEntry, tracked: Tracked | undefined): void {
  const id = tracked?.runId();
  if (id) entry.run_id = id;
  if (tracked?.pid) entry.pid = tracked.pid;
}

/**
 * A ticket parked on posted questions starts a FRESH run once its issue is admissible again: a human
 * answered, removed `needs-input` and set `factory-ready`. Read from the open-issue list discovery
 * already fetched; no extra GitHub call. A human pause holds it; a stale label pause is cleared.
 */
function releaseAnswered(q: QueueFile, open: Issue[], repo: string, ctx: TickCtx): void {
  const byNumber = new Map(open.map((i) => [i.number, i]));
  for (const entry of q.entries) {
    if (entry.status !== "parked" || !entry.awaiting_answer?.posted) continue;
    const issue = byNumber.get(entry.issue);
    if (!issue || admissionBlock(issue)) continue;
    const pauseKey = { runId: entry.run_id, repo, issue: entry.issue };
    if (hasRealPause(ctx.factoryHome, pauseKey)) continue;
    clearPause(ctx.factoryHome, pauseKey);
    releaseToPending(entry);
    freshBudgets(entry);
    ctx.io.out(`queue: #${entry.issue} pending (questions answered, fresh run)\n`);
  }
}

/**
 * Entries parked on questions that did not reach the issue: post them again (comment once per run,
 * then the label swap). Network on the snapshot; the caller marks the posted ones under the queue lock.
 */
async function postPendingQuestions(snap: QueueFile, repo: string, ctx: TickCtx, noteFailure: () => void): Promise<Set<number>> {
  const posted = new Set<number>();
  for (const entry of snap.entries) {
    if (entry.status !== "parked" || !entry.awaiting_answer || entry.awaiting_answer.posted || !entry.run_id) continue;
    try {
      const done = await withTimeout(postQuestions(ctx.github, repo, entry.issue, entry.run_id, entry.awaiting_answer.questions), ctx.netTimeoutMs, `questions #${entry.issue}`);
      // Answered before the label swap landed: posted all the same, so the answer releases the entry.
      if (done === "answered") ctx.io.out(`queue: #${entry.issue} answered before the label swap; labels left as they are\n`);
      posted.add(entry.issue);
    } catch (e) {
      noteFailure();
      ctx.io.err(`factory: posting questions on #${entry.issue} failed: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  return posted;
}

/**
 * A failed entry whose issue is admissible again (a human set `factory-ready` and removed `factory-failed`)
 * starts a FRESH run. Only once its failure was reported. Same pause handling as `releaseAnswered`.
 */
function releaseFailed(q: QueueFile, open: Issue[], repo: string, ctx: TickCtx): void {
  const byNumber = new Map(open.map((i) => [i.number, i]));
  for (const entry of q.entries) {
    if (entry.status !== "parked" || !entry.failed) continue;
    if (!entry.failed.reported && (entry.failed.attempts ?? 0) < MAX_REPORT_ATTEMPTS) continue;
    const issue = byNumber.get(entry.issue);
    if (!issue || admissionBlock(issue)) continue;
    const pauseKey = { runId: entry.run_id, repo, issue: entry.issue };
    if (hasRealPause(ctx.factoryHome, pauseKey)) continue;
    clearPause(ctx.factoryHome, pauseKey);
    releaseToPending(entry);
    freshBudgets(entry);
    ctx.io.out(`queue: #${entry.issue} pending (factory-ready again after a failure, fresh run)\n`);
  }
}

/** A human restarted the ticket: a fresh run gets fresh retry budgets. */
function freshBudgets(entry: QueueEntry): void {
  delete entry.requeues;
  delete entry.window_waits;
  delete entry.window_estimated_ms;
}

/** Report attempts per failed entry; after this the worker logs once and stops retrying. */
export const MAX_REPORT_ATTEMPTS = 10;

/**
 * Failed entries whose report did not reach GitHub: post it again (comment once per run, the label
 * swap, then the run's own PR closed when allowed). Network on the snapshot; the caller records the
 * outcome under the queue lock. A failing report is logged; it does not put the worker into backoff.
 */
async function reportPendingFailures(snap: QueueFile, repo: string, ctx: TickCtx): Promise<Map<number, boolean>> {
  const outcome = new Map<number, boolean>();
  for (const entry of snap.entries) {
    if (entry.status !== "parked" || !entry.failed || entry.failed.reported || (entry.failed.attempts ?? 0) >= MAX_REPORT_ATTEMPTS) continue;
    try {
      let st: RunState | undefined;
      try {
        st = entry.run_id ? readState(join(ctx.factoryHome, "runs", entry.run_id)) : undefined;
      } catch {
        st = undefined;
      }
      // The current run's own PR first; `entry.pr` only when its state names none.
      const target = await closableTarget(st, st?.pr ?? entry.pr ?? null, entry.failed.keep_pr === true);
      await withTimeout(
        reportFailure(ctx.github, repo, entry.issue, entry.run_id ?? `issue-${entry.issue}`, entry.reason ?? "failed", target),
        ctx.netTimeoutMs,
        `failure #${entry.issue}`,
      );
      outcome.set(entry.issue, true);
    } catch (e) {
      outcome.set(entry.issue, false);
      ctx.io.err(`factory: reporting the failure on #${entry.issue} failed: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  return outcome;
}

async function discoverReady(q: QueueFile, ctx: TickCtx, repo: string): Promise<void> {
  let list: { issues: Issue[]; complete: boolean };
  try {
    list = await withTimeout(ctx.github.listOpenIssues(repo), ctx.netTimeoutMs, "open issues");
  } catch (e) {
    ctx.netFailed = true;
    ctx.io.err(`factory: open issue list failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return;
  }
  // A short page must not invent tickets that a later page would also contain.
  if (!list.complete) return;
  const known = new Set(q.entries.map((e) => e.issue));
  const at = new Date(ctx.nowMs).toISOString();
  releaseAnswered(q, list.issues, repo, ctx);
  releaseFailed(q, list.issues, repo, ctx);
  for (const issue of list.issues) {
    if (known.has(issue.number) || admissionBlock(issue)) continue;
    q.entries.push({ issue: issue.number, status: "pending", added_at: at });
    known.add(issue.number);
    ctx.io.out(`queue: #${issue.number} discovered\n`);
  }
}

function othersRunning(factoryHome: string, repo: string): number {
  return loadAllQueues(factoryHome)
    .filter((file) => resolve(file.repo) !== resolve(repo))
    .reduce((n, file) => n + file.entries.filter((e) => e.status === "running").length, 0);
}

function repoMaxRuns(repo: string): number {
  try {
    return loadRepoConfig(repo).concurrency.max_runs;
  } catch {
    return 1;
  }
}

async function tickRepo(ctx: TickCtx, repo: string): Promise<boolean> {
  const gitOpts = { timeoutMs: ctx.netTimeoutMs };
  const key = await repoQueueKey(repo, gitOpts);
  if (!loadQueueByKey(ctx.factoryHome, key)) return false;
  const timeoutMs = ctx.netTimeoutMs;

  const noteFailure = () => {
    ctx.netFailed = true;
  };
  await updateQueue(ctx.factoryHome, repo, async (q) => {
    localBookkeeping(q, repo, ctx);
    if (!ctx.holdStarts) await discoverReady(q, ctx, repo);
  }, gitOpts);
  if (!ctx.holdStarts) await scheduleContinuations(ctx, repo);
  const snap = loadQueueByKey(ctx.factoryHome, key);
  if (!snap) return false;

  // A release handoff classifies finished runs and changes nothing else: no unpark, no pause, no
  // update-branch, no approval and no auto-merge while the admission hold is in place.
  const unpark = ctx.releaseHold ? new Set<number>() : unparkReady(snap, ctx.factoryHome);
  const win = await windowWaits(snap, repo, ctx, noteFailure);
  const questionsPosted = ctx.releaseHold ? new Set<number>() : await postPendingQuestions(snap, repo, ctx, noteFailure);
  const failuresReported = ctx.releaseHold ? new Map<number, boolean>() : await reportPendingFailures(snap, repo, ctx);
  const waiting = new Set<number>();
  const parkAfter = new Map<number, string>();
  const evaluatedAfter = new Set<number>();
  for (const entry of snap.entries) {
    if (entry.status !== "pending" || entry.after === undefined) continue;
    evaluatedAfter.add(entry.issue);
    try {
      const gate = await withTimeout(afterGate(entry, snap, ctx.github, repo, ctx.factoryHome), timeoutMs, `after #${entry.after}`);
      if (gate === "wait") waiting.add(entry.issue);
      else if (gate === "park") parkAfter.set(entry.issue, `after #${entry.after} closed without merge`);
    } catch (e) {
      waiting.add(entry.issue);
      noteFailure();
      ctx.io.err(`factory: after #${entry.after} check failed: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }

  const mightStart = !ctx.holdStarts && snap.entries.some((e) => (e.status === "pending" || unpark.has(e.issue)) && !waiting.has(e.issue) && !parkAfter.has(e.issue));
  let blockStart = false;
  let base: BaseGate = { block: false };
  let openPrs: OpenFactoryPr[] | undefined;
  const issueState = new Map<number, "open" | "closed" | "missing" | "error">();
  const issueByNumber = new Map<number, Issue>();
  const pauseFor = new Map<number, string>();
  const clearPauseFor = new Set<number>();
  if (!ctx.releaseHold) {
    for (const entry of snap.entries) {
      if (entry.status !== "running") continue;
      try {
        const issue = await withTimeout(ctx.github.getIssue(repo, entry.issue), timeoutMs, `issue #${entry.issue}`);
        const block = admissionBlock(issue);
        // Closed is the run finishing, not a label pull. A missing ready label pauses in place.
        if (block && block !== "is closed") pauseFor.set(entry.issue, block);
        else if (!block && entry.paused) clearPauseFor.add(entry.issue);
      } catch (e) {
        noteFailure();
        ctx.io.err(`factory: issue #${entry.issue}: ${(e as Error).message.slice(0, 200)}\n`);
      }
    }
  }
  if (mightStart) {
    base = await baseBlocks(ctx.github, repo, ctx.io, ctx.redLogged, timeoutMs, { factoryHome: ctx.factoryHome, repoKey: key, nowMs: ctx.nowMs }, noteFailure);
    blockStart = base.block;
    if (!blockStart) {
      try {
        openPrs = await withTimeout(ctx.github.openFactoryPrFiles(repo), timeoutMs, "open PRs");
      } catch (e) {
        noteFailure();
        ctx.io.err(`factory: open PR list failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
        blockStart = true;
      }
    }
    if (!blockStart) {
      for (const entry of snap.entries) {
        if (entry.status !== "pending" && !unpark.has(entry.issue)) continue;
        if (waiting.has(entry.issue) || parkAfter.has(entry.issue)) continue;
        try {
          const issue = await withTimeout(ctx.github.getIssue(repo, entry.issue), timeoutMs, `issue #${entry.issue}`);
          issueByNumber.set(entry.issue, issue);
          issueState.set(entry.issue, (issue.state ?? "open") === "closed" ? "closed" : "open");
        } catch (e) {
          const msg = (e as Error).message;
          if (/not found/i.test(msg)) issueState.set(entry.issue, "missing");
          else {
            issueState.set(entry.issue, "error");
            noteFailure();
            ctx.io.err(`factory: issue #${entry.issue}: ${msg.slice(0, 200)}\n`);
          }
        }
      }
    }
  }

  const repoMax = repoMaxRuns(repo);
  const toStart = await updateQueue(ctx.factoryHome, repo, (q) => {
    localBookkeeping(q, repo, ctx);
    for (const [issue, reason] of pauseFor) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "running");
      if (!entry) continue;
      entry.paused = true;
      entry.reason = reason;
      requestPause(ctx.factoryHome, { runId: entry.run_id, repo, issue }, reason);
    }
    for (const issue of clearPauseFor) {
      if (pauseFor.has(issue)) continue;
      const entry = q.entries.find((e) => e.issue === issue && e.status === "running" && e.paused);
      if (!entry) continue;
      delete entry.paused;
      delete entry.reason;
      clearPause(ctx.factoryHome, { runId: entry.run_id, repo, issue });
    }
    applyUnpark(q, unpark, ctx.io);
    for (const issue of questionsPosted) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.awaiting_answer && !e.awaiting_answer.posted);
      if (!entry?.awaiting_answer) continue;
      entry.awaiting_answer.posted = true;
      ctx.io.out(`queue: #${issue} questions posted on the issue\n`);
    }
    for (const [issue, ok] of failuresReported) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.failed && !e.failed.reported);
      if (!entry?.failed) continue;
      if (ok) {
        entry.failed.reported = true;
        ctx.io.out(`queue: #${issue} failure reported on the issue\n`);
        continue;
      }
      entry.failed.attempts = (entry.failed.attempts ?? 0) + 1;
      if (entry.failed.attempts >= MAX_REPORT_ATTEMPTS) ctx.io.err(`factory: gave up reporting the failure on #${issue} after ${MAX_REPORT_ATTEMPTS} attempts; set factory-ready again to restart it\n`);
    }
    // Window waits (#177): a far window only moves the next recheck; an opened one becomes pending again.
    for (const issue of win.clearAdmissionPause) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.wait_until !== undefined && ctx.nowMs >= e.wait_until);
      if (!entry || hasRealPause(ctx.factoryHome, { runId: entry.run_id, repo, issue })) continue;
      delete entry.paused;
      clearPause(ctx.factoryHome, { runId: entry.run_id, repo, issue });
    }
    for (const [issue, nextWait] of win.extend) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.wait_until !== undefined && ctx.nowMs >= e.wait_until);
      if (entry) entry.wait_until = nextWait;
    }
    for (const [issue, keepRun] of win.release) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.wait_until !== undefined && ctx.nowMs >= e.wait_until);
      if (!entry) continue;
      releaseToPending(entry, keepRun);
      ctx.io.out(`queue: #${issue} pending (provider usage window ${keepRun ? `resumes ${entry.run_id}` : "reset"})\n`);
    }
    for (const issue of win.refuse) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "parked" && e.wait_until !== undefined && ctx.nowMs >= e.wait_until);
      if (!entry) continue;
      // The wake-up is dropped. The checkpoint, PR and spent repair budgets stay; no second implementation.
      park(entry, `provider window resume refused: stop does not authorize it`, entry.run_id);
      ctx.io.out(`queue: #${issue} parked: ${entry.reason}\n`);
    }
    for (const [issue, reason] of parkAfter) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "pending");
      if (!entry) continue;
      park(entry, reason);
      ctx.io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
    }
    // A cycle has no merged predecessor to wait for. Park once so the worker can go idle.
    const cycles = cycleReasons(q.entries);
    for (const entry of q.entries) {
      if (entry.status !== "pending") continue;
      const reason = cycles.get(entry.issue);
      if (!reason) continue;
      park(entry, reason);
      ctx.io.out(`queue: #${entry.issue} parked: ${reason}\n`);
    }
    const running = q.entries.filter((e) => e.status === "running").length;
    let room = Math.max(0, Math.min(ctx.slots - (othersRunning(ctx.factoryHome, repo) + running), repoMax - running));
    // A red local base check is re-checked by exactly one run, and only while no other run of this repo is going.
    const recheck = base.recheck;
    if (recheck) room = running > 0 ? 0 : Math.min(room, 1);
    for (const entry of q.entries) {
      if (entry.status !== "pending" || entry.bundled_with !== undefined) continue;
      const baseReason = entry.reason?.startsWith(BASE_PROBLEM) === true;
      if (base.problem && (!entry.reason || baseReason || entry.reason === "global coding cap")) entry.reason = base.problem;
      else if (!base.problem && baseReason) delete entry.reason;
    }
    const starts: { issue: number; runId: string; resumeRunId?: string; bundle?: number[]; choice: string }[] = [];
    if (ctx.holdStarts || blockStart || room <= 0) {
      if (!ctx.holdStarts && !blockStart && room <= 0 && running < repoMax) {
        for (const entry of q.entries) {
          if (entry.status === "pending" && entry.after === undefined && !entry.reason && entry.bundled_with === undefined) entry.reason = "global coding cap";
        }
      }
      return starts;
    }
    const candidates: QueueEntry[] = [];
    for (const entry of q.entries) {
      if (entry.status !== "pending" || waiting.has(entry.issue) || entry.bundled_with !== undefined) continue;
      if (entry.after !== undefined && !evaluatedAfter.has(entry.issue)) continue;
      const tracked = ctx.handles.get(handleKey(repo, entry.issue));
      if (tracked && tracked.settled === undefined && !tracked.failed && !tracked.ignoreResult) continue;
      const state = issueState.get(entry.issue);
      if (!state) continue;
      if (state === "closed") {
        park(entry, "issue closed");
        ctx.io.out(`queue: #${entry.issue} parked: issue closed\n`);
        continue;
      }
      if (state === "missing") {
        park(entry, "issue not found");
        ctx.io.out(`queue: #${entry.issue} parked: issue not found\n`);
        continue;
      }
      if (state === "error") continue;
      const hit = openPrs?.find((p) => factoryIssueOfBranch(p.branch) === entry.issue);
      if (hit && !canResume(ctx.factoryHome, entry, issueByNumber.get(entry.issue)!)) {
        park(entry, `open factory PR #${hit.number}`);
        // Re-checked every tick (`blocked_by`): once that PR is merged or closed the ticket starts, e.g.
        // after a failed run left its PR open for a person.
        entry.blocked_by = [hit.number];
        ctx.io.out(`queue: #${entry.issue} parked: open factory PR #${hit.number}\n`);
        continue;
      }
      const issue = issueByNumber.get(entry.issue);
      if (!issue) continue;
      const block = admissionBlock(issue);
      if (block) {
        entry.reason = block;
        continue;
      }
      delete entry.reason;
      candidates.push(entry);
    }
    const ranked = rankPending(
      candidates.map((entry) => {
        return {
          issue: entry.issue,
          addedAt: entry.added_at,
          index: q.entries.indexOf(entry),
          priority: priorityRank(issueByNumber.get(entry.issue)?.labels ?? []),
        };
      }),
      ctx.nowMs,
    );
    const skip = new Set<number>();
    const names = resourceNames(repo);
    const bodies = [...issueByNumber.values()].map((issue) => ({ number: issue.number, body: issue.body }));
    for (const choice of ranked) {
      if (room <= 0) break;
      if (skip.has(choice.issue)) continue;
      const entry = q.entries.find((e) => e.issue === choice.issue && e.status === "pending");
      const issue = entry ? issueByNumber.get(entry.issue) : undefined;
      if (!entry || !issue) continue;
      const resume = canResume(ctx.factoryHome, entry, issue);
      // Pause is not only a scheduling filter. An already pending continuation must not take a slot
      // or edit product. The marker stays until a human clears it. Other runs are not signalled.
      if (resume && pauseRequested(ctx.factoryHome, { runId: entry.run_id, repo, issue: entry.issue })) continue;
      if (resume && ((entry.window_waits ?? 0) > 0 || (entry.window_estimated_ms ?? 0) > 0) && !windowResumeAuthorized(ctx.factoryHome, entry.run_id)) {
        park(entry, `provider window resume refused: stop does not authorize it`, entry.run_id);
        ctx.io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
        continue;
      }
      const plannedId = resume && entry.run_id ? entry.run_id : newRunId(ctx.nowMs);
      if (!resume) {
        delete entry.run_id;
        delete entry.issue_rev;
      }
      const claimed = claimResources(ctx.factoryHome, names, plannedId);
      if (!claimed.ok) {
        entry.reason = `resource ${claimed.held.name} held by run ${claimed.held.runId ?? "?"} (pid ${claimed.held.pid})`;
        continue;
      }
      const partners = mutualBundle(bodies, entry.issue).filter((n) => {
        const extra = q.entries.find((e) => e.issue === n && e.status === "pending" && e.bundled_with === undefined);
        const extraIssue = issueByNumber.get(n);
        return Boolean(extra) && !waiting.has(n) && !parkAfter.has(n) && extraIssue !== undefined && !admissionBlock(extraIssue);
      });
      for (const n of partners) {
        const extra = q.entries.find((e) => e.issue === n);
        if (!extra) continue;
        extra.bundled_with = entry.issue;
        delete extra.reason;
        skip.add(n);
      }
      entry.status = "running";
      delete entry.reason;
      delete entry.pid;
      delete entry.paused;
      entry.run_id = plannedId;
      entry.issue_rev = issueRevision(issue.title, issue.body);
      entry.release_id = ctx.release.id;
      entry.choice = choice.choice;
      starts.push({
        issue: entry.issue,
        runId: plannedId,
        choice: choice.choice,
        ...(resume ? { resumeRunId: plannedId } : {}),
        ...(partners.length ? { bundle: partners } : {}),
      });
      room -= 1;
    }
    // The re-check window restarts now, so later ticks wait for this run's own base check.
    // Only a fresh start runs the base check; a resume does not, so it does not advance the backoff.
    if (recheck && starts.some((s) => !s.resumeRunId)) writeBaseCheck(ctx.factoryHome, key, { ...recheck, at: new Date(ctx.nowMs).toISOString(), rechecks: (recheck.rechecks ?? 0) + 1 });
    const runningNow = q.entries.filter((e) => e.status === "running").length;
    const globalLeft = ctx.slots - (othersRunning(ctx.factoryHome, repo) + runningNow);
    if (globalLeft <= 0 && runningNow < repoMax) {
      for (const entry of q.entries) {
        if (entry.status === "pending" && entry.after === undefined && !entry.reason && entry.bundled_with === undefined) entry.reason = "global coding cap";
      }
    }
    return starts;
  }, gitOpts);

  for (const planned of toStart) {
    let started: StartedRun;
    try {
      started = ctx.start({
        repo,
        issue: planned.issue,
        factoryHome: ctx.factoryHome,
        runId: planned.runId,
        resumeRunId: planned.resumeRunId,
        bundle: planned.bundle,
      });
    } catch (e) {
      const msg = (e as Error).message;
      releaseResourceClaims(ctx.factoryHome, resourceNames(repo), planned.runId);
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === planned.issue && en.status === "running");
        if (!entry) return;
        releaseBundle(q, entry.issue);
        requeueOrFail(q, entry, msg, planned.resumeRunId !== undefined);
      }, gitOpts);
      ctx.io.out(`queue: #${planned.issue} start failed: ${msg}\n`);
      continue;
    }
    ctx.handles.set(handleKey(repo, planned.issue), track(started, repo, planned.issue));
    ctx.io.out(`queue: #${planned.issue} started (${planned.choice})\n`);
    if (started.pid) {
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === planned.issue && en.status === "running");
        if (entry) entry.pid = started.pid;
      }, gitOpts);
    }
  }
  const watch: BehindWatch = ctx.releaseHold
    ? { needsUpdate: false, openDone: false }
    : await updateBehind(ctx.github, repo, ctx.factoryHome, ctx.behindUpdated, ctx.behindFlight, ctx.behindConflict, ctx.io, timeoutMs, noteFailure);
  const waitingMerge = ctx.releaseHold ? false : await enableReadyMerges(ctx.github, repo, ctx.factoryHome, ctx.mergeEnabled, ctx.io, timeoutMs, noteFailure);
  const q = loadQueueByKey(ctx.factoryHome, key);
  if (!q) return false;
  const pending = q.entries.some((e) => e.status === "pending");
  const running = q.entries.some((e) => e.status === "running");
  const overlap = q.entries.some((e) => e.status === "parked" && (e.blocked_runs?.length ?? 0) > 0);
  // A window wait keeps the worker on its poll cadence until the wake-up is released or dropped.
  // A due wait (window already open, or paused past it) still waits for the next tick — not a busy poll.
  const windowWait = q.entries.some((e) => e.status === "parked" && e.wait_until !== undefined);
  const live = [...ctx.handles.values()].some((h) => resolve(h.repo) === resolve(repo) && h.settled === undefined && !h.failed && !h.ignoreResult);
  if (!ctx.holdStarts && !ctx.releaseHold) {
    try {
      await advanceMergeBatch({ factoryHome: ctx.factoryHome, github: ctx.github, repo, io: ctx.io });
    } catch (e) {
      noteFailure();
      ctx.io.err(`factory: merge batch (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  if (ctx.pastUntil) return running || live;
  const behind = watch.needsUpdate || (ctx.untilMs !== undefined && (watch.openDone || waitingMerge));
  return pending || running || overlap || live || behind || windowWait || batchBusy(ctx.factoryHome, repo);
}

async function reposFor(opts: RunQueueOptions): Promise<string[]> {
  if (opts.repo) return [resolve(opts.repo)];
  return loadAllQueues(opts.factoryHome).map((q) => q.repo);
}

/** A coding run still in this process, or a queue row that is still `running`. CI waits are not active. */
function activeCoding(factoryHome: string, handles: Map<string, Tracked>): boolean {
  for (const h of handles.values()) {
    if (h.settled === undefined && !h.failed && !h.ignoreResult) return true;
  }
  return loadAllQueues(factoryHome).some((q) => q.entries.some((e) => e.status === "running"));
}

/**
 * One worker. Fills slots in queue order, classifies `result.json` when a run ends, updates behind PRs.
 * A stall keeps the slot until the process exits (SIGKILL after a grace period).
 * Stops when nothing is pending, running, or behind (overlap parks keep polling until the blocking run ends).
 * With `untilMs`, also stays until that time while an open factory PR is behind or waiting for auto-merge;
 * at `untilMs` live runs finish and the worker exits. `stay` keeps polling with backoff when idle.
 * Pause and drain start nothing. Drain exits once no coding run is left. A second worker is refused.
 * Stop exits at the next tick and does not signal a live run. A suspend gap uses the run watchdog's slack.
 */
export async function runQueue(opts: RunQueueOptions): Promise<void> {
  const io = opts.io ?? { out: () => {}, err: () => {} };
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const slots = opts.slots ?? DEFAULT_SLOTS;
  const netTimeoutMs = opts.netTimeoutMs ?? WORKER_CALL_TIMEOUT_MS;
  const random = opts.random ?? Math.random;
  const handles = new Map<string, Tracked>();
  const stall = new Map<string, StallWatch>();
  const terminating = new Map<string, Terminating>();
  const behindUpdated = new Map<string, number>();
  const behindFlight = new Map<string, Promise<unknown>>();
  const redLogged = new Set<string>();
  const mergeEnabled = new Set<string>();
  const behindConflict = new Set<string>();
  const release = opts.release ?? executingRelease();
  const dir = queueDir(opts.factoryHome);
  mkdirSync(dir, { recursive: true });
  const held = await tryPathLock(
    join(dir, "worker.lock"),
    "queue-worker",
    async () => {
      // Names this pid and release, so a handoff can prove which worker owns the queue.
      publishWorkerIdentity(opts.factoryHome, release);
      let lastTick = now();
      let streak = 0;
      try {
        while (!opts.signal?.aborted) {
          const mode = readWorkerMode(opts.factoryHome);
          if (mode === "stop") {
            // Consumed, so the next start is a normal worker. Do not signal runs.
            clearWorkerMode(opts.factoryHome);
            io.out("queue: stopped\n");
            return;
          }
          const t = now();
          // A gap much larger than the tick is a suspend (laptop sleep), not agent silence. Same slack as the run watchdog.
          const jumped = t - lastTick > poll + suspendSlackMs(poll);
          lastTick = t;
          const pastUntil = opts.untilMs !== undefined && t >= opts.untilMs;
          // A release handoff holds admissions in its own file; the operator's pause/drain stays as it is.
          const heldAdmission = admissionHold(opts.factoryHome);
          const holdStarts = pastUntil || mode === "pause" || mode === "drain" || heldAdmission !== undefined;
          const holdMutations = heldAdmission !== undefined;
          const repos = await reposFor(opts);
          let cont = false;
          let failed = false;
          for (const repo of repos) {
            const tick: TickCtx = {
              factoryHome: opts.factoryHome,
              github: opts.github,
              slots,
              untilMs: opts.untilMs,
              pastUntil,
              holdStarts,
              releaseHold: holdMutations,
              netFailed: false,
              nowMs: t,
              jumped,
              netTimeoutMs,
              start: opts.start,
              io,
              handles,
              stall,
              terminating,
              behindUpdated,
              behindFlight,
              redLogged,
              mergeEnabled,
              behindConflict,
              release,
            };
            try {
              const busy = await tickRepo(tick, repo);
              if (busy) cont = true;
              if (tick.netFailed) failed = true;
            } catch (e) {
              failed = true;
              io.err(`factory: queue tick failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
              cont = true;
            }
          }
          // Drain keeps queued issues and CI waits on disk. It leaves once coding runs are done.
          // A handoff drain asks the worker being replaced to leave. The target release stays up.
          const handoffReplacesThis = heldAdmission?.state === "drain" && heldAdmission.target_release !== release.id;
          if ((mode === "drain" || handoffReplacesThis) && !activeCoding(opts.factoryHome, handles)) {
            io.out(heldAdmission ? `queue: drained for ${heldAdmission.tx}\n` : "queue: drained\n");
            return;
          }
          if (!cont) {
            if (pastUntil) {
              io.out("queue: until reached\n");
              return;
            }
            if (mode !== "pause" && !opts.stay) {
              io.out("queue: idle\n");
              return;
            }
          }
          const backOff = failed || (!cont && (mode === "pause" || Boolean(opts.stay)));
          if (backOff) streak += 1;
          else streak = 0;
          await sleep(backOff ? nextPollMs(poll, streak, random) : poll, opts.signal).catch(() => undefined);
        }
        io.out("queue: stopped\n");
      } finally {
        for (const h of handles.values()) h.unref();
        clearWorkerIdentity(opts.factoryHome);
      }
    },
    { waitMs: 0 },
  );
  if (!held.ok) throw new Error("a queue worker is already running");
}
