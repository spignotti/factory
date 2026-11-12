import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realSleep, type Sleep } from "../agents/fake-runner.js";
import { EventLog, ResultSchema, type RunResult } from "../events.js";
import type { GitHub, Issue, OpenFactoryPr, PrStatus } from "../gh.js";
import { baseRef, revParse } from "../git.js";
import { activeHolders, claimResources, releaseResourceClaims, tryPathLock } from "../pipeline/lock.js";
import { mayEnableAutoMerge, selfMergePolicy, waitingOnMergeCi } from "../pipeline/merge-ready.js";
import { saveState } from "../pipeline/state.js";
import { deliveryForDone } from "../pipeline/outcome.js";
import { newRunId } from "../pipeline/run.js";
import { MAX_CONTINUATIONS } from "../pipeline/recovery.js";
import { suspendSlackMs } from "../pipeline/watchdog.js";
import { listRuns, type RunRecord } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import type { Io } from "../commands/gates.js";
import { admissionBlock, cycleReasons, fulfilledIssues, issueRevision, mutualBundle, priorityRank, rankPending, updateNeedsDecision } from "./admit.js";
import { clearWorkerMode, readWorkerMode } from "./control.js";
import { clearPause, pauseRequested, requestPause } from "./pause.js";
import { loadAllQueues, loadQueueByKey, queueDir, repoQueueKey, type QueueEntry, type QueueFile, updateQueue } from "./store.js";

/** Transient `needs_human` goes to the back at most this many times, then parks. */
export const MAX_REQUEUES = 2;
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

/** PR numbers in `planned paths overlap open factory PR #12 (…)`. Empty when this lock is not that case. */
export function overlapPrNumbers(reason: string): number[] {
  if (!/overlap open factory PR/i.test(reason)) return [];
  const nums = new Set<number>();
  for (const m of reason.matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
  return [...nums];
}

/** Run ids in `planned paths overlap active runs: <id> (…)` / `… overlap another factory run: <id> …`. */
export function overlapRunIds(reason: string): string[] {
  if (!/overlap (active runs|another factory run)/i.test(reason)) return [];
  return [...new Set(reason.match(/\b\d{8}-\d{6}-[0-9a-f]{6}\b/g) ?? [])];
}

/** `repo … is locked by run …`: the slot was still held. Not an open-PR overlap. */
export function isRepoLockHeld(reason: string): boolean {
  return /\bis locked by\b/i.test(reason);
}

/** Transient stop is the run's flag, not the reason text (a stream abort does not start with `transient`). */
export function isTransientNeedsHuman(result: RunResult, stateTransient = false): boolean {
  if (result.result !== "needs_human") return false;
  return stateTransient || (result as { transient?: boolean }).transient === true;
}

function transientStop(factoryHome: string, result: RunResult): boolean {
  if (isTransientNeedsHuman(result)) return true;
  const run = listRuns(factoryHome).find((r) => r.run_id === result.run_id);
  if (!run) return false;
  return run.state?.transient === true || (run.result as { transient?: boolean } | undefined)?.transient === true;
}

function park(entry: QueueEntry, reason: string, runId?: string, blocked?: number[], blockedRuns?: string[]): void {
  entry.status = "parked";
  entry.reason = reason;
  if (runId) entry.run_id = runId;
  if (blocked?.length) entry.blocked_by = blocked;
  else delete entry.blocked_by;
  if (blockedRuns?.length) entry.blocked_runs = blockedRuns;
  else delete entry.blocked_runs;
  delete entry.pid;
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
  }
  delete entry.blocked_by;
  delete entry.blocked_runs;
  delete entry.pid;
  delete entry.paused;
  delete entry.choice;
}

/** `done` records the PR. Transient `needs_human` requeues. Overlap `locked` parks on the PR numbers. A repo-lock `locked` goes back to pending. Everything else parks. */
export function applyOutcome(q: QueueFile, entry: QueueEntry, result: RunResult, opts?: { transient?: boolean }): "done" | "requeue" | "parked" {
  entry.run_id = result.run_id;
  if (result.pr) entry.pr = result.pr;
  delete entry.pid;
  if (result.result === "done") {
    entry.status = "done";
    entry.delivery = deliveryForDone(result);
    delete entry.reason;
    delete entry.blocked_by;
    return "done";
  }
  if (isTransientNeedsHuman(result, opts?.transient === true)) {
    const n = (entry.requeues ?? 0) + 1;
    entry.requeues = n;
    if (n <= MAX_REQUEUES) {
      releaseToPending(entry);
      moveToEnd(q, entry);
      return "requeue";
    }
    park(entry, result.reason, result.run_id);
    return "parked";
  }
  if (result.result === "locked") {
    const blocked = overlapPrNumbers(result.reason);
    if (blocked.length) {
      park(entry, result.reason || result.result, result.run_id, blocked);
      return "parked";
    }
    // A live run claims these paths: wait for it to finish instead of parking for the night.
    const runs = overlapRunIds(result.reason);
    if (runs.length) {
      park(entry, result.reason, result.run_id, undefined, runs);
      return "parked";
    }
    if (isRepoLockHeld(result.reason)) {
      releaseToPending(entry);
      return "requeue";
    }
  }
  park(entry, result.reason || result.result, result.run_id);
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

/** Review lines count as evidenced. Other lines count when a handoff recorded evidence for them. */
function evidencedIds(factoryHome: string, runId: string): Set<string> {
  const dir = join(factoryHome, "runs", runId);
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as { acceptance?: { id: string; verify?: string }[] };
  const ids = new Set<string>();
  for (const row of plan.acceptance ?? []) if (row.verify === "review" && row.id) ids.add(row.id);
  try {
    const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { handoffs?: { evidence?: { acceptance_id?: string }[] }[] };
    for (const handoff of st.handoffs ?? []) for (const ev of handoff.evidence ?? []) if (ev.acceptance_id) ids.add(ev.acceptance_id);
  } catch {
    // no state yet: review lines above still count
  }
  return ids;
}

function settleBundle(q: QueueFile, entry: QueueEntry, factoryHome: string, io: Io): void {
  const extras = q.entries.filter((e) => e.bundled_with === entry.issue);
  if (!extras.length) return;
  let met = new Set<number>();
  if (entry.run_id) {
    try {
      const plan = JSON.parse(readFileSync(join(factoryHome, "runs", entry.run_id, "plan.json"), "utf8")) as { acceptance?: { id: string; text: string }[] };
      met = new Set(fulfilledIssues({ acceptance: plan.acceptance ?? [] }, evidencedIds(factoryHome, entry.run_id)));
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

function finishEntry(q: QueueFile, entry: QueueEntry, factoryHome: string, result: RunResult, transient: boolean, io: Io): ReturnType<typeof applyOutcome> {
  releaseEntryResources(factoryHome, q.repo, entry);
  const action = applyOutcome(q, entry, result, { transient });
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

function adopt(q: QueueFile, factoryHome: string, handles: Map<string, Tracked>): void {
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
        finishEntry(q, entry, factoryHome, finished, own.state?.transient === true || transientStop(factoryHome, finished), { out: () => {}, err: () => {} });
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
      finishEntry(q, entry, factoryHome, finished, transientStop(factoryHome, finished), { out: () => {}, err: () => {} });
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
      park(entry, "run ended without result.json", entry.run_id);
    }
  }
}

function absorbHandles(q: QueueFile, handles: Map<string, Tracked>, io: Io, factoryHome: string): void {
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
      park(entry, tracked.failed);
      io.out(`queue: #${entry.issue} parked: ${tracked.failed}\n`);
      continue;
    }
    if (!tracked.settled) continue;
    const action = finishEntry(q, entry, factoryHome, tracked.settled, transientStop(factoryHome, tracked.settled), io);
    if (action === "done") io.out(`queue: #${entry.issue} done${entry.pr ? ` ${entry.pr}` : ""}\n`);
    else if (action === "requeue" && tracked.settled.result === "locked") io.out(`queue: #${entry.issue} pending (repo lock held)\n`);
    else if (action === "requeue") io.out(`queue: #${entry.issue} requeued (${entry.requeues}/${MAX_REQUEUES})\n`);
    else io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
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
  park(entry, reason, entry.run_id);
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
  absorbHandles(q, ctx.handles, ctx.io, ctx.factoryHome);
  adopt(q, ctx.factoryHome, ctx.handles);
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

async function unparkReady(q: QueueFile, github: GitHub, repo: string, io: Io, timeoutMs: number, factoryHome: string, onFailure?: () => void): Promise<Set<number>> {
  const ready = new Set<number>();
  const finished = new Set(listRuns(factoryHome).filter((r) => r.result).map((r) => r.run_id));
  for (const entry of q.entries) {
    if (entry.status === "parked" && entry.blocked_runs?.length) {
      if (entry.blocked_runs.every((id) => finished.has(id))) ready.add(entry.issue);
      continue;
    }
    if (entry.status !== "parked" || !entry.blocked_by?.length) continue;
    try {
      const states = await Promise.all(entry.blocked_by.map((n) => withTimeout(github.prStatus(repo, String(n)), timeoutMs, `pr status #${n}`)));
      if (states.every((s) => s.state === "merged" || s.state === "closed")) ready.add(entry.issue);
    } catch (e) {
      onFailure?.();
      io.err(`factory: blocking PR status failed for #${entry.issue}: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  return ready;
}

function applyUnpark(q: QueueFile, ready: Set<number>, io: Io): void {
  for (const entry of q.entries) {
    if (!ready.has(entry.issue) || entry.status !== "parked" || !(entry.blocked_by?.length || entry.blocked_runs?.length)) continue;
    const byRun = (entry.blocked_runs?.length ?? 0) > 0;
    releaseToPending(entry, true);
    io.out(`queue: #${entry.issue} pending (${byRun ? "overlapping run finished" : "blocking PR closed"})\n`);
  }
}

/** Red base CI, or a check we could not read: start nothing for this repo this tick. */
async function baseBlocks(github: GitHub, repo: string, io: Io, redLogged: Set<string>, timeoutMs: number, onFailure?: () => void): Promise<boolean> {
  try {
    const cfg = loadRepoConfig(repo);
    const gitOpts = { timeoutMs };
    const sha = await revParse(repo, await baseRef(repo, cfg.base_branch, gitOpts), gitOpts);
    const status = await withTimeout(github.baseStatus(repo, sha), timeoutMs, "base CI");
    if (status !== "red") {
      redLogged.delete(repo);
      return false;
    }
    if (!redLogged.has(repo)) io.err(`factory: base CI red, not starting (${repo})\n`);
    redLogged.add(repo);
    return true;
  } catch (e) {
    onFailure?.();
    io.err(`factory: base CI check failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return true;
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
    if (!st.continuation && (run.result.result !== "done" || !selfMergePolicy(run.result.merge_policy))) continue;
    const entry = q.entries.find((e) => e.run_id === run.run_id);
    if (!entry || entry.status === "running" || entry.status === "pending" || !entry.issue_rev) continue;
    if (pauseRequested(ctx.factoryHome, { runId: run.run_id })) continue;
    if (!existsSync(st.worktree) || !existsSync(join(run.dir, "plan.json"))) continue;
    try {
      const status = await withTimeout(ctx.github.prStatus(repo, st.pr), ctx.netTimeoutMs, "continuation PR");
      if (status.state !== "open") continue;
      const head = await withTimeout(ctx.github.findOpenPr(repo, st.branch), ctx.netTimeoutMs, "continuation head");
      if (!head?.headSha || head.url !== st.pr) continue;
      const kind = st.continuation?.kind ?? (head.headSha !== st.approved_sha ? "head" : status.behind ? "base" : status.ci === "red" ? "ci" : undefined);
      if (!kind) continue;
      await withTimeout(ctx.github.disableAutoMerge(repo, st.pr), ctx.netTimeoutMs, "disable stale approval");
      if ((st.continuation_attempts ?? 0) >= MAX_CONTINUATIONS) {
        await updateQueue(ctx.factoryHome, repo, (queue) => {
          const own = queue.entries.find((e) => e.run_id === run.run_id);
          if (own) park(own, `post-push repair exhausted (${MAX_CONTINUATIONS}/${MAX_CONTINUATIONS}); factory resume ${run.run_id}`);
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

  const unpark = await unparkReady(snap, ctx.github, repo, ctx.io, timeoutMs, ctx.factoryHome, noteFailure);
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
  let openPrs: OpenFactoryPr[] | undefined;
  const issueState = new Map<number, "open" | "closed" | "missing" | "error">();
  const issueByNumber = new Map<number, Issue>();
  const pauseFor = new Map<number, string>();
  const clearPauseFor = new Set<number>();
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
  if (mightStart) {
    blockStart = await baseBlocks(ctx.github, repo, ctx.io, ctx.redLogged, timeoutMs, noteFailure);
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
      candidates.map((entry) => ({
        issue: entry.issue,
        addedAt: entry.added_at,
        index: q.entries.indexOf(entry),
        priority: priorityRank(issueByNumber.get(entry.issue)?.labels ?? []),
      })),
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
        park(entry, msg);
      }, gitOpts);
      ctx.io.out(`queue: #${planned.issue} parked: ${msg}\n`);
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
  const watch = await updateBehind(ctx.github, repo, ctx.factoryHome, ctx.behindUpdated, ctx.behindFlight, ctx.behindConflict, ctx.io, timeoutMs, noteFailure);
  const waitingMerge = await enableReadyMerges(ctx.github, repo, ctx.factoryHome, ctx.mergeEnabled, ctx.io, timeoutMs, noteFailure);
  const q = loadQueueByKey(ctx.factoryHome, key);
  if (!q) return false;
  const pending = q.entries.some((e) => e.status === "pending");
  const running = q.entries.some((e) => e.status === "running");
  const overlap = q.entries.some((e) => e.status === "parked" && ((e.blocked_by?.length ?? 0) > 0 || (e.blocked_runs?.length ?? 0) > 0));
  const live = [...ctx.handles.values()].some((h) => resolve(h.repo) === resolve(repo) && h.settled === undefined && !h.failed && !h.ignoreResult);
  if (ctx.pastUntil) return running || live;
  const behind = watch.needsUpdate || (ctx.untilMs !== undefined && (watch.openDone || waitingMerge));
  return pending || running || overlap || live || behind;
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
 * Stops when nothing is pending, running, or behind (overlap parks keep polling until the blocking PR closes).
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
  const dir = queueDir(opts.factoryHome);
  mkdirSync(dir, { recursive: true });
  const held = await tryPathLock(
    join(dir, "worker.lock"),
    "queue-worker",
    async () => {
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
          const holdStarts = pastUntil || mode === "pause" || mode === "drain";
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
          if (mode === "drain" && !activeCoding(opts.factoryHome, handles)) {
            io.out("queue: drained\n");
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
      }
    },
    { waitMs: 0 },
  );
  if (!held.ok) throw new Error("a queue worker is already running");
}
