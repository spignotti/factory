import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realSleep, type Sleep } from "../agents/fake-runner.js";
import { ResultSchema, type RunResult } from "../events.js";
import type { GitHub, OpenFactoryPr, PrStatus } from "../gh.js";
import { baseRef, revParse } from "../git.js";
import { activeHolders, tryPathLock } from "../pipeline/lock.js";
import { suspendSlackMs } from "../pipeline/watchdog.js";
import { listRuns, type RunRecord } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import type { Io } from "../commands/gates.js";
import { loadAllQueues, loadQueueByKey, queueDir, repoQueueKey, type QueueEntry, type QueueFile, updateQueue } from "./store.js";

/** Transient `needs_human` goes to the back at most this many times, then parks. */
export const MAX_REQUEUES = 2;
/** A run whose `events.jsonl` has not grown for `stall_minutes` times this is killed. */
const STALL_FACTOR = 2;
/** After SIGTERM, SIGKILL the process group if it is still alive. Slot stays taken until then. */
export const STALL_KILL_GRACE_MS = 60_000;
export const DEFAULT_SLOTS = 2;
const DEFAULT_POLL_MS = 15_000;
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

function park(entry: QueueEntry, reason: string, runId?: string, blocked?: number[]): void {
  entry.status = "parked";
  entry.reason = reason;
  if (runId) entry.run_id = runId;
  if (blocked?.length) entry.blocked_by = blocked;
  else delete entry.blocked_by;
  delete entry.pid;
}

function moveToEnd(q: QueueFile, entry: QueueEntry): void {
  const i = q.entries.indexOf(entry);
  if (i >= 0) q.entries.splice(i, 1);
  q.entries.push(entry);
}

function releaseToPending(entry: QueueEntry): void {
  entry.status = "pending";
  delete entry.reason;
  delete entry.run_id;
  delete entry.blocked_by;
  delete entry.pid;
}

/** `done` records the PR. Transient `needs_human` requeues. Overlap `locked` parks on the PR numbers. A repo-lock `locked` goes back to pending. Everything else parks. */
export function applyOutcome(q: QueueFile, entry: QueueEntry, result: RunResult, opts?: { transient?: boolean }): "done" | "requeue" | "parked" {
  entry.run_id = result.run_id;
  if (result.pr) entry.pr = result.pr;
  delete entry.pid;
  if (result.result === "done") {
    entry.status = "done";
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
        applyOutcome(q, entry, finished, { transient: own.state?.transient === true || transientStop(factoryHome, finished) });
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
      applyOutcome(q, entry, finished, { transient: transientStop(factoryHome, finished) });
      continue;
    }
    if (!entry.run_id && !pidLive) {
      // Recorded running, but the child never created a run. Put it back instead of parking.
      entry.status = "pending";
      delete entry.pid;
      continue;
    }
    if (entry.run_id && !holders.has(entry.run_id) && !pidLive) park(entry, "run ended without result.json", entry.run_id);
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
      park(entry, tracked.failed);
      io.out(`queue: #${entry.issue} parked: ${tracked.failed}\n`);
      continue;
    }
    if (!tracked.settled) continue;
    const action = applyOutcome(q, entry, tracked.settled, { transient: transientStop(factoryHome, tracked.settled) });
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

async function unparkReady(q: QueueFile, github: GitHub, repo: string, io: Io, timeoutMs: number): Promise<Set<number>> {
  const ready = new Set<number>();
  for (const entry of q.entries) {
    if (entry.status !== "parked" || !entry.blocked_by?.length) continue;
    try {
      const states = await Promise.all(entry.blocked_by.map((n) => withTimeout(github.prStatus(repo, String(n)), timeoutMs, `pr status #${n}`)));
      if (states.every((s) => s.state === "merged" || s.state === "closed")) ready.add(entry.issue);
    } catch (e) {
      io.err(`factory: blocking PR status failed for #${entry.issue}: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  return ready;
}

function applyUnpark(q: QueueFile, ready: Set<number>, io: Io): void {
  for (const entry of q.entries) {
    if (!ready.has(entry.issue) || entry.status !== "parked" || !entry.blocked_by?.length) continue;
    releaseToPending(entry);
    io.out(`queue: #${entry.issue} pending (blocking PR closed)\n`);
  }
}

/** Red base CI, or a check we could not read: start nothing for this repo this tick. */
async function baseBlocks(github: GitHub, repo: string, io: Io, redLogged: Set<string>, timeoutMs: number): Promise<boolean> {
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
    io.err(`factory: base CI check failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return true;
  }
}

function slotCap(repo: string, slots: number): number {
  try {
    return Math.min(slots, loadRepoConfig(repo).concurrency.max_runs);
  } catch {
    return Math.min(slots, 1);
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

/**
 * Every behind `factory/*` PR whose run ended `done`, one `update-branch` at a time.
 * A failure is logged and left for a later tick; it does not skip the rest of the list.
 */
const BEHIND_RETRY_MS = 10 * 60_000;

async function updateBehind(github: GitHub, repo: string, factoryHome: string, updated: Map<string, number>, flight: Map<string, Promise<unknown>>, io: Io, timeoutMs: number): Promise<BehindWatch> {
  let prs: OpenFactoryPr[];
  try {
    prs = await withTimeout(github.openFactoryPrFiles(repo), timeoutMs, "open PRs");
  } catch (e) {
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
      io.err(`factory: update-branch #${pr.number} failed: ${(e as Error).message.slice(0, 200)}\n`);
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

async function tickRepo(ctx: TickCtx, repo: string): Promise<boolean> {
  const gitOpts = { timeoutMs: ctx.netTimeoutMs };
  const key = await repoQueueKey(repo, gitOpts);
  if (!loadQueueByKey(ctx.factoryHome, key)) return false;
  const cap = slotCap(repo, ctx.slots);
  const timeoutMs = ctx.netTimeoutMs;

  await updateQueue(ctx.factoryHome, repo, (q) => {
    localBookkeeping(q, repo, ctx);
  }, gitOpts);
  const snap = loadQueueByKey(ctx.factoryHome, key);
  if (!snap) return false;

  const unpark = await unparkReady(snap, ctx.github, repo, ctx.io, timeoutMs);
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
      ctx.io.err(`factory: after #${entry.after} check failed: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }

  const mightStart = !ctx.pastUntil && snap.entries.some((e) => (e.status === "pending" || unpark.has(e.issue)) && !waiting.has(e.issue) && !parkAfter.has(e.issue));
  let blockStart = false;
  let openPrs: OpenFactoryPr[] | undefined;
  const issueState = new Map<number, "open" | "closed" | "missing" | "error">();
  if (mightStart) {
    blockStart = await baseBlocks(ctx.github, repo, ctx.io, ctx.redLogged, timeoutMs);
    if (!blockStart) {
      try {
        openPrs = await withTimeout(ctx.github.openFactoryPrFiles(repo), timeoutMs, "open PRs");
      } catch (e) {
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
          issueState.set(entry.issue, (issue.state ?? "open") === "closed" ? "closed" : "open");
        } catch (e) {
          const msg = (e as Error).message;
          if (/not found/i.test(msg)) issueState.set(entry.issue, "missing");
          else {
            issueState.set(entry.issue, "error");
            ctx.io.err(`factory: issue #${entry.issue}: ${msg.slice(0, 200)}\n`);
          }
        }
      }
    }
  }

  const toStart = await updateQueue(ctx.factoryHome, repo, (q) => {
    localBookkeeping(q, repo, ctx);
    applyUnpark(q, unpark, ctx.io);
    for (const [issue, reason] of parkAfter) {
      const entry = q.entries.find((e) => e.issue === issue && e.status === "pending");
      if (!entry) continue;
      park(entry, reason);
      ctx.io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
    }
    const running = q.entries.filter((e) => e.status === "running").length;
    let room = Math.max(0, cap - running);
    const starts: number[] = [];
    if (ctx.pastUntil || blockStart || room <= 0) return starts;
    for (const entry of q.entries) {
      if (room <= 0) break;
      if (entry.status !== "pending" || waiting.has(entry.issue)) continue;
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
      if (hit) {
        park(entry, `open factory PR #${hit.number}`);
        ctx.io.out(`queue: #${entry.issue} parked: open factory PR #${hit.number}\n`);
        continue;
      }
      entry.status = "running";
      delete entry.reason;
      delete entry.pid;
      starts.push(entry.issue);
      room -= 1;
    }
    return starts;
  }, gitOpts);

  for (const issue of toStart) {
    let started: StartedRun;
    try {
      started = ctx.start({ repo, issue, factoryHome: ctx.factoryHome });
    } catch (e) {
      const msg = (e as Error).message;
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === issue && en.status === "running");
        if (entry) park(entry, msg);
      }, gitOpts);
      ctx.io.out(`queue: #${issue} parked: ${msg}\n`);
      continue;
    }
    ctx.handles.set(handleKey(repo, issue), track(started, repo, issue));
    ctx.io.out(`queue: #${issue} started\n`);
    if (started.pid) {
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === issue && en.status === "running");
        if (entry) entry.pid = started.pid;
      }, gitOpts);
    }
  }
  const watch = await updateBehind(ctx.github, repo, ctx.factoryHome, ctx.behindUpdated, ctx.behindFlight, ctx.io, timeoutMs);
  const q = loadQueueByKey(ctx.factoryHome, key);
  if (!q) return false;
  const pending = q.entries.some((e) => e.status === "pending");
  const running = q.entries.some((e) => e.status === "running");
  const overlap = q.entries.some((e) => e.status === "parked" && (e.blocked_by?.length ?? 0) > 0);
  const live = [...ctx.handles.values()].some((h) => resolve(h.repo) === resolve(repo) && h.settled === undefined && !h.failed && !h.ignoreResult);
  if (ctx.pastUntil) return running || live;
  const behind = watch.needsUpdate || (ctx.untilMs !== undefined && watch.openDone);
  return pending || running || overlap || live || behind;
}

async function reposFor(opts: RunQueueOptions): Promise<string[]> {
  if (opts.repo) return [resolve(opts.repo)];
  return loadAllQueues(opts.factoryHome).map((q) => q.repo);
}

/**
 * One worker. Fills slots in queue order, classifies `result.json` when a run ends, updates behind PRs.
 * A stall keeps the slot until the process exits (SIGKILL after a grace period).
 * Stops when nothing is pending, running, or behind (overlap parks keep polling until the blocking PR closes).
 * With `untilMs`, also stays until that time while an open factory PR is behind or waiting for auto-merge;
 * at `untilMs` live runs finish and the worker exits. A second worker is refused.
 */
export async function runQueue(opts: RunQueueOptions): Promise<void> {
  const io = opts.io ?? { out: () => {}, err: () => {} };
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const slots = opts.slots ?? DEFAULT_SLOTS;
  const netTimeoutMs = opts.netTimeoutMs ?? WORKER_CALL_TIMEOUT_MS;
  const handles = new Map<string, Tracked>();
  const stall = new Map<string, StallWatch>();
  const terminating = new Map<string, Terminating>();
  const behindUpdated = new Map<string, number>();
  const behindFlight = new Map<string, Promise<unknown>>();
  const redLogged = new Set<string>();
  const dir = queueDir(opts.factoryHome);
  mkdirSync(dir, { recursive: true });
  const held = await tryPathLock(
    join(dir, "worker.lock"),
    "queue-worker",
    async () => {
      let lastTick = now();
      try {
        while (!opts.signal?.aborted) {
          const t = now();
          // A gap much larger than the tick is a suspend (laptop sleep), not agent silence. Same slack as the run watchdog.
          const jumped = t - lastTick > poll + suspendSlackMs(poll);
          lastTick = t;
          const pastUntil = opts.untilMs !== undefined && t >= opts.untilMs;
          const repos = await reposFor(opts);
          let cont = false;
          for (const repo of repos) {
            try {
              const busy = await tickRepo(
                {
                  factoryHome: opts.factoryHome,
                  github: opts.github,
                  slots,
                  untilMs: opts.untilMs,
                  pastUntil,
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
                },
                repo,
              );
              if (busy) cont = true;
            } catch (e) {
              io.err(`factory: queue tick failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
              cont = true;
            }
          }
          if (!cont) {
            io.out(pastUntil ? "queue: until reached\n" : "queue: idle\n");
            return;
          }
          await sleep(poll, opts.signal).catch(() => undefined);
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
