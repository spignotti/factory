import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueAdd } from "../../src/commands/queue.js";
import type { Io } from "../../src/commands/gates.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { readWorkerMode, writeWorkerMode } from "../../src/queue/control.js";
import { admissionHold, requestAdmissionHold } from "../../src/queue/admission.js";
import { loadQueueByKey, queueDir, repoQueueKey, saveQueue, type QueueEntry } from "../../src/queue/store.js";
import { runQueue, type StartRun } from "../../src/queue/worker.js";
import { activateHandoff, planHandoff, releaseStatus } from "../../src/release/handoff.js";
import { checkCandidateCompat, dataVersionsOnDisk } from "../../src/release/compat.js";
import { candidateDir, listCandidates, readActive, readTx, writeActive } from "../../src/release/state.js";
import { currentWorker, workerLockHolder } from "../../src/queue/identity.js";
import type { Candidate } from "../../src/release/state.js";
import { approveCandidate, stageCandidate, verifyArtifact } from "../../src/release/stage.js";
import { createFixtureRepo } from "../helpers/repo.js";

/**
 * #187: staging and activation are separate. A tested, version-pinned immutable candidate is
 * staged while the running worker continues; one controlled operation moves the queue onto it
 * through a recoverable graceful drain. A second worker is never started.
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_TARGET = "0123456789abcdef0123456789abcdef01234567";

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { out: (s) => void (out += s), err: (s) => void (err += s) }, out: () => out, err: () => err };
}

function ready(n: number): Issue {
  return { number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open" };
}

function outcome(repo: string, issue: number, result: RunResult["result"], extra: Partial<RunResult> = {}): RunResult {
  return {
    run_id: `20261112-120000-${issue.toString(16).padStart(6, "0")}`,
    repo,
    task: `#${issue}`,
    type: "feature",
    lane: "standard",
    result,
    risk: null,
    merge_policy: null,
    pr: null,
    rounds: 0,
    minutes: 0,
    cost_usd: 0,
    reason: "",
    branch: null,
    worktree: null,
    run_dir: "",
    ...extra,
  };
}

function gate(): { start: StartRun; calls: number[]; issues: number[]; release: (issue: number, result: RunResult) => void; kills: () => number } {
  const calls: number[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  let kills = 0;
  return {
    calls,
    issues: calls,
    kills: () => kills,
    release: (issue, result) => {
      const resolve = pending.get(issue);
      if (!resolve) throw new Error(`no pending start for #${issue}`);
      resolve(result);
    },
    start: (req) => {
      calls.push(req.issue);
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => {
        resolve = r;
      });
      pending.set(req.issue, resolve);
      return { done, pid: 0, runId: () => req.runId, kill: () => void (kills += 1), unref: () => undefined };
    },
  };
}

let tmp: string;
let home: string;
const kids: ReturnType<typeof spawn>[] = [];

function track<T extends ReturnType<typeof spawn>>(child: T): T {
  kids.push(child);
  return child;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-handoff-"));
  home = join(tmp, "fhome");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  for (const p of kids) if (p.exitCode === null) p.kill("SIGKILL");
  kids.length = 0;
});

/** A staged tree: its own build (not the executing install), plus named checks. */
function stage(o: { version: string; commit: string; checks?: boolean; writes?: Partial<Candidate["writes"]>; reads?: Partial<Candidate["reads"]> }) {
  return stageCandidate({
    home,
    version: o.version,
    commit: o.commit,
    ...(o.writes ? { writes: o.writes } : {}),
    ...(o.reads ? { reads: o.reads } : {}),
    install: (dir) => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "cli.js"), `#!/usr/bin/env node\n// factory ${o.version}\n`);
      mkdirSync(join(dir, "profiles"), { recursive: true });
      writeFileSync(join(dir, "profiles", "default.yaml"), "roles: {}\n");
    },
    ...(o.checks === false
      ? {}
      : {
          checks: [
            { name: "build", run: () => undefined },
            { name: "test", run: () => undefined },
          ],
        }),
  });
}

async function approved(o: { version: string; commit: string; writes?: Partial<Candidate["writes"]>; reads?: Partial<Candidate["reads"]> }) {
  return approveCandidate(home, (await stage(o)).id);
}

/** A worker process that takes the queue lock and publishes its identity, like `queue run` does. */
async function fakeWorker(identity: { id: string; version: string; commit: string }): Promise<number> {
  const script = `
    const fs = require("fs"), path = require("path");
    const home = process.argv[1], identity = JSON.parse(process.argv[2]);
    fs.mkdirSync(path.join(home, "queue"), { recursive: true });
    const lock = path.join(home, "queue", "worker.lock");
    const tmpf = lock + "." + process.pid;
    fs.writeFileSync(tmpf, process.pid + "\\nqueue-worker");
    for (let i = 0; i < 300; i++) {
      try { fs.linkSync(tmpf, lock); break; } catch {
        const holder = Number(fs.readFileSync(lock, "utf8").split("\\n")[0]);
        let live = true;
        try { process.kill(holder, 0); } catch { live = false; }
        if (!live) { try { fs.unlinkSync(lock); } catch { /* taken again */ } }
      }
    }
    try { fs.unlinkSync(tmpf); } catch { /* gone */ }
    fs.writeFileSync(path.join(home, "queue", "worker.id"), JSON.stringify({ version: 1, ...identity, pid: process.pid, at: new Date().toISOString() }));
    setInterval(() => {}, 30000);
  `;
  const child = track(spawn(process.execPath, ["-e", script, home, JSON.stringify(identity)], { stdio: "ignore" }));
  const pid = await new Promise<number>((resolve) => child.on("spawn", () => resolve(child.pid ?? 0)));
  await waitFor("the worker publishes its identity", () => currentWorker(home)?.pid === pid);
  return pid;
}

/** The starter the handoff uses in tests: a process that looks like the target release's worker. */
function startAsRelease(): (c: Candidate) => Promise<{ pid: number }> {
  return async (c) => ({ pid: await fakeWorker({ id: c.id, version: c.version, commit: c.commit }) });
}

async function entries(factoryHome: string, repo: string): Promise<QueueEntry[]> {
  const key = await repoQueueKey(repo);
  return loadQueueByKey(factoryHome, key)?.entries ?? [];
}

async function pushEntries(factoryHome: string, repo: string, ...rows: QueueEntry[]): Promise<void> {
  const key = await repoQueueKey(repo);
  const q = loadQueueByKey(factoryHome, key) ?? { version: 1 as const, repo, repo_key: key, entries: [] };
  q.entries.push(...rows);
  saveQueue(factoryHome, q);
}

async function waitFor(label: string, pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Opens a staged (read-only) tree so a test can tamper with one file. */
function unseal(dir: string, file: string): void {
  chmodSync(dir, 0o755);
  chmodSync(join(file, ".."), 0o755);
  chmodSync(file, 0o644);
}

describe("release handoff (#187)", () => {
  it("stages an immutable, version-pinned candidate while the live worker keeps running", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const github = new FakeGitHub();
    github.issues.set(1, ready(1));
    github.issues.set(2, ready(2));
    await queueAdd({ factoryHome: home, repo, issues: [1, 2], github }, capture().io);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io,
      release: { id: "installed-0.6.0", version: "0.6.0", commit: SHA_A },
    });
    try {
      await waitFor("issue #1 started", () => g.calls.length >= 1);
      const candidate = await approved({ version: "0.7.0", commit: SHA_TARGET });
      expect(candidate.tested).toBe(true);
      expect(candidate.checks_passed).toEqual(["build", "test"]);
      // Staging registers the artifact; it does not activate anything.
      expect(readActive(home)).toBeUndefined();
      expect(currentWorker(home)).toMatchObject({ version: "0.6.0" });
      // The live work is untouched: same run, no second start, nothing killed.
      expect(g.calls).toEqual([1]);
      expect((await entries(home, repo)).find((e) => e.issue === 1)?.status).toBe("running");
      // The pinned commit is staged once, and its tree cannot change unnoticed.
      await expect(stage({ version: "0.7.0", commit: SHA_TARGET })).rejects.toThrow(/already staged/);
      expect(verifyArtifact(home, candidate.id).ok).toBe(true);
      const dir = candidateDir(home, candidate.id);
      const file = join(dir, "dist", "cli.js");
      unseal(dir, file);
      writeFileSync(file, "// tampered\n");
      expect(verifyArtifact(home, candidate.id)).toMatchObject({ ok: false });
      g.release(1, outcome(repo, 1, "done", { pr: "https://github.test/pr/1" }));
      await waitFor("issue #2 started", () => g.calls.includes(2));
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a failing check never produces a candidate", async () => {
    await expect(
      stageCandidate({
        home, version: "0.7.0", commit: SHA_TARGET, install: () => undefined,
        checks: [{ name: "test", run: () => { throw new Error("test suite red"); } }],
      }),
    ).rejects.toThrow(/test suite red/);
    expect(listCandidates(home)).toEqual([]);
  });

  it("refuses an unknown, untested or unapproved artifact, and a ref that is not a pin", async () => {
    const untested = await stage({ version: "0.7.0", commit: SHA_TARGET, checks: false });
    const cap = capture();
    expect((await activateHandoff({ home, id: untested.id, io: cap.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap.err()).toContain("not tested");
    expect(readActive(home)).toBeUndefined();

    const cap2 = capture();
    expect((await activateHandoff({ home, id: "0.9.0-deadbeefdead", io: cap2.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap2.err()).toContain("not staged");

    // An approval belongs to one exact artifact, never to a version name alone.
    await approved({ version: "0.7.1", commit: SHA_B });
    const twin = await stage({ version: "0.7.1", commit: SHA_TARGET });
    const cap3 = capture();
    expect((await activateHandoff({ home, id: twin.id, io: cap3.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap3.err()).toContain("not approved");
    expect(readActive(home)).toBeUndefined();

    await expect(stage({ version: "0.8.0", commit: "main" })).rejects.toThrow(/40 hex/);
    // An approved artifact whose tree changed is never executed.
    const good = await approved({ version: "0.9.1", commit: SHA_C });
    const file = join(candidateDir(home, good.id), "dist", "cli.js");
    unseal(candidateDir(home, good.id), file);
    writeFileSync(file, "// tampered\n");
    const cap4 = capture();
    expect((await activateHandoff({ home, id: good.id, io: cap4.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap4.err()).toMatch(/changed|digest/);
  });

  it("plan shows current and target versions, the work in flight and the rollback target", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    await fakeWorker({ id: previous.id, version: previous.version, commit: previous.commit });
    const repo = createFixtureRepo();
    const waitingRun = "20261112-120000-eeeeee";
    mkdirSync(join(home, "runs", waitingRun), { recursive: true });
    writeFileSync(join(home, "runs", waitingRun, "state.json"), JSON.stringify({ version: 1, run_id: waitingRun, repo, task: { ref: "#9" }, step: "finished", result: "done", reason: "", branch: "factory/9-x", pr: "https://github.test/pr/9", ci_wait: "pending" }));
    await pushEntries(
      home,
      repo,
      { issue: 1, status: "pending", added_at: "2026-01-01T00:00:00Z" },
      { issue: 2, status: "running", run_id: "20261112-120000-ffffff", release_id: previous.id, added_at: "2026-01-01T00:00:00Z" },
      { issue: 3, status: "parked", reason: "needs a decision", added_at: "2026-01-01T00:00:00Z" },
    );
    const plan = planHandoff({ home, id: target.id });
    expect(plan.target?.id).toBe(target.id);
    expect(plan.current?.version).toBe("0.6.1");
    expect(plan.rollback, JSON.stringify(plan.rollback)).toMatchObject({ id: previous.id, compatible: true });
    expect(plan.worker).toMatchObject({ version: "0.6.1", owns_lock: true });
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.compat.ok).toBe(true);
    expect(plan.work).toMatchObject({ pending: 1, running: 1, parked: 1, ci_waiting: 1 });
    expect(plan.ready).toBe(true);
    // An artifact that is not tested and approved is not plan-ready.
    const unapproved = await stage({ version: "0.8.0", commit: SHA_B, checks: false });
    const plan2 = planHandoff({ home, id: unapproved.id });
    expect(plan2.ready).toBe(false);
    expect(plan2.blockers.join(" ")).toMatch(/not tested/);
  });

  it("a graceful drain handoff switches the worker and preserves every queue state", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const github = new FakeGitHub();
    for (const n of [1, 2, 3, 4]) github.issues.set(n, ready(n));
    await queueAdd({ factoryHome: home, repo, issues: [1, 2, 3], github }, capture().io);
    await queueAdd({ factoryHome: home, repo, issues: [4], after: 3, github }, capture().io);

    // A parked decision, a dependency block and a CI-waiting run survive the switch unchanged.
    const parkedRun = "20261112-120000-aaaaaa";
    const ciRun = "20261112-120000-bbbbbb";
    const pr = "https://github.test/pr/9";
    mkdirSync(join(home, "runs", parkedRun), { recursive: true });
    writeFileSync(join(home, "runs", parkedRun, "state.json"), JSON.stringify({ version: 1, run_id: parkedRun, repo, task: { ref: "#5" }, step: "implement", result: "needs_human", reason: "plan needs input" }));
    mkdirSync(join(home, "runs", ciRun), { recursive: true });
    writeFileSync(join(home, "runs", ciRun, "state.json"), JSON.stringify({ version: 1, run_id: ciRun, repo, task: { ref: "#9" }, step: "finished", result: "done", reason: "", branch: "factory/9-x", pr, ci_wait: "pending", approved_sha: "sha9" }));
    writeFileSync(join(home, "runs", ciRun, "result.json"), JSON.stringify(outcome(repo, 9, "done", { run_id: ciRun, pr, merge_policy: "human_review" })) + "\n");
    github.prStates.set(pr, { state: "open", draft: false, ci: "pending" });
    await pushEntries(
      home,
      repo,
      { issue: 5, status: "parked", reason: "needs a decision", run_id: parkedRun, added_at: "2026-01-01T00:00:00Z" },
      { issue: 6, status: "pending", run_id: "20261112-120000-cccccc", issue_rev: "rev", added_at: "2026-01-01T00:00:00Z" },
      { issue: 7, status: "parked", blocked_by: [12], reason: "planned paths overlap open factory PR #12", added_at: "2026-01-01T00:00:00Z" },
    );

    const current = await approved({ version: "0.6.0", commit: SHA_A });
    writeActive(home, current);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io,
      release: { id: current.id, version: current.version, commit: current.commit },
    });
    try {
      await waitFor("a run is live", () => g.calls.length >= 1);
      // The operator paused work before the update: the handoff must not unpause it.
      writeWorkerMode(home, "pause");
      const before = await entries(home, repo);
      const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
      const handoff = activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, drainTimeoutMs: 10_000, startWorker: startAsRelease() });
      await waitFor("admission hold", () => admissionHold(home) !== undefined);
      // The active run is never signalled: it finishes and the worker drains.
      g.release(1, outcome(repo, 1, "done", { pr: "https://github.test/pr/1" }));
      const res = await handoff;
      expect(res.ok, cap.err()).toBe(true);
      // The active coding run was awaited, never signalled.
      expect(g.kills()).toBe(0);
      expect(readActive(home)).toMatchObject({ id: target.id, previous_id: current.id });
      expect(currentWorker(home)).toMatchObject({ version: "0.7.0" });
      // The user's own pause intent survives, separate from the released admission hold.
      expect(readWorkerMode(home)).toBe("pause");
      expect(admissionHold(home)).toBeUndefined();
      const after = await entries(home, repo);
      expect(after.find((e) => e.issue === 1)).toMatchObject({ status: "done", release_id: current.id });
      expect(after.filter((e) => e.issue !== 1).map((e) => [e.issue, e.status, e.run_id ?? null, e.reason ?? null])).toEqual(
        before.filter((e) => e.issue !== 1).map((e) => [e.issue, e.status, e.run_id ?? null, e.reason ?? null]),
      );
      expect(after.find((e) => e.issue === 4)?.after).toBe(3);
      expect(after.find((e) => e.issue === 5)).toMatchObject({ status: "parked", reason: "needs a decision", run_id: parkedRun });
      expect(after.find((e) => e.issue === 6)?.run_id).toBe("20261112-120000-cccccc");
      expect(after.find((e) => e.issue === 7)?.blocked_by).toEqual([12]);
      expect(readFileSync(join(home, "runs", ciRun, "state.json"), "utf8")).toContain("ci_wait");
      // No duplicate run or PR, and no merge action across the changed commit.
      expect(github.prs).toHaveLength(0);
      expect(github.autoMerged).toEqual([]);
      expect(github.autoMergeDisabled).toEqual([]);
      expect(readTx(home)).toMatchObject({ phase: "committed", to_id: target.id, from_id: current.id });
      expect(cap.out()).toContain("0.6.0 -> 0.7.0");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("no run starts while admissions are held, and a second worker is never started", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const github = new FakeGitHub();
    for (const n of [1, 2, 3]) github.issues.set(n, ready(n));
    await queueAdd({ factoryHome: home, repo, issues: [1, 2, 3], github }, capture().io);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    let switchPid = 0;
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io,
      release: { id: "old-0.6.0", version: "0.6.0", commit: SHA_A },
    });
    try {
      await waitFor("two slots busy", () => g.calls.length >= 2);
      const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
      const handoff = activateHandoff({
        home, id: target.id, io: cap.io, pollMs: 10,
        startWorker: async (m) => ({ pid: (switchPid = await fakeWorker({ id: m.id, version: m.version, commit: m.commit })) }),
      });
      await waitFor("admission hold", () => admissionHold(home) !== undefined);
      // A finished slot is not refilled while the handoff holds admissions.
      g.release(1, outcome(repo, 1, "done", { pr: "https://github.test/pr/1" }));
      await new Promise((r) => setTimeout(r, 200));
      expect(g.calls).toEqual([1, 2]);
      const dup = await activateHandoff({ home, id: target.id, io: cap.io });
      expect(dup.ok).toBe(false);
      expect(cap.err()).toMatch(/handoff .* in progress/);
      // A second worker cannot take the queue while the old one still holds it.
      await expect(runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 15, start: g.start, io: cap.io })).rejects.toThrow(/already running/);
      g.release(2, outcome(repo, 2, "done", { pr: "https://github.test/pr/2" }));
      const res = await handoff;
      expect(res, cap.err() + cap.out()).toMatchObject({ ok: true });
      expect(g.calls).toEqual([1, 2]);
      expect(g.kills()).toBe(0);
      await waitFor(`the switched worker owns the queue (switch ${switchPid}, holder ${String(workerLockHolder(home))}, worker ${JSON.stringify(currentWorker(home))})`, () => workerLockHolder(home) === switchPid);
      expect(readActive(home)?.id).toBe(target.id);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a worker that does not drain aborts before anything is switched", async () => {
    const repo = createFixtureRepo();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1));
    await queueAdd({ factoryHome: home, repo, issues: [1], github }, capture().io);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io,
      release: { id: "old-0.6.0", version: "0.6.0", commit: SHA_A },
    });
    try {
      await waitFor("a run is live", () => g.calls.length >= 1);
      const current = await approved({ version: "0.6.0", commit: SHA_B });
      writeActive(home, current);
      const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
      const res = await activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, drainTimeoutMs: 150, startWorker: startAsRelease() });
      expect(res.ok).toBe(false);
      expect(cap.err()).toMatch(/did not drain/);
      expect(readActive(home)?.version).toBe("0.6.0");
      expect(admissionHold(home)).toBeUndefined();
      expect(readTx(home)?.phase).toBe("aborted");
      expect(g.kills()).toBe(0);
      expect((await entries(home, repo)).find((e) => e.issue === 1)?.status).toBe("running");
    } finally {
      g.release(1, outcome(repo, 1, "done"));
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("an unhealthy new worker rolls back to the previous version", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    const cap = capture();
    const res = await activateHandoff({
      home, id: target.id, io: cap.io, pollMs: 10, healthTimeoutMs: 500,
      startWorker: async (m) => {
        if (m.version === "0.7.0") {
          // A process that exits at once is not a healthy worker.
          const child = track(spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" }));
          await new Promise((r) => child.on("exit", r));
          return { pid: child.pid ?? 0 };
        }
        return { pid: await fakeWorker({ id: m.id, version: m.version, commit: m.commit }) };
      },
    });
    expect(res.ok).toBe(false);
    expect(cap.err()).toMatch(/rolled back/);
    expect(cap.err()).toMatch(/0\.6\.1/);
    expect(readActive(home)).toMatchObject({ id: previous.id });
    expect(currentWorker(home)).toMatchObject({ version: "0.6.1" });
    expect(readTx(home)?.phase).toBe("rolled_back");
    expect(admissionHold(home)).toBeUndefined();
  });

  it("a rollback over state the previous release cannot read is refused, not attempted", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    // The target writes queue schema 2; the operator acknowledges the migration.
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET, writes: { queue: 2 } });
    writeActive(home, previous);
    const cap = capture();
    const res = await activateHandoff({
      home, id: target.id, io: cap.io, pollMs: 10, healthTimeoutMs: 400, allowMigration: true,
      startWorker: async () => {
        const child = track(spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" }));
        await new Promise((r) => child.on("exit", r));
        return { pid: child.pid ?? 0 };
      },
    });
    expect(res.ok).toBe(false);
    expect(cap.err()).toMatch(/rollback/i);
    expect(cap.err()).toMatch(/queue schema 2/);
    // The state may already be on the new schema: a stale older binary is not started over it.
    expect(readActive(home)?.id).toBe(target.id);
    expect(readTx(home)?.phase).toBe("failed");
    expect(previous.reads.queue).toEqual([1]);
  });

  it("a crash between switch and verification resumes the same transaction", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    const cap = capture();
    // A previous attempt died after the switch, leaving its hold and transaction on disk.
    requestAdmissionHold(home, { state: "drain", tx: "20260101-000000-crash1", reason: "release handoff 20260101-000000-crash1" });
    writeFileSync(
      join(home, "releases", "handoff.json"),
      JSON.stringify({
        schema: 1, id: "20260101-000000-crash1", phase: "switched", from_id: previous.id, to_id: target.id,
        user_mode: "run", started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", steps: [],
      }) + "\n",
    );
    const res = await activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, startWorker: startAsRelease() });
    expect(res.ok, cap.err()).toBe(true);
    expect(readTx(home)).toMatchObject({ phase: "committed", id: "20260101-000000-crash1", to_id: target.id });
    expect(readActive(home)?.id).toBe(target.id);
    expect(admissionHold(home)).toBeUndefined();
    // A different target while another transaction is open is refused.
    const other = await approved({ version: "0.8.0", commit: SHA_B });
    writeFileSync(
      join(home, "releases", "handoff.json"),
      JSON.stringify({
        schema: 1, id: "20260101-000000-open001", phase: "draining", from_id: target.id, to_id: target.id,
        user_mode: "run", started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", steps: [],
      }) + "\n",
    );
    const cap2 = capture();
    expect((await activateHandoff({ home, id: other.id, io: cap2.io })).ok).toBe(false);
    expect(cap2.err()).toMatch(/in progress/);
  });

  it("state compatibility is checked before the switch", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    // A queue file written by a newer schema than this candidate can read.
    mkdirSync(queueDir(home), { recursive: true });
    writeFileSync(join(queueDir(home), "future-1234abcd.json"), JSON.stringify({ version: 2, repo: "/x", repo_key: "future-1234abcd", entries: [] }) + "\n");
    const disk = dataVersionsOnDisk(home);
    expect(disk.queue).toEqual([2]);
    expect(checkCandidateCompat(target, disk).ok).toBe(false);
    expect(checkCandidateCompat(target, disk).reasons.join(" ")).toMatch(/queue schema 2/);
    const cap = capture();
    expect((await activateHandoff({ home, id: target.id, io: cap.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap.err()).toMatch(/cannot read/);
    expect(readActive(home)?.id).toBe(previous.id);
    expect(admissionHold(home)).toBeUndefined();
  });

  it("a migration of durable state needs an explicit acknowledgement first", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET, writes: { queue: 2 } });
    writeActive(home, previous);
    const reasons = checkCandidateCompat(target, dataVersionsOnDisk(home)).reasons.join(" ");
    expect(reasons).toMatch(/migrat/);
    const cap = capture();
    expect((await activateHandoff({ home, id: target.id, io: cap.io, startWorker: startAsRelease() })).ok).toBe(false);
    expect(cap.err()).toMatch(/migrat/);
    expect(readActive(home)?.id).toBe(previous.id);
  });

  it("status reports published, active, worker and run versions separately", async () => {
    const older = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    const pid = await fakeWorker({ id: target.id, version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, target);
    const status = releaseStatus(home);
    expect(status.published.map((p) => p.id).sort()).toEqual([older.id, target.id].sort());
    expect(status.active?.version).toBe("0.7.0");
    expect(status.worker).toMatchObject({ pid, version: "0.7.0", owns_lock: true });
    expect(status.runs).toEqual([]);
    // A run row records the release that started it, so versions stay separate.
    const repo = createFixtureRepo();
    await pushEntries(home, repo, { issue: 7, status: "running", run_id: "20261112-120000-dddddd", pid: process.pid, release_id: older.id, added_at: "2026-01-01T00:00:00Z" });
    const after = releaseStatus(home);
    expect(after.runs).toEqual([{ repo, issue: 7, run_id: "20261112-120000-dddddd", status: "running", release_id: older.id, version: "0.6.1", commit: SHA_A }]);
    expect(after.active?.version).toBe("0.7.0");
    expect(after.worker?.version).toBe("0.7.0");
    const { releaseCommand } = await import("../../src/commands/release.js");
    const cap = capture();
    expect(await releaseCommand(["status", "--json"], { factoryHome: home, io: cap.io })).toBe(0);
    expect((JSON.parse(cap.out()) as typeof status).active?.id).toBe(target.id);
    const bad = capture();
    expect(await releaseCommand(["status", "extra"], { factoryHome: home, io: bad.io })).toBe(2);
  });

  it("the handoff state carries no secret values", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    process.env.FACTORY_TEST_SECRET = "hunter2-not-in-state";
    process.env.INFISICAL_CLIENT_SECRET = "infisical-not-in-state";
    try {
      const res = await activateHandoff({ home, id: target.id, io: capture().io, pollMs: 10, startWorker: startAsRelease() });
      expect(res.ok).toBe(true);
      const blob = ["handoff.json", "active.json", join("candidates", `${target.id}.json`)].map((n) => readFileSync(join(home, "releases", n), "utf8")).join("\n");
      expect(blob).not.toContain("hunter2-not-in-state");
      expect(blob).not.toContain("infisical-not-in-state");
    } finally {
      delete process.env.FACTORY_TEST_SECRET;
      delete process.env.INFISICAL_CLIENT_SECRET;
    }
  });

  it("a drain hold asks only the worker being replaced to leave", async () => {
    const repo = createFixtureRepo();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1));
    await queueAdd({ factoryHome: home, repo, issues: [1], github }, capture().io);
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    requestAdmissionHold(home, { state: "drain", tx: "tx-replace", reason: "handoff", target_release: target.id });
    const g = gate();
    const ctl = new AbortController();
    let exited = false;
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io,
      release: { id: target.id, version: target.version, commit: target.commit },
    }).then(() => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(exited, "the replacement worker must stay up while the hold names it").toBe(false);
    expect(g.calls).toEqual([]);
    expect(currentWorker(home)?.id).toBe(target.id);
    ctl.abort();
    await worker.catch(() => undefined);
  });

  it("a drain hold still drains the worker being replaced", async () => {
    const repo = createFixtureRepo();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1));
    await queueAdd({ factoryHome: home, repo, issues: [1], github }, capture().io);
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    requestAdmissionHold(home, { state: "drain", tx: "tx-leave", reason: "handoff", target_release: target.id });
    const g = gate();
    await runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, start: g.start, io: capture().io,
      release: { id: "old-0.6.0", version: "0.6.0", commit: SHA_A },
    });
    expect(g.calls).toEqual([]);
    expect(currentWorker(home)).toBeUndefined();
  });

  it("a handoff does not unpark, update a branch, spend an approval, or pause the live run", async () => {
    const repo = createFixtureRepo();
    const github = new FakeGitHub();
    github.settings = { private: true, auto_merge_allowed: true, branch_protected: true, required_checks: ["done"] };
    github.issues.set(1, ready(1));
    await queueAdd({ factoryHome: home, repo, issues: [1], github }, capture().io);
    const head = "c".repeat(40);
    const pr = "https://github.test/pr/9";
    const ciRun = "20261112-120000-bbbbbb";
    mkdirSync(join(home, "runs", ciRun), { recursive: true });
    writeFileSync(join(home, "runs", ciRun, "state.json"), JSON.stringify({ version: 1, run_id: ciRun, repo, task: { ref: "#9" }, step: "finished", result: "done", branch: "factory/9-x", pr, approved_sha: head }) + "\n");
    writeFileSync(join(home, "runs", ciRun, "result.json"), JSON.stringify(outcome(repo, 9, "done", { run_id: ciRun, pr, branch: "factory/9-x", merge_policy: "auto" })) + "\n");
    const behindRun = "20261112-120000-cccccc";
    mkdirSync(join(home, "runs", behindRun), { recursive: true });
    writeFileSync(join(home, "runs", behindRun, "result.json"), JSON.stringify(outcome(repo, 8, "done", { run_id: behindRun, pr: "https://github.test/pr/8", branch: "factory/8-x", merge_policy: "human_review" })) + "\n");
    await pushEntries(home, repo, { issue: 7, status: "parked", blocked_by: [12], reason: "planned paths overlap open factory PR #12", added_at: "2026-01-01T00:00:00Z" });
    github.prStates.set("12", { state: "open", draft: false });

    const current = await approved({ version: "0.6.0", commit: SHA_A });
    writeActive(home, current);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io,
      release: { id: current.id, version: current.version, commit: current.commit },
    });
    try {
      await waitFor("a run is live", () => g.calls.length >= 1);
      const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
      const handoff = activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, drainTimeoutMs: 10_000, startWorker: startAsRelease() });
      await waitFor("admission hold", () => admissionHold(home) !== undefined);
      // Plant the mutations only after the hold, so a pre-hold tick cannot explain them.
      github.issues.set(1, { ...ready(1), labels: [] });
      github.factoryPrs.push({ number: 8, branch: "factory/8-x", files: ["src/a.js"] });
      github.prStates.set("8", { state: "open", draft: false, behind: true });
      github.prs.push({ repoDir: repo, head: "factory/9-x", base: "main", title: "t", body: "b", draft: false, url: pr });
      github.remoteShas.set("factory/9-x", head);
      github.prStates.set(pr, { state: "open", draft: false, ci: "green", behind: false });
      github.prStates.set("12", { state: "merged", draft: false });
      await new Promise((r) => setTimeout(r, 250));
      expect(github.updatedBranches, cap.out() + cap.err()).toEqual([]);
      expect(github.autoMerged).toEqual([]);
      expect(github.autoMergeDisabled).toEqual([]);
      expect(github.approvedShas).toEqual([]);
      expect(existsSync(join(home, "queue", "pause"))).toBe(false);
      expect((await entries(home, repo)).find((e) => e.issue === 7)?.status).toBe("parked");
      expect(readFileSync(join(home, "runs", ciRun, "state.json"), "utf8")).toContain(head);
      g.release(1, outcome(repo, 1, "done", { pr: "https://github.test/pr/1" }));
      const res = await handoff;
      expect(res.ok, cap.err()).toBe(true);
      expect(g.kills()).toBe(0);
      expect(github.updatedBranches).toEqual([]);
      expect(github.autoMerged).toEqual([]);
      expect((await entries(home, repo)).find((e) => e.issue === 7)?.status).toBe("parked");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("resuming verification does not start a second worker", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, target, previous.id);
    const pid = await fakeWorker({ id: target.id, version: target.version, commit: target.commit });
    requestAdmissionHold(home, { state: "hold", tx: "20260101-000000-verify1", reason: "verifying", target_release: target.id });
    writeFileSync(
      join(home, "releases", "handoff.json"),
      JSON.stringify({
        schema: 1, id: "20260101-000000-verify1", phase: "verifying", from_id: previous.id, to_id: target.id,
        user_mode: "pause", migration: false, started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", steps: [],
      }) + "\n",
    );
    let starts = 0;
    const cap = capture();
    const res = await activateHandoff({
      home, id: target.id, io: cap.io, pollMs: 10,
      startWorker: async () => {
        starts += 1;
        throw new Error("duplicate start");
      },
    });
    expect(starts, cap.err()).toBe(0);
    expect(res.ok, cap.err()).toBe(true);
    expect(currentWorker(home)?.pid).toBe(pid);
    expect(workerLockHolder(home)).toBe(pid);
    expect(readTx(home)?.phase).toBe("committed");
    expect(readWorkerMode(home)).toBe("pause");
    expect(admissionHold(home)).toBeUndefined();
  });

  it("a crashed switch does not start the new worker under a drain hold", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, target, previous.id);
    writeWorkerMode(home, "drain");
    requestAdmissionHold(home, { state: "drain", tx: "20260101-000000-switch1", reason: "drain", target_release: target.id });
    writeFileSync(
      join(home, "releases", "handoff.json"),
      JSON.stringify({
        schema: 1, id: "20260101-000000-switch1", phase: "switched", from_id: previous.id, to_id: target.id,
        user_mode: "pause", migration: false, started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", steps: [],
      }) + "\n",
    );
    let seen: string | undefined;
    const cap = capture();
    const res = await activateHandoff({
      home, id: target.id, io: cap.io, pollMs: 10,
      startWorker: async (c) => {
        seen = admissionHold(home)?.state;
        if (seen === "drain" || readWorkerMode(home) === "drain") {
          const child = track(spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }));
          await new Promise((r) => child.on("exit", r));
          return { pid: child.pid ?? 0 };
        }
        return { pid: await fakeWorker({ id: c.id, version: c.version, commit: c.commit }) };
      },
    });
    expect(seen, cap.err()).toBe("hold");
    expect(res.ok, cap.err()).toBe(true);
    expect(readWorkerMode(home)).toBe("pause");
    expect(admissionHold(home)).toBeUndefined();
    expect(currentWorker(home)?.id).toBe(target.id);
    expect(readTx(home)?.phase).toBe("committed");
  });

  it("a crashed switch whose artifact changed releases the queue and rolls back", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, target, previous.id);
    writeWorkerMode(home, "drain");
    requestAdmissionHold(home, { state: "drain", tx: "20260101-000000-tamper1", reason: "drain", target_release: target.id });
    writeFileSync(
      join(home, "releases", "handoff.json"),
      JSON.stringify({
        schema: 1, id: "20260101-000000-tamper1", phase: "switched", from_id: previous.id, to_id: target.id,
        user_mode: "pause", migration: false, started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", steps: [],
      }) + "\n",
    );
    const file = join(candidateDir(home, target.id), "dist", "cli.js");
    unseal(candidateDir(home, target.id), file);
    writeFileSync(file, "// tampered\n");
    const cap = capture();
    const res = await activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, startWorker: startAsRelease() });
    expect(res.ok).toBe(false);
    expect(admissionHold(home), cap.err()).toBeUndefined();
    expect(readTx(home)?.phase).toMatch(/rolled_back|failed|aborted/);
    expect(readWorkerMode(home)).toBe("pause");
    expect(readActive(home)?.id).toBe(previous.id);
    expect(currentWorker(home)?.id).not.toBe(target.id);
  });

  it("a live handoff lock refuses a second activation", async () => {
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    const child = track(spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" }));
    const pid = await new Promise<number>((resolve) => child.on("spawn", () => resolve(child.pid ?? 0)));
    mkdirSync(join(home, "releases"), { recursive: true });
    writeFileSync(join(home, "releases", "handoff.lock"), `${pid}\nrelease-handoff\n`);
    const cap = capture();
    const res = await activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, startWorker: startAsRelease() });
    expect(res.ok).toBe(false);
    expect(cap.err()).toMatch(/in progress/);
    expect(readActive(home)).toBeUndefined();
    expect(admissionHold(home)).toBeUndefined();
  });

  it("a dead handoff lock does not block a crash resume", async () => {
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    const child = track(spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }));
    const pid = await new Promise<number>((resolve, reject) => {
      child.on("spawn", () => resolve(child.pid ?? 0));
      child.on("error", reject);
    });
    await new Promise((r) => child.on("exit", r));
    mkdirSync(join(home, "releases"), { recursive: true });
    writeFileSync(join(home, "releases", "handoff.lock"), `${pid}\nrelease-handoff\n`);
    const cap = capture();
    const res = await activateHandoff({ home, id: target.id, io: cap.io, pollMs: 10, startWorker: startAsRelease() });
    expect(res.ok, cap.err()).toBe(true);
    expect(readActive(home)?.id).toBe(target.id);
  });

  it("a worker that fails to start rolls back and releases the queue", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    writeWorkerMode(home, "drain");
    const cap = capture();
    const res = await activateHandoff({
      home, id: target.id, io: cap.io, pollMs: 10,
      startWorker: async () => {
        throw new Error("cli missing");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.phase).toMatch(/rolled_back|failed/);
    expect(readActive(home)?.id).toBe(previous.id);
    expect(admissionHold(home)).toBeUndefined();
    expect(readWorkerMode(home)).toBe("drain");
    expect(readTx(home)?.phase).toMatch(/rolled_back|failed/);
    expect(cap.err()).toMatch(/cli missing/);
  });

  it("plan previews the switch and writes nothing", async () => {
    const previous = await approved({ version: "0.6.1", commit: SHA_A });
    const target = await approved({ version: "0.7.0", commit: SHA_TARGET });
    writeActive(home, previous);
    const { releaseCommand } = await import("../../src/commands/release.js");
    const cap = capture();
    expect(await releaseCommand(["plan", target.id], { factoryHome: home, io: cap.io })).toBe(0);
    expect(cap.out()).toContain(target.version);
    expect(cap.out()).toContain(previous.version);
    expect(cap.out()).toMatch(/compatible/);
    expect(cap.out()).toContain("switch back");
    expect(readActive(home)?.id).toBe(previous.id);
    expect(admissionHold(home)).toBeUndefined();
    expect(readTx(home)).toBeUndefined();
    const denied = capture();
    expect(await releaseCommand(["activate", target.id], { factoryHome: home, io: denied.io })).toBe(2);
    expect(readActive(home)?.id).toBe(previous.id);
  });
});
