import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queueAdd, queueCommand, queueRun } from "../../src/commands/queue.js";
import type { Io } from "../../src/commands/gates.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { issueRevision } from "../../src/queue/admit.js";
import { readWorkerMode, writeWorkerMode } from "../../src/queue/control.js";
import { loadQueueByKey, queueDir, repoQueueKey, updateQueue, type QueueEntry } from "../../src/queue/store.js";
import { nextPollMs, runQueue, type StartRun, type StartRunRequest } from "../../src/queue/worker.js";
import { createFixtureRepo } from "../helpers/repo.js";

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { out: (s) => void (out += s), err: (s) => void (err += s) }, out: () => out, err: () => err };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "factory-lifecycle-"));
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

async function entries(factoryHome: string, repo: string): Promise<QueueEntry[]> {
  const key = await repoQueueKey(repo);
  return loadQueueByKey(factoryHome, key)?.entries ?? [];
}

async function queueText(factoryHome: string, repo: string): Promise<string> {
  const key = await repoQueueKey(repo);
  return readFileSync(join(queueDir(factoryHome), `${key}.json`), "utf8");
}

async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function gate(): { start: StartRun; calls: number[]; requests: StartRunRequest[]; release: (issue: number, result: RunResult) => void; kills: number } {
  const calls: number[] = [];
  const requests: StartRunRequest[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  let kills = 0;
  return {
    calls,
    requests,
    get kills() {
      return kills;
    },
    release(issue, result) {
      const resolve = pending.get(issue);
      if (!resolve) throw new Error(`no pending start for #${issue}`);
      resolve(result);
    },
    start: (req) => {
      calls.push(req.issue);
      requests.push(req);
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => {
        resolve = r;
      });
      pending.set(req.issue, resolve);
      return { done, pid: 0, runId: () => req.runId, kill: () => void (kills += 1), unref: () => undefined };
    },
  };
}

async function enqueue(factoryHome: string, repo: string, github: FakeGitHub, issues: number[], after?: number): Promise<void> {
  for (const n of issues) if (!github.issues.has(n)) github.issues.set(n, ready(n));
  expect(await queueAdd({ factoryHome, repo, issues, after, github }, capture().io)).toBe(0);
}

function resourceLock(factoryHome: string): string {
  const name = readdirSync(join(factoryHome, "locks")).find((n) => n.startsWith("resource."));
  if (!name) throw new Error("no resource lock");
  return join(factoryHome, "locks", name);
}

describe("queue lifecycle", () => {
  it("backs off and stays inside the cap", () => {
    expect(nextPollMs(20, 0, () => 0)).toBe(20);
    expect(nextPollMs(20, 1, () => 0)).toBe(32);
    expect(nextPollMs(20, 2, () => 0)).toBe(64);
    expect(nextPollMs(20, 1, () => 1)).toBe(40);
    expect(nextPollMs(60_000, 6, () => 1)).toBe(5 * 60_000);
  });

  it("a second start does not create a second worker", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const g = gate();
    const ctl = new AbortController();
    const first = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("first start", () => g.calls.length === 1);
      await expect(runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, start: g.start, io: capture().io })).rejects.toThrow(/already running/);
      const cap = capture();
      expect(await queueRun({ factoryHome, github, repo, slots: 1, pollMs: 15, start: g.start }, cap.io)).toBe(1);
      expect(cap.err()).toContain("a queue worker is already running");
      expect(g.calls).toEqual([1]);
    } finally {
      ctl.abort();
      await first.catch(() => undefined);
    }
  });

  it("idle --stay backs off and does not start a model", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const ctl = new AbortController();
    const waits: number[] = [];
    const cap = capture();
    let starts = 0;
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 2,
      pollMs: 20,
      stay: true,
      random: () => 0,
      signal: ctl.signal,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 3) ctl.abort();
      },
      start: () => {
        starts += 1;
        throw new Error("no task");
      },
      io: cap.io,
    });
    expect(starts).toBe(0);
    expect(waits[0]).toBeGreaterThanOrEqual(20);
    expect(waits[2]).toBeGreaterThan(waits[0]!);
    expect(cap.out()).toContain("queue: stopped");
    expect(cap.out()).not.toContain("queue: idle");
  });

  it("an API failure while work is pending backs off instead of spinning", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    github.getIssue = async () => {
      throw new Error("Connection error.");
    };
    const ctl = new AbortController();
    const waits: number[] = [];
    const cap = capture();
    let starts = 0;
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 20,
      random: () => 0,
      signal: ctl.signal,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 3) ctl.abort();
      },
      start: () => {
        starts += 1;
        throw new Error("should not start");
      },
      io: cap.io,
    });
    expect(starts).toBe(0);
    expect(cap.err()).toContain("Connection error.");
    expect(waits[2]).toBeGreaterThan(waits[0]!);
    expect((await entries(factoryHome, repo))[0]?.status).toBe("pending");
  });

  it("pause blocks new starts and resume allows them", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    writeWorkerMode(factoryHome, "pause");
    const g = gate();
    const ctl = new AbortController();
    let ticks = 0;
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 2,
      pollMs: 15,
      signal: ctl.signal,
      sleep: async () => {
        ticks += 1;
      },
      start: g.start,
      io: capture().io,
    });
    try {
      await waitFor("paused ticks", () => ticks >= 2);
      expect(g.calls).toEqual([]);
      expect((await entries(factoryHome, repo)).map((e) => e.status)).toEqual(["pending", "pending"]);
      const resumed = capture();
      expect(await queueCommand(["resume"], { factoryHome, github, io: resumed.io })).toBe(0);
      expect(readWorkerMode(factoryHome)).toBe("run");
      await waitFor("resumed", () => g.calls.length === 2);
      g.release(1, outcome(repo, 1, "done"));
      g.release(2, outcome(repo, 2, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("drain finishes the active run, keeps the waiting issue and the CI artifact, and does not signal it", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    await enqueue(factoryHome, repo, github, [2], 1);
    const pr = "https://github.test/pull/1";
    github.prStates.set(pr, { state: "open", draft: false, ci: "pending" });
    const ciRun = "20261112-120000-cccccc";
    const ciDir = join(factoryHome, "runs", ciRun);
    mkdirSync(ciDir, { recursive: true });
    writeFileSync(join(ciDir, "state.json"), JSON.stringify({
      version: 1, run_id: ciRun, repo, task: { ref: "#9", title: "t", text: "", labels: [] },
      step: "finished", result: "done", reason: "", branch: "factory/9-goal", pr, ci_wait: "pending",
    }));
    writeFileSync(join(ciDir, "result.json"), JSON.stringify(outcome(repo, 9, "done", { run_id: ciRun, pr, merge_policy: "auto" })) + "\n");
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io });
    try {
      await waitFor("active", () => g.calls.length === 1);
      expect(await queueCommand(["drain"], { factoryHome, github, io: capture().io })).toBe(0);
      g.release(1, outcome(repo, 1, "done", { pr }));
      github.prStates.set(pr, { state: "merged", draft: false, ci: "green" });
      await worker;
      expect(g.calls).toEqual([1]);
      expect(g.kills).toBe(0);
      expect(cap.out()).toContain("queue: drained");
      expect((await entries(factoryHome, repo)).find((e) => e.issue === 2)?.status).toBe("pending");
      expect(readFileSync(join(ciDir, "state.json"), "utf8")).toContain("ci_wait");
      expect(github.autoMerged).toEqual([]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("stop exits without killing the live run", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const g = gate();
    const ctl = new AbortController();
    const cap = capture();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io });
    try {
      await waitFor("running", () => g.calls.length === 1);
      expect(await queueCommand(["stop"], { factoryHome, github, io: capture().io })).toBe(0);
      await worker;
      expect(cap.out()).toContain("queue: stopped");
      expect(g.kills).toBe(0);
      expect((await entries(factoryHome, repo))[0]?.status).toBe("running");
      expect(readWorkerMode(factoryHome)).toBe("run");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a crash before the run directory restores the issue once and drops only a dead claim", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 1, resources: ["db"] }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const oldId = "20261112-120000-aaaaaa";
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.status = "running";
      q.entries[0]!.run_id = oldId;
    });
    mkdirSync(join(factoryHome, "locks"), { recursive: true });
    writeFileSync(join(factoryHome, "locks", "resource.db.lock"), `2147483646\n${oldId}\n`);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("restarted once", () => g.calls.length === 1);
      expect(g.requests[0]?.resumeRunId).toBeUndefined();
      expect(g.requests[0]?.runId).not.toBe(oldId);
      expect(readFileSync(resourceLock(factoryHome), "utf8")).not.toContain("2147483646");
      expect(readFileSync(resourceLock(factoryHome), "utf8")).toContain(g.requests[0]!.runId!);
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls).toEqual([1]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a live owner's resource claim is not released and the issue is not started again", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 1, resources: ["db"] }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const oldId = "20261112-120000-bbbbbb";
      await updateQueue(factoryHome, repo, (q) => {
        q.entries[0]!.status = "running";
        q.entries[0]!.run_id = oldId;
      });
      mkdirSync(join(factoryHome, "locks"), { recursive: true });
      writeFileSync(join(factoryHome, "locks", "resource.db.lock"), `${sleeper.pid}\nlive-hold\n`);
      const ctl = new AbortController();
      let starts = 0;
      const worker = runQueue({
        factoryHome,
        github,
        repo,
        slots: 1,
        pollMs: 15,
        signal: ctl.signal,
        start: () => {
          starts += 1;
          throw new Error("should not start");
        },
        io: capture().io,
      });
      try {
        await waitFor("still held", async () => (await entries(factoryHome, repo))[0]?.reason?.includes("resource db") === true);
        expect(starts).toBe(0);
        expect(readFileSync(resourceLock(factoryHome), "utf8")).toContain(String(sleeper.pid));
        expect(sleeper.exitCode).toBeNull();
      } finally {
        ctl.abort();
        await worker.catch(() => undefined);
      }
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("a crash after the checkpoint resumes the same run id", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261112-120000-abc123";
    const dir = join(factoryHome, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), "{}\n");
    writeFileSync(join(dir, "worktree"), repo);
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ version: 1, run_id: runId, repo, step: "implement", task: { ref: "#1", issue: 1, title: "Issue 1", text: "Do the work.", labels: ["factory-ready"] } }) + "\n");
    // Newer than the starting grace, so a restart does not treat this dead run as still launching.
    const old = new Date(Date.now() - 60_000);
    utimesSync(statePath, old, old);
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.status = "running";
      q.entries[0]!.run_id = runId;
      q.entries[0]!.issue_rev = issueRevision("Issue 1", "Do the work.");
    });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("resumed", () => g.calls.length === 1);
      expect(g.requests[0]).toMatchObject({ resumeRunId: runId, runId });
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls).toEqual([1]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("preview reports order and limits and does not write", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 1 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    await enqueue(factoryHome, repo, github, [2], 1);
    const before = await queueText(factoryHome, repo);
    const cap = capture();
    expect(await queueCommand(["preview", "--repo", repo, "--slots", "2"], { factoryHome, github, io: cap.io })).toBe(0);
    expect(await queueText(factoryHome, repo)).toBe(before);
    const text = cap.out();
    expect(text).toContain("preview: no writes");
    expect(text).toContain("mode: run");
    expect(text).toContain("slots: 2");
    expect(text).toContain("max_runs 1");
    expect(text).toContain("#1  would_start");
    expect(text).toContain("#2  waiting  after #1");
    const again = capture();
    expect(await queueCommand(["preview", "--repo", repo, "--slots", "2", "--json"], { factoryHome, github, io: again.io })).toBe(0);
    const report = JSON.parse(again.out()) as { writes: boolean; repos: { lines: { issue: number; disposition: string }[] }[] };
    expect(report.writes).toBe(false);
    expect(report.repos[0]?.lines.map((row) => `${row.issue}:${row.disposition}`)).toEqual(["1:would_start", "2:waiting"]);
    expect(await queueText(factoryHome, repo)).toBe(before);
    writeWorkerMode(factoryHome, "pause");
    const paused = capture();
    expect(await queueCommand(["preview", "--repo", repo], { factoryHome, github, io: paused.io })).toBe(0);
    expect(paused.out()).toContain("mode: pause");
    expect(paused.out()).toContain("#1  held  pause");
    expect(paused.out()).not.toContain("would_start");
  });
});
