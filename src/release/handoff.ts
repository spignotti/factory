import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realSleep, type Sleep } from "../agents/fake-runner.js";
import type { Io } from "../commands/gates.js";
import { satisfiesNodeEngine } from "../node-runtime.js";
import { admissionHold, clearAdmissionHold, requestAdmissionHold } from "../queue/admission.js";
import { clearWorkerMode, readWorkerMode, writeWorkerMode } from "../queue/control.js";
import { currentWorker, executingRelease, pidAlive, workerLockHolder, workerOwnsLock, type WorkerIdentity } from "../queue/identity.js";
import { loadAllQueues } from "../queue/store.js";
import { checkCandidateCompat, rollbackIsCompatible, type Compat } from "./compat.js";
import {
  TERMINAL_PHASES,
  candidateDir,
  dataVersionsOnDisk,
  listCandidates,
  readActive,
  readCandidate,
  readTx,
  workInFlight,
  writeActive,
  writeTx,
  type Active,
  type Candidate,
  type Handoff,
  type HandoffPhase,
} from "./state.js";
import { verifyArtifact } from "./stage.js";

/**
 * The release handoff (#187): one controlled operation that moves the queue worker from the active
 * release onto an approved, tested, immutable candidate.
 *
 * Nothing is hot-reloaded and no live `dist/` is replaced. The live worker is asked to drain (no new
 * admissions, active coding finishes), and only after it released `queue/worker.lock` is the active
 * release switched and one worker started from the candidate. Each step is persisted in
 * `releases/handoff.json`, so a crash leaves a transaction that the next activation recognises and
 * finishes instead of starting a second worker. This is not zero downtime: nothing new is admitted
 * until the new worker is the only lock holder.
 *
 * The operator's own `pause`/`drain` marker is kept in the transaction and written back when it ends,
 * so an update never unpauses work. While the admission hold is set the worker does not unpark, update
 * a branch, or spend an approval; that reconciliation belongs to the worker that owns the queue after
 * the switch.
 */

export interface StartedWorker {
  pid: number;
}

/** Starts one worker from a staged candidate. Tests inject a fake; the default spawns the candidate CLI. */
export type StartWorker = (candidate: Candidate) => StartedWorker | Promise<StartedWorker>;

export interface HandoffDeps {
  home: string;
  io?: Io;
  startWorker?: StartWorker;
  pollMs?: number;
  /** Give up waiting for the drain after this long and abort before the switch. Nothing is killed. */
  drainTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** Accept a durable-state migration. Without it a migrating candidate is refused before switching. */
  allowMigration?: boolean;
  now?: () => number;
  sleep?: Sleep;
}

export interface ActivateOptions extends HandoffDeps {
  id: string;
}

/** Transactions this process is driving, so a second activation in-process is refused too. */
const driving = new Set<string>();

const DEFAULT_POLL_MS = 500;
const DEFAULT_HEALTH_MS = 60_000;
const ROLLBACK_HEALTH_MS = 30_000;
const silent: Io = { out: () => undefined, err: () => undefined };

/**
 * The real starter: one detached `queue run --stay` from the candidate's own tree.
 * `FACTORY_RELEASE_ID` names the candidate so the worker reports it, and the caller's environment is
 * passed through unchanged, so a session started through the Infisical wrapper keeps working.
 */
export function defaultStartWorker(home: string): StartWorker {
  return (candidate) => {
    const dir = candidateDir(home, candidate.id);
    const launcher = join(dir, "scripts", "factory");
    const cli = join(dir, "dist", "cli.js");
    const useLauncher = existsSync(launcher);
    if (!useLauncher && !existsSync(cli)) throw new Error(`${candidate.id} has no runnable CLI under ${dir}`);
    const child = spawn(useLauncher ? "bash" : process.execPath, [...(useLauncher ? [launcher] : [cli]), "queue", "run", "--stay"], {
      cwd: dir,
      env: { ...process.env, FACTORY_HOME: home, FACTORY_RELEASE_ID: candidate.id },
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { pid: child.pid ?? 0 };
  };
}

type WorkerView = { pid: number; id: string; version: string; commit: string; owns_lock: boolean } | null;

function workerView(home: string): WorkerView {
  const worker: WorkerIdentity | undefined = currentWorker(home);
  if (!worker) return null;
  return { ...worker, owns_lock: workerOwnsLock(home, worker) };
}

function holdView(home: string): { state: string; tx: string; reason: string } | null {
  const hold = admissionHold(home);
  return hold ? { state: hold.state, tx: hold.tx, reason: hold.reason } : null;
}

/** What the operator sees before activating: versions, the work in flight, compatibility, rollback. */
export interface HandoffPlan {
  target?: Candidate;
  /** The active release, absent while nothing has been activated in this home. */
  current?: Active & { version: string };
  worker: WorkerView;
  work: ReturnType<typeof workInFlight>;
  compat: Compat;
  /** Where a failed activation would switch back to, and whether that is safe. */
  rollback?: { id: string; version: string; compatible: boolean; reasons: string[] };
  steps: string[];
  ready: boolean;
  blockers: string[];
  hold: { state: string; tx: string; reason: string } | null;
}

export function planHandoff(opts: { home: string; id: string }): HandoffPlan {
  const home = opts.home;
  const current = readActive(home);
  const plan: HandoffPlan = {
    worker: workerView(home),
    work: workInFlight(home),
    compat: { ok: false, reasons: [], migrates_only: false },
    steps: [],
    ready: false,
    blockers: [],
    hold: holdView(home),
    ...(current ? { current } : {}),
  };
  const target = readCandidate(home, opts.id);
  if (!target) return { ...plan, blockers: [`candidate ${opts.id} is not staged`] };
  plan.target = target;

  const disk = dataVersionsOnDisk(home);
  plan.compat = checkCandidateCompat(target, disk);
  if (!target.tested) plan.blockers.push(`candidate ${target.id} is not tested: no check ran over this build`);
  if (!target.approval) plan.blockers.push(`candidate ${target.id} is not approved: staging publishes it, approval permits activation`);
  else if (target.approval.digest !== target.digest) plan.blockers.push(`candidate ${target.id} is not approved: its tree changed after the approval`);
  const artifact = verifyArtifact(home, target.id);
  if (!artifact.ok) plan.blockers.push(artifact.reason);
  if (!satisfiesNodeEngine(process.version, target.node_engine)) plan.blockers.push(`this runtime is ${process.version}; ${target.id} needs node ${target.node_engine}`);
  plan.blockers.push(...plan.compat.reasons);

  const previous = current ? readCandidate(home, current.id) : undefined;
  if (previous) {
    const back = rollbackIsCompatible(previous, target, disk);
    plan.rollback = { id: previous.id, version: previous.version, compatible: back.ok, reasons: back.reasons };
  }

  plan.steps = [
    `hold admissions${plan.worker ? ` for the live worker (pid ${plan.worker.pid})` : " (no live worker)"}: no issue starts, and queued, parked and waiting work stay on disk`,
    `let the ${plan.work.running} active coding run(s) finish; no run is signalled`,
    "wait for queue/worker.lock to be released: one worker per factory home, never two",
    `switch the active release to ${target.version} (${target.id}); the running installation is not reloaded or replaced`,
    `start one worker from ${target.id}, then verify it is alive, runs this artifact and alone holds the queue`,
    "end: release the hold and write the operator's worker mode back unchanged",
  ];
  if (plan.rollback) plan.steps.push(`on a failed activation, switch back to ${plan.rollback.version}${plan.rollback.compatible ? "" : " - not possible, see the compatibility reasons"}`);
  plan.ready = plan.blockers.length === 0;
  return plan;
}

export interface HandoffResult {
  ok: boolean;
  phase: HandoffPhase | "refused";
  message: string;
}

/**
 * The one controlled operation. Refuses anything that is not an approved, tested, digest-matching
 * candidate over compatible state; otherwise drains, switches, starts one worker and verifies it.
 * A transaction that a crash left open is finished instead of starting a second worker.
 */
export async function activateHandoff(opts: ActivateOptions): Promise<HandoffResult> {
  const io = opts.io ?? silent;
  const home = opts.home;
  const sleep = opts.sleep ?? realSleep;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const startWorker = opts.startWorker ?? defaultStartWorker(home);
  const now = opts.now ?? Date.now;

  const open = readTx(home);
  const unfinished = open !== undefined && !TERMINAL_PHASES.includes(open.phase);
  if (unfinished && open.to_id !== opts.id) {
    io.err(`factory: handoff ${open.id} is in progress (${open.phase}, target ${open.to_id}); finish or abort it before activating another release\n`);
    return { ok: false, phase: "refused", message: "handoff in progress" };
  }
  // A transaction is driven by exactly one process. Another activation of the same target is only a
  // resume when the driver is gone; while it lives (including in this process) it is a duplicate.
  if (unfinished && (pidAlive(open.owner_pid) || open.owner_pid === process.pid || driving.has(open.id))) {
    io.err(`factory: handoff ${open.id} (${open.phase}) is in progress for ${open.to_id}; a second activation is refused\n`);
    return { ok: false, phase: "refused", message: "handoff in progress" };
  }
  if (unfinished) io.out(`factory: resuming handoff ${open.id} (${open.phase}) of a process that is gone\n`);
  const handoffLock = join(home, "releases", "handoff.lock");
  if (!unfinished && existsSync(handoffLock)) {
    const owner = Number(readFileSync(handoffLock, "utf8").split("\n")[0]);
    if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) {
      io.err(`factory: handoff is in progress (lock held by pid ${owner})\n`);
      return { ok: false, phase: "refused", message: "handoff in progress" };
    }
  }

  const plan = planHandoff({ home, id: opts.id });
  const migrationAccepted = plan.compat.migrates_only === true && opts.allowMigration === true;
  const blockers = migrationAccepted ? plan.blockers.filter((b) => !/migrat/.test(b)) : plan.blockers;
  if (!plan.target) {
    for (const b of blockers) io.err(`factory: ${b}\n`);
    return { ok: false, phase: "refused", message: blockers[0] ?? `candidate ${opts.id} is not staged` };
  }
  const target = plan.target;
  // The release the switch leaves behind: the transaction's own `from_id` on a resume, otherwise the
  // currently active release. After a crashed switch the active release is already the target, so it
  // must not be mistaken for the rollback destination.
  const previous = open?.from_id
    ? readCandidate(home, open.from_id)
    : plan.current
      ? readCandidate(home, plan.current.id)
      : undefined;

  const tx: Handoff = unfinished
    ? { ...open, owner_pid: process.pid }
    : {
        id: newTxId(now()),
        phase: "planned",
        ...(plan.current ? { from_id: plan.current.id } : {}),
        to_id: target.id,
        user_mode: readWorkerMode(home),
        migration: migrationAccepted,
        owner_pid: process.pid,
        steps: [],
        started_at: new Date(now()).toISOString(),
        updated_at: new Date(now()).toISOString(),
      };
  driving.add(tx.id);
  const done = (): void => void driving.delete(tx.id);
  const step = (phase: HandoffPhase): void => {
    tx.phase = phase;
    tx.steps = [...tx.steps, { phase, at: new Date().toISOString() }];
    writeTx(home, tx);
  };
  /** The transaction ends: the operator's marker is back and the hold is gone. */
  const end = (phase: HandoffPhase): void => {
    if (tx.user_mode === "pause" || tx.user_mode === "drain") writeWorkerMode(home, tx.user_mode);
    else clearWorkerMode(home);
    clearAdmissionHold(home);
    step(phase);
    done();
  };
  const fail = async (reason: string): Promise<HandoffResult> => {
    const out = await failOrRollback({ home, io, end, target, previous, startWorker, reason, migration: tx.migration });
    return out;
  };

  // A resumed switch whose staged artifact changed is rolled back, not refused: the switch already
  // happened, so the previous release must be restored before the worker is touched.
  if (unfinished && (open.phase === "switched" || open.phase === "verifying") && blockers.some((b) => /changed after it was staged/i.test(b))) {
    io.err(`factory: ${blockers.find((b) => /changed after it was staged/i.test(b))}\n`);
    return fail("the candidate changed after it was staged");
  }

  if (blockers.length) {
    for (const b of blockers) io.err(`factory: ${b}\n`);
    done();
    return { ok: false, phase: "refused", message: blockers[0] ?? "candidate is not ready" };
  }

  // 1. Drain the live worker. The admission hold is separate from the operator's `pause`/`drain`
  //    marker, which the transaction saves and writes back unchanged.
  if (tx.phase === "planned" || tx.phase === "draining") {
    requestAdmissionHold(home, { state: "drain", tx: tx.id, reason: `release handoff ${tx.id} to ${target.version}`, target_release: target.id });
    if (tx.user_mode === "run" || tx.user_mode === "pause") writeWorkerMode(home, "drain");
    step("draining");
    const drained = await waitForDrain(home, workerLockHolder(home), { pollMs, sleep, timeoutMs: opts.drainTimeoutMs });
    if (!drained) {
      end("aborted");
      io.err(
        `factory: the worker on ${previous?.version ?? "the active release"} did not drain${opts.drainTimeoutMs !== undefined ? ` within ${opts.drainTimeoutMs}ms` : ""}: nothing was switched and no run was signalled\n`,
      );
      return { ok: false, phase: "aborted", message: "worker did not drain" };
    }
    // The old worker left the queue. The hold stays (as a plain hold) so the new worker starts
    // nothing before it is verified; the worker marker belongs to the operator again.
    requestAdmissionHold(home, { state: "hold", tx: tx.id, reason: `release handoff ${tx.id} verifies ${target.version}`, target_release: target.id });
    clearWorkerMode(home);
  }

  // 2. Switch. The tree is verified again, immediately before it becomes the active release.
  if (tx.phase !== "verifying" && plan.current?.id !== target.id) {
    const artifact = verifyArtifact(home, target.id);
    if (!artifact.ok) {
      clearAdmissionHold(home);
      end("failed");
      io.err(`factory: ${artifact.reason}\n`);
      return { ok: false, phase: "failed", message: "candidate changed after staging" };
    }
    writeActive(home, target, plan.current?.id);
    step("switched");
  }

  // 3. Exactly one worker from the candidate, then prove it is healthy and the only queue owner.
  if (tx.phase === "verifying") {
    const worker = currentWorker(home);
    if (worker?.id === target.id && workerOwnsLock(home, worker)) {
      end("committed");
      return { ok: true, phase: "committed", message: `committed ${target.id}` };
    }
  }
  if (tx.phase === "switched" || tx.phase === "verifying") {
    requestAdmissionHold(home, { state: "hold", tx: tx.id, reason: `release handoff ${tx.id} verifies ${target.version}`, target_release: target.id });
    clearWorkerMode(home);
  }
  let started: StartedWorker;
  try {
    started = await startWorker(target);
  } catch (e) {
    return fail(`starting the worker for ${target.version} failed: ${(e as Error).message}`);
  }
  step("verifying");
  const healthy = await waitForHealthyWorker(home, target, started.pid, { pollMs, sleep, timeoutMs: opts.healthTimeoutMs ?? DEFAULT_HEALTH_MS });
  if (!healthy) return fail(`${target.version} did not come up as the sole queue worker`);

  // 4. Commit: the hold goes, the operator's intent stays, the transaction is closed.
  end("committed");
  io.out(`handoff: ${previous?.version ?? "none"} -> ${target.version} (${target.id}) committed; the queue worker reports ${target.version}\n`);
  io.out(`handoff: pending, parked, checkpointed and CI-waiting entries stayed on disk; ${workInFlight(home).running} coding run(s) active\n`);
  return { ok: true, phase: "committed", message: `committed ${target.id}` };
}

interface FailArgs {
  home: string;
  io: Io;
  end: (phase: HandoffPhase) => void;
  target: Candidate;
  previous: Candidate | undefined;
  startWorker: StartWorker;
  reason: string;
  migration: boolean;
}

/** Restores the previous version when that is safe; otherwise it says so instead of pretending. */
async function failOrRollback(a: FailArgs): Promise<HandoffResult> {
  const { home, io, end, target, previous, startWorker, reason, migration } = a;
  if (!previous) {
    end("failed");
    io.err(`factory: ${reason}; there is no previous release to roll back to\n`);
    return { ok: false, phase: "failed", message: `${reason}; no rollback target` };
  }
  const compat = rollbackIsCompatible(previous, target, dataVersionsOnDisk(home));
  if (migration || !compat.ok) {
    for (const r of compat.reasons) io.err(`factory: ${r}\n`);
    end("failed");
    io.err(
      `factory: ${reason}; rollback to ${previous.version} is refused: ${migration ? `the acknowledged state migration to ${target.version} cannot be undone` : `it cannot read the state ${target.version} writes`}\n`,
    );
    io.err("factory: the queue stays stopped; repair the new release or restore state from a backup, then activate again\n");
    return { ok: false, phase: "failed", message: `${reason}; rollback refused` };
  }

  // The failed worker must leave the queue before its predecessor joins it: never two workers.
  const stray = workerLockHolder(home);
  if (stray !== undefined) stopProcess(stray);
  writeActive(home, previous, target.id);
  let cameUp: boolean;
  try {
    const started = await startWorker(previous);
    cameUp = await waitForHealthyWorker(home, previous, started.pid, { pollMs: 50, sleep: realSleep, timeoutMs: ROLLBACK_HEALTH_MS });
  } catch {
    cameUp = false;
  }
  end("rolled_back");
  io.err(`factory: ${reason}; rolled back to ${previous.version} (${previous.id})${cameUp ? "" : " - its worker did not report health, check factory release status"}\n`);
  return { ok: false, phase: "rolled_back", message: `${reason}; rolled back to ${previous.version}` };
}

function stopProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function newTxId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Waits for the worker that held the queue to leave it. A new holder is the switched worker: fine. */
async function waitForDrain(
  home: string,
  oldWorkerPid: number | undefined,
  opts: { pollMs: number; sleep: Sleep; timeoutMs?: number },
): Promise<boolean> {
  if (oldWorkerPid === undefined) return true;
  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
  for (;;) {
    const holder = workerLockHolder(home);
    if (holder === undefined || holder !== oldWorkerPid) return true;
    if (deadline !== undefined && Date.now() > deadline) return false;
    await opts.sleep(opts.pollMs);
  }
}

/** The process the handoff started must be alive, own the queue lock and report this artifact. */
async function waitForHealthyWorker(
  home: string,
  target: Candidate,
  startedPid: number,
  opts: { pollMs: number; sleep: Sleep; timeoutMs: number },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (!pidAlive(startedPid)) return false;
    const worker = currentWorker(home);
    if (worker && worker.pid === startedPid && worker.id === target.id && workerOwnsLock(home, worker)) return true;
    if (Date.now() > deadline) return false;
    await opts.sleep(opts.pollMs);
  }
}

/** Published versions, the active version, the worker version and the versions of the live runs. */
export interface ReleaseStatusReport {
  /** The CLI that produced this report, kept apart from the release the queue runs. */
  installed: { id: string; version: string; commit: string };
  published: { id: string; version: string; commit: string; tested: boolean; approved: boolean; staged_at: string }[];
  active: (Active & { version: string }) | null;
  worker: WorkerView;
  runs: { repo: string; issue: number; run_id: string | null; status: string; release_id: string | null; version: string; commit: string }[];
  hold: { state: string; tx: string; reason: string } | null;
  transaction: Handoff | null;
}

export function releaseStatus(home: string): ReleaseStatusReport {
  const candidates = listCandidates(home);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const runs: ReleaseStatusReport["runs"] = [];
  for (const q of loadAllQueues(home)) {
    for (const e of q.entries) {
      if (e.status !== "running") continue;
      const c = e.release_id ? byId.get(e.release_id) : undefined;
      runs.push({
        repo: q.repo,
        issue: e.issue,
        run_id: e.run_id ?? null,
        status: e.status,
        release_id: e.release_id ?? null,
        version: c?.version ?? "unknown",
        commit: c?.commit ?? "unknown",
      });
    }
  }
  return {
    installed: executingRelease(),
    published: candidates.map((c) => ({ id: c.id, version: c.version, commit: c.commit, tested: c.tested, approved: c.approval !== undefined, staged_at: c.staged_at })),
    active: readActive(home) ?? null,
    worker: workerView(home),
    runs,
    hold: holdView(home),
    transaction: readTx(home) ?? null,
  };
}

export function renderReleaseStatus(s: ReleaseStatusReport): string {
  return (
    [
      `this CLI: ${s.installed.version} (${s.installed.id})`,
      `active release: ${s.active ? `${s.active.version} (${s.active.id}) since ${s.active.activated_at}` : "none"}`,
      `queue worker: ${s.worker ? `${s.worker.version} pid ${s.worker.pid}${s.worker.owns_lock ? " (holds the queue)" : " (does NOT hold queue/worker.lock)"}` : "not running"}`,
      `admission hold: ${s.hold ? `${s.hold.tx}: ${s.hold.reason}` : "none"}`,
      `handoff: ${s.transaction ? `${s.transaction.id} ${s.transaction.phase}` : "none"}`,
      `published (${s.published.length}):`,
      ...(s.published.length ? s.published.map((p) => `  ${p.id} tested:${p.tested ? "yes" : "no"} approved:${p.approved ? "yes" : "no"}`) : ["  none"]),
      `live runs (${s.runs.length}):`,
      ...(s.runs.length ? s.runs.map((r) => `  ${r.repo}#${r.issue} ${r.run_id ?? "-"} on ${r.version}`) : ["  none"]),
    ].join("\n") + "\n"
  );
}

export function renderHandoffPlan(plan: HandoffPlan): string {
  return (
    [
      `target: ${plan.target ? `${plan.target.version} (${plan.target.id}, commit ${plan.target.commit.slice(0, 12)})` : "not staged"}`,
      `active: ${plan.current ? `${plan.current.version} (${plan.current.id})` : "none"}`,
      `worker: ${plan.worker ? `${plan.worker.version} pid ${plan.worker.pid}` : "not running"}`,
      `work: pending ${plan.work.pending}, running ${plan.work.running}, parked ${plan.work.parked}, paused ${plan.work.paused}, waiting CI ${plan.work.ci_waiting}`,
      `compatibility: ${plan.compat.ok ? "compatible" : plan.compat.reasons.join("; ") || "not compatible"}`,
      `ready: ${plan.ready ? "yes" : "no"}`,
      ...(plan.blockers.length ? ["blockers:", ...plan.blockers.map((b) => `  - ${b}`)] : []),
      "handoff:",
      ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    ].join("\n") + "\n"
  );
}
