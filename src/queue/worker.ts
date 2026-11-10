import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realSleep, type Sleep } from "../agents/fake-runner.js";
import { ResultSchema, type RunResult } from "../events.js";
import type { GitHub, OpenFactoryPr, PrStatus } from "../gh.js";
import { baseRef, revParse } from "../git.js";
import { activeHolders, tryPathLock } from "../pipeline/lock.js";
import { listRuns, type RunRecord } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import type { Io } from "../commands/gates.js";
import { loadAllQueues, loadQueueByKey, queueDir, repoQueueKey, type QueueEntry, type QueueFile, updateQueue } from "./store.js";

/** Transient `needs_human` goes to the back at most this many times, then parks. */
export const MAX_REQUEUES = 2;
/** A run whose `events.jsonl` has not grown for `stall_minutes` times this is killed. */
const STALL_FACTOR = 2;
export const DEFAULT_SLOTS = 2;
const DEFAULT_POLL_MS = 15_000;
/** State written and lock not taken yet: treat as live so a restart does not start a second run. */
const STARTING_GRACE_MS = 15_000;

export interface StartedRun {
  /** Resolves with `result.json` once the run process exits. */
  done: Promise<RunResult>;
  pid: number;
  runId: () => string | undefined;
  /** Stall: SIGTERM. In-process tests abort the run instead of signalling this process. */
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
  /** Stall already parked the entry; the exit result must not reclassify it. */
  ignoreResult: boolean;
}

interface StallWatch {
  size: number;
  since: number;
}

interface TickCtx {
  factoryHome: string;
  github: GitHub;
  slots: number;
  pastUntil: boolean;
  nowMs: number;
  start: StartRun;
  io: Io;
  handles: Map<string, Tracked>;
  stall: Map<string, StallWatch>;
  behindUpdated: Set<string>;
  redLogged: Set<string>;
}

function alive(pid: number): boolean {
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

export function factoryIssueOfBranch(branch: string): number | undefined {
  const m = /^factory\/(\d+)(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

/** PR numbers in `planned paths overlap open factory PR #12 (…)`. Empty when this lock is not that case. */
export function overlapPrNumbers(reason: string): number[] {
  if (!/overlap open factory PR/i.test(reason)) return [];
  const nums = new Set<number>();
  for (const m of reason.matchAll(/#(\d+)/g)) nums.add(Number(m[1]));
  return [...nums];
}

export function isTransientNeedsHuman(result: string, reason: string): boolean {
  return result === "needs_human" && /^transient\b/i.test(reason.trim());
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

/** `done` records the PR. Transient `needs_human` requeues. Overlap `locked` parks on the PR numbers. Everything else parks. */
export function applyOutcome(q: QueueFile, entry: QueueEntry, result: RunResult): "done" | "requeue" | "parked" {
  entry.run_id = result.run_id;
  if (result.pr) entry.pr = result.pr;
  delete entry.pid;
  if (result.result === "done") {
    entry.status = "done";
    delete entry.reason;
    delete entry.blocked_by;
    return "done";
  }
  if (isTransientNeedsHuman(result.result, result.reason)) {
    const n = (entry.requeues ?? 0) + 1;
    entry.requeues = n;
    if (n <= MAX_REQUEUES) {
      entry.status = "pending";
      delete entry.reason;
      delete entry.run_id;
      delete entry.blocked_by;
      moveToEnd(q, entry);
      return "requeue";
    }
    park(entry, result.reason, result.run_id);
    return "parked";
  }
  const blocked = result.result === "locked" ? overlapPrNumbers(result.reason) : [];
  park(entry, result.reason || result.result, result.run_id, blocked);
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

/** A lock holder, a live child pid, or a run dir touched in the last few seconds (lock not taken yet). */
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
    if (tracked && tracked.settled === undefined && !tracked.failed && !tracked.ignoreResult) continue;
    const related = runs.filter((r) => r.run_id === entry.run_id || issueOf(r) === entry.issue);
    const live = related.find((r) => runIsLive(factoryHome, r, holders) || (entry.pid !== undefined && entry.pid !== process.pid && alive(entry.pid) && r.run_id === entry.run_id));
    if (live && (entry.status === "pending" || entry.status === "running")) {
      entry.status = "running";
      entry.run_id = live.run_id;
      continue;
    }
    if (entry.status !== "running") continue;
    const own = entry.run_id ? related.find((r) => r.run_id === entry.run_id) : undefined;
    const finished = asResult(own?.result ?? (entry.run_id ? undefined : related.filter((r) => r.result).at(-1)?.result));
    if (finished) {
      applyOutcome(q, entry, finished);
      continue;
    }
    const childAlive = entry.pid !== undefined && entry.pid !== process.pid && alive(entry.pid);
    if (!entry.run_id && !childAlive) {
      // Recorded running, but the child never created a run. Put it back instead of parking.
      entry.status = "pending";
      delete entry.pid;
      continue;
    }
    if (entry.run_id && !holders.has(entry.run_id) && !childAlive) park(entry, "run ended without result.json", entry.run_id);
  }
}

function absorbHandles(q: QueueFile, handles: Map<string, Tracked>, io: Io): void {
  for (const entry of [...q.entries]) {
    const key = handleKey(q.repo, entry.issue);
    const tracked = handles.get(key);
    if (!tracked || (tracked.settled === undefined && !tracked.failed)) continue;
    if (tracked.ignoreResult) {
      handles.delete(key);
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
    const action = applyOutcome(q, entry, tracked.settled);
    if (action === "done") io.out(`queue: #${entry.issue} done${entry.pr ? ` ${entry.pr}` : ""}\n`);
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

function terminate(tracked: Tracked | undefined, pid: number | undefined): void {
  if (tracked) {
    tracked.kill("SIGTERM");
    return;
  }
  if (pid && alive(pid)) signalPid(pid, "SIGTERM");
}

function considerStall(entry: QueueEntry, repo: string, factoryHome: string, nowMs: number, watch: Map<string, StallWatch>, tracked: Tracked | undefined, io: Io): void {
  if (entry.status !== "running" || !entry.run_id) return;
  let limit: number;
  try {
    limit = loadRepoConfig(repo).limits.stall_minutes * STALL_FACTOR * 60_000;
  } catch {
    return;
  }
  const size = eventsSize(factoryHome, entry.run_id);
  const prev = watch.get(entry.run_id);
  if (!prev || prev.size !== size) {
    watch.set(entry.run_id, { size, since: nowMs });
    return;
  }
  if (nowMs - prev.since < limit) return;
  terminate(tracked, entry.pid);
  if (tracked) tracked.ignoreResult = true;
  const mins = Math.round((limit / 60_000) * 10) / 10;
  park(entry, `stalled: events.jsonl unchanged for ${mins} min`, entry.run_id);
  io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
}

async function prGate(github: GitHub, repo: string, pr: string): Promise<"wait" | "go" | "park"> {
  const st = await github.prStatus(repo, pr);
  if (st.state === "merged") return "go";
  if (st.state === "closed") return "park";
  return "wait";
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
  if (external) return prGate(github, repo, external);
  const open = await github.openFactoryPrFiles(repo);
  if (open.some((p) => factoryIssueOfBranch(p.branch) === entry.after)) return "wait";
  return "wait";
}

async function unparkOverlaps(q: QueueFile, github: GitHub, repo: string, io: Io): Promise<void> {
  for (const entry of q.entries) {
    if (entry.status !== "parked" || !entry.blocked_by?.length) continue;
    let states: PrStatus[];
    try {
      states = await Promise.all(entry.blocked_by.map((n) => github.prStatus(repo, String(n))));
    } catch (e) {
      io.err(`factory: blocking PR status failed for #${entry.issue}: ${(e as Error).message.slice(0, 200)}\n`);
      continue;
    }
    if (!states.every((s) => s.state === "merged" || s.state === "closed")) continue;
    entry.status = "pending";
    delete entry.blocked_by;
    delete entry.reason;
    delete entry.run_id;
    delete entry.pid;
    io.out(`queue: #${entry.issue} pending (blocking PR closed)\n`);
  }
}

/** Red base CI, or a check we could not read: start nothing for this repo this tick. */
async function baseBlocks(github: GitHub, repo: string, io: Io, redLogged: Set<string>): Promise<boolean> {
  try {
    const cfg = loadRepoConfig(repo);
    const sha = await revParse(repo, await baseRef(repo, cfg.base_branch));
    const status = await github.baseStatus(repo, sha);
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
    if (branch === pr.branch) return true;
    const url = r.result?.pr ?? r.state?.pr ?? "";
    return url === String(pr.number) || url.endsWith(`/${pr.number}`);
  });
}

/** One behind `factory/*` PR per repo per tick, and only when its run ended `done`. Merge, never rebase. True when one was updated (more may remain). */
async function updateOneBehind(github: GitHub, repo: string, factoryHome: string, updated: Set<string>, io: Io): Promise<boolean> {
  let prs: OpenFactoryPr[];
  try {
    prs = await github.openFactoryPrFiles(repo);
  } catch (e) {
    io.err(`factory: open PR list failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
    return false;
  }
  const runs = listRuns(factoryHome).filter((r) => sameRepo(r, repo));
  for (const pr of prs) {
    const key = String(pr.number);
    if (!runEndedDone(runs, pr)) continue;
    let status: PrStatus;
    try {
      status = await github.prStatus(repo, key);
    } catch (e) {
      io.err(`factory: pr status #${pr.number} failed: ${(e as Error).message.slice(0, 200)}\n`);
      continue;
    }
    if (status.state !== "open" || !status.behind) {
      updated.delete(key);
      continue;
    }
    if (updated.has(key)) continue;
    try {
      await github.updateBranch(repo, key);
    } catch (e) {
      io.err(`factory: update-branch #${pr.number} failed: ${(e as Error).message.slice(0, 200)}\n`);
      return false;
    }
    updated.add(key);
    io.out(`queue: updated PR #${pr.number} (behind)\n`);
    return true;
  }
  return false;
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
  const key = await repoQueueKey(repo);
  if (!loadQueueByKey(ctx.factoryHome, key)) return false;
  const cap = slotCap(repo, ctx.slots);
  const toStart = await updateQueue(ctx.factoryHome, repo, async (q) => {
    absorbHandles(q, ctx.handles, ctx.io);
    adopt(q, ctx.factoryHome, ctx.handles);
    for (const entry of q.entries) {
      if (entry.status !== "running") continue;
      const tracked = ctx.handles.get(handleKey(repo, entry.issue));
      noteRunId(entry, tracked);
      considerStall(entry, repo, ctx.factoryHome, ctx.nowMs, ctx.stall, tracked, ctx.io);
    }
    await unparkOverlaps(q, ctx.github, repo, ctx.io);
    const waiting = new Set<number>();
    for (const entry of q.entries) {
      if (entry.status !== "pending" || entry.after === undefined) continue;
      try {
        const gate = await afterGate(entry, q, ctx.github, repo, ctx.factoryHome);
        if (gate === "wait") waiting.add(entry.issue);
        else if (gate === "park") {
          park(entry, `after #${entry.after} closed without merge`);
          ctx.io.out(`queue: #${entry.issue} parked: ${entry.reason}\n`);
        }
      } catch (e) {
        waiting.add(entry.issue);
        ctx.io.err(`factory: after #${entry.after} check failed: ${(e as Error).message.slice(0, 200)}\n`);
      }
    }
    const running = q.entries.filter((e) => e.status === "running").length;
    let room = Math.max(0, cap - running);
    const starts: number[] = [];
    const wantStart = !ctx.pastUntil && room > 0 && q.entries.some((e) => e.status === "pending" && !waiting.has(e.issue));
    if (!wantStart || (await baseBlocks(ctx.github, repo, ctx.io, ctx.redLogged))) return starts;
    let openPrs: OpenFactoryPr[] | undefined;
    for (const entry of q.entries) {
      if (room <= 0) break;
      if (entry.status !== "pending" || waiting.has(entry.issue)) continue;
      const tracked = ctx.handles.get(handleKey(repo, entry.issue));
      if (tracked && tracked.settled === undefined && !tracked.failed) continue;
      try {
        const issue = await ctx.github.getIssue(repo, entry.issue);
        if ((issue.state ?? "open") === "closed") {
          park(entry, "issue closed");
          ctx.io.out(`queue: #${entry.issue} parked: issue closed\n`);
          continue;
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (/not found/i.test(msg)) {
          park(entry, "issue not found");
          ctx.io.out(`queue: #${entry.issue} parked: issue not found\n`);
        } else ctx.io.err(`factory: issue #${entry.issue}: ${msg.slice(0, 200)}\n`);
        continue;
      }
      if (!openPrs) {
        try {
          openPrs = await ctx.github.openFactoryPrFiles(repo);
        } catch (e) {
          ctx.io.err(`factory: open PR list failed (${repo}): ${(e as Error).message.slice(0, 200)}\n`);
          break;
        }
      }
      const hit = openPrs.find((p) => factoryIssueOfBranch(p.branch) === entry.issue);
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
  });
  for (const issue of toStart) {
    let started: StartedRun;
    try {
      started = ctx.start({ repo, issue, factoryHome: ctx.factoryHome });
    } catch (e) {
      const msg = (e as Error).message;
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === issue && en.status === "running");
        if (entry) park(entry, msg);
      });
      ctx.io.out(`queue: #${issue} parked: ${msg}\n`);
      continue;
    }
    ctx.handles.set(handleKey(repo, issue), track(started, repo, issue));
    ctx.io.out(`queue: #${issue} started\n`);
    if (started.pid) {
      await updateQueue(ctx.factoryHome, repo, (q) => {
        const entry = q.entries.find((en) => en.issue === issue && en.status === "running");
        if (entry) entry.pid = started.pid;
      });
    }
  }
  const updatedBehind = await updateOneBehind(ctx.github, repo, ctx.factoryHome, ctx.behindUpdated, ctx.io);
  const q = loadQueueByKey(ctx.factoryHome, key);
  if (!q) return false;
  const pending = q.entries.some((e) => e.status === "pending");
  const running = q.entries.some((e) => e.status === "running");
  const overlap = q.entries.some((e) => e.status === "parked" && (e.blocked_by?.length ?? 0) > 0);
  const live = [...ctx.handles.values()].some((h) => resolve(h.repo) === resolve(repo) && h.settled === undefined && !h.failed && !h.ignoreResult);
  if (ctx.pastUntil) return running || live;
  return pending || running || overlap || live || updatedBehind;
}

async function reposFor(opts: RunQueueOptions): Promise<string[]> {
  if (opts.repo) return [resolve(opts.repo)];
  return loadAllQueues(opts.factoryHome).map((q) => q.repo);
}

/**
 * One worker. Fills slots in queue order, classifies `result.json` when a run ends, updates behind PRs.
 * Stops when nothing is pending or running (overlap parks keep polling until the blocking PR closes;
 * a successful behind-PR update keeps the worker for another tick so the next PR can be updated)
 * or at `untilMs` once live runs have finished. A second worker is refused.
 */
export async function runQueue(opts: RunQueueOptions): Promise<void> {
  const io = opts.io ?? { out: () => {}, err: () => {} };
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const slots = opts.slots ?? DEFAULT_SLOTS;
  const handles = new Map<string, Tracked>();
  const stall = new Map<string, StallWatch>();
  const behindUpdated = new Set<string>();
  const redLogged = new Set<string>();
  const dir = queueDir(opts.factoryHome);
  mkdirSync(dir, { recursive: true });
  const held = await tryPathLock(
    join(dir, "worker.lock"),
    "queue-worker",
    async () => {
      try {
        while (!opts.signal?.aborted) {
          const t = now();
          const pastUntil = opts.untilMs !== undefined && t >= opts.untilMs;
          const repos = await reposFor(opts);
          let cont = false;
          for (const repo of repos) {
            const busy = await tickRepo(
              { factoryHome: opts.factoryHome, github: opts.github, slots, pastUntil, nowMs: t, start: opts.start, io, handles, stall, behindUpdated, redLogged },
              repo,
            );
            if (busy) cont = true;
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
