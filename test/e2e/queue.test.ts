import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { queueAdd, queueList, queueRemove } from "../../src/commands/queue.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import type { Io } from "../../src/commands/gates.js";
import type { RunResult } from "../../src/events.js";
import { repoLockId } from "../../src/git.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { activeHolders, lockRepoKey, tryPathLock } from "../../src/pipeline/lock.js";
import { runFactory } from "../../src/pipeline/run.js";
import { factoryRunArgs } from "../../src/queue/spawn.js";
import { loadQueueByKey, queueDir, repoQueueKey, updateQueue, type QueueEntry } from "../../src/queue/store.js";
import { runQueue, type StartRun } from "../../src/queue/worker.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { FIXTURES, createFixtureRepo } from "../helpers/repo.js";

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { out: (s) => void (out += s), err: (s) => void (err += s) }, out: () => out, err: () => err };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "factory-queue-"));
}

function ready(n: number, extra: Partial<Issue> = {}): Issue {
  return { number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open", ...extra };
}

function outcome(repo: string, issue: number, result: RunResult["result"], reason = "", extra: Partial<RunResult> = {}): RunResult {
  return {
    run_id: `20261029-120000-${issue.toString(16).padStart(6, "0")}`,
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
    reason,
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

async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function gate(): { start: StartRun; calls: number[]; release: (issue: number, result: RunResult) => void } {
  const calls: number[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  return {
    calls,
    release(issue, result) {
      const resolve = pending.get(issue);
      if (!resolve) throw new Error(`no pending start for #${issue}`);
      resolve(result);
    },
    start: ({ issue }) => {
      calls.push(issue);
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => {
        resolve = r;
      });
      pending.set(issue, resolve);
      return { done, pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
    },
  };
}

async function enqueue(factoryHome: string, repo: string, github: FakeGitHub, issues: number[], after?: number): Promise<void> {
  for (const n of issues) if (!github.issues.has(n)) github.issues.set(n, ready(n));
  const cap = capture();
  expect(await queueAdd({ factoryHome, repo, issues, after, github }, cap.io)).toBe(0);
}

describe("factory queue", () => {
  it("refuses closed, unlabelled and needs-plan issues at add, and removes entries", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1));
    github.issues.set(2, ready(2, { state: "closed" }));
    github.issues.set(3, ready(3, { labels: [] }));
    github.issues.set(4, ready(4, { labels: ["factory-ready", "needs-plan"] }));
    const cap = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [1, 2], github }, cap.io)).toBe(1);
    expect(cap.err()).toContain("#2 is closed");
    expect(await entries(factoryHome, repo)).toEqual([]);

    const missing = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [3], github }, missing.io)).toBe(1);
    expect(missing.err()).toContain("lacks the factory-ready label");
    const plan = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [4], github }, plan.io)).toBe(1);
    expect(plan.err()).toContain("carries needs-plan");
    expect(await entries(factoryHome, repo)).toEqual([]);

    await enqueue(factoryHome, repo, github, [1]);
    github.issues.set(5, ready(5));
    expect(await queueAdd({ factoryHome, repo, issues: [5], after: 1, github }, capture().io)).toBe(0);
    const listed = capture();
    expect(await queueList({ factoryHome, repo, json: true }, listed.io)).toBe(0);
    const json = JSON.parse(listed.out()) as { queues: { entries: { issue: number; status: string; after: number | null; order: number }[] }[] };
    expect(json.queues[0]!.entries.map((e) => [e.order, e.issue, e.status, e.after])).toEqual([
      [1, 1, "pending", null],
      [2, 5, "pending", 1],
    ]);
    expect(await queueRemove({ factoryHome, repo, issues: [1] }, capture().io)).toBe(0);
    expect((await entries(factoryHome, repo)).map((e) => e.issue)).toEqual([5]);

    const status = await statusReport({ factoryHome, github });
    expect(status.queues[0]).toMatchObject({ pending: 1, running: 0, parked: 0 });
    expect(status.queues[0]!.next[0]).toMatchObject({ issue: 5, status: "pending", reason: "after #1" });
    expect(renderStatus(status)).toContain("pending 1, running 0, parked 0");
    expect(renderStatus(status)).toContain("#5 pending after #1");
  });

  it("starts in queue order up to the slot limit and refills when a run ends", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2, 3]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("two starts", () => g.calls.length >= 2);
      await new Promise((r) => setTimeout(r, 60));
      expect(g.calls).toEqual([1, 2]);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await waitFor("refill", () => g.calls.includes(3));
      expect(g.calls).toEqual([1, 2, 3]);
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      g.release(3, outcome(repo, 3, "done", "", { pr: "https://github.test/pr/3" }));
      await worker;
      expect((await entries(factoryHome, repo)).map((e) => [e.issue, e.status, e.pr])).toEqual([
        [1, "done", "https://github.test/pr/1"],
        [2, "done", "https://github.test/pr/2"],
        [3, "done", "https://github.test/pr/3"],
      ]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("requeues a transient needs_human at most twice, behind the issues still waiting", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    const transient = () => Object.assign(outcome(repo, 1, "needs_human", "transient capacity error after retries: overloaded"), { transient: true });
    try {
      await waitFor("first", () => g.calls.length === 1);
      g.release(1, transient());
      await waitFor("second issue first", () => g.calls.length === 2);
      expect(g.calls).toEqual([1, 2]);
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await waitFor("requeue 1", () => g.calls.length === 3);
      g.release(1, transient());
      await waitFor("requeue 2", () => g.calls.length === 4);
      expect(g.calls).toEqual([1, 2, 1, 1]);
      g.release(1, transient());
      await worker;
      const rows = await entries(factoryHome, repo);
      expect(rows.find((e) => e.issue === 1)).toMatchObject({ status: "parked", requeues: 3 });
      expect(rows.find((e) => e.issue === 1)!.reason).toMatch(/^transient capacity/);
      expect(g.calls).toEqual([1, 2, 1, 1]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("parks needs_human, needs_input, failed and base_red and does not resume them", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 4 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2, 3, 4]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 4, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("all started", () => g.calls.length === 4);
      g.release(1, outcome(repo, 1, "needs_human", "review found a bug"));
      g.release(2, outcome(repo, 2, "needs_input", "which file?"));
      g.release(3, outcome(repo, 3, "failed", "worktree missing"));
      g.release(4, outcome(repo, 4, "base_red", "CI on main is red"));
      await worker;
      const rows = await entries(factoryHome, repo);
      expect(rows.map((e) => [e.issue, e.status, e.reason])).toEqual([
        [1, "parked", "review found a bug"],
        [2, "parked", "which file?"],
        [3, "parked", "worktree missing"],
        [4, "parked", "CI on main is red"],
      ]);
      expect(g.calls).toEqual([1, 2, 3, 4]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("parks an overlap with an open factory PR and starts again once that PR closes", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    github.prStates.set("9", { state: "open", draft: false });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("started", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "locked", "planned paths overlap open factory PR #9 (src/math.js)"));
      await waitFor("parked", async () => (await entries(factoryHome, repo))[0]?.status === "parked");
      expect((await entries(factoryHome, repo))[0]).toMatchObject({ status: "parked", blocked_by: [9] });
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls).toEqual([1]);
      github.prStates.set("9", { state: "closed", draft: false });
      await waitFor("unparked start", () => g.calls.length === 2);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
      expect((await entries(factoryHome, repo))[0]?.status).toBe("done");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("waits for --after until that issue's factory PR is merged", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    await enqueue(factoryHome, repo, github, [2], 1);
    const pr = "https://github.test/pr/1";
    github.prStates.set(pr, { state: "open", draft: false });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("dependency started", () => g.calls.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(g.calls).toEqual([1]);
      g.release(1, outcome(repo, 1, "done", "", { pr }));
      await new Promise((r) => setTimeout(r, 50));
      expect(g.calls).toEqual([1]);
      github.prStates.set(pr, { state: "merged", draft: false });
      await waitFor("after started", () => g.calls.includes(2));
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await worker;
      expect((await entries(factoryHome, repo)).map((e) => e.status)).toEqual(["done", "done"]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("does not start --after when the dependency PR closed without merge", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    await enqueue(factoryHome, repo, github, [2], 1);
    const pr = "https://github.test/pr/1";
    github.prStates.set(pr, { state: "open", draft: false });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("dependency started", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "done", "", { pr }));
      github.prStates.set(pr, { state: "closed", draft: false });
      await waitFor("dependent parked", async () => (await entries(factoryHome, repo))[1]?.status === "parked");
      expect(g.calls).toEqual([1]);
      expect((await entries(factoryHome, repo))[1]?.reason).toBe("after #1 closed without merge");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("does not start while base CI is red, and skips a closed issue or an open factory PR", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    github.status = "red";
    await enqueue(factoryHome, repo, github, [1]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(g.calls).toEqual([]);
      github.status = "none";
      await waitFor("started after green", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    await enqueue(home2, repo2, gh2, [7, 8]);
    gh2.issues.set(7, ready(7, { state: "closed" }));
    gh2.factoryPrs.push({ number: 4, branch: "factory/8-goal", files: ["src/a.js"] });
    const g2 = gate();
    await runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 2, pollMs: 15, start: g2.start, io: capture().io });
    expect(g2.calls).toEqual([]);
    const rows = await entries(home2, repo2);
    expect(rows.find((e) => e.issue === 7)?.reason).toBe("issue closed");
    expect(rows.find((e) => e.issue === 8)?.reason).toBe("open factory PR #4");
  });

  it("a restarted worker adopts a live run and does not start the issue again", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const ac = new AbortController();
    let calls = 0;
    const runner = new FakeRunner([{ role: "plan_high", silent_ms: 1, output: { version: 1 } }], (_ms, signal) => new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
    }));
    const profile = loadProfile(join(FIXTURES, "profile.yaml"));
    const start: StartRun = ({ issue }) => {
      calls += 1;
      const done = runFactory({ repo, issue, noPr: true }, { runner, github, profile, factoryHome, signal: ac.signal, noNotify: true });
      return { done, pid: 0, runId: () => undefined, kill: () => ac.abort(), unref: () => undefined };
    };
    const ctl = new AbortController();
    const first = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start, io: capture().io });
    try {
      await waitFor("lock", () => activeHolders(factoryHome).length > 0);
      expect(calls).toBe(1);
      expect((await entries(factoryHome, repo))[0]?.status).toBe("running");
      ctl.abort();
      await first;
      const ctl2 = new AbortController();
      const second = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl2.signal, start, io: capture().io });
      await new Promise((r) => setTimeout(r, 120));
      expect(calls).toBe(1);
      expect((await entries(factoryHome, repo))[0]?.status).toBe("running");
      ctl2.abort();
      await second;
    } finally {
      ac.abort();
      ctl.abort();
    }
  });

  it("reads result.json on restart and does not start that issue again", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-120000-abcdef";
    const runDir = join(factoryHome, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const result = outcome(repo, 1, "done", "", { run_id: runId, pr: "https://github.test/pr/3", branch: "factory/1-goal" });
    writeFileSync(join(runDir, "result.json"), JSON.stringify(result) + "\n");
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, run_id: runId, repo, task: { ref: "#1", issue: 1, title: "t", text: "", labels: [] }, result: "done", branch: "factory/1-goal" }) + "\n");
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.status = "running";
      q.entries[0]!.run_id = runId;
    });
    let calls = 0;
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      start: () => {
        calls += 1;
        return { done: new Promise(() => undefined), pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
      },
      io: capture().io,
    });
    expect(calls).toBe(0);
    expect((await entries(factoryHome, repo))[0]).toMatchObject({ status: "done", pr: "https://github.test/pr/3", run_id: runId });
  });

  it("updates a behind factory PR whose run ended done, once", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-130000-bbbbbb";
    const runDir = join(factoryHome, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "result.json"), JSON.stringify(outcome(repo, 99, "done", "", { run_id: runId, pr: "https://github.test/pr/7", branch: "factory/99-goal" })) + "\n");
    github.factoryPrs.push({ number: 8, branch: "factory/100-other", files: ["src/b.js"] });
    github.prStates.set("8", { state: "open", draft: false, behind: true });
    github.factoryPrs.push({ number: 7, branch: "factory/99-goal", files: ["src/a.js"] });
    github.prStates.set("7", { state: "open", draft: false, behind: true });
    const otherId = "20261029-130001-dddddd";
    mkdirSync(join(factoryHome, "runs", otherId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", otherId, "result.json"), JSON.stringify(outcome(repo, 100, "done", "", { run_id: otherId, pr: "https://github.test/pr/9", branch: "factory/101-goal" })) + "\n");
    github.factoryPrs.push({ number: 9, branch: "factory/101-goal", files: ["src/c.js"] });
    github.prStates.set("9", { state: "open", draft: false, behind: true });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("issue started", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
      expect(github.updatedBranches).toEqual(["7", "9"]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("does not treat an older result.json as the outcome of a later run that wrote none", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const oldId = "20261029-120000-aaaaaa";
    const newId = "20261029-150000-bbbbbb";
    mkdirSync(join(factoryHome, "runs", oldId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", oldId, "result.json"), JSON.stringify(outcome(repo, 1, "done", "", { run_id: oldId, pr: "https://github.test/pr/1" })) + "\n");
    writeFileSync(join(factoryHome, "runs", oldId, "state.json"), JSON.stringify({ version: 1, run_id: oldId, repo, task: { ref: "#1", issue: 1, title: "t", text: "", labels: [] }, result: "done" }) + "\n");
    const fresh = join(factoryHome, "runs", newId);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "state.json"), JSON.stringify({ version: 1, run_id: newId, repo, task: { ref: "#1", issue: 1, title: "t", text: "", labels: [] }, result: null, step: "implement" }) + "\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(fresh, "state.json"), old, old);
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.status = "running";
      q.entries[0]!.run_id = newId;
    });
    let calls = 0;
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      start: () => {
        calls += 1;
        return { done: new Promise(() => undefined), pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
      },
      io: capture().io,
    });
    expect(calls).toBe(0);
    expect((await entries(factoryHome, repo))[0]).toMatchObject({ status: "parked", run_id: newId, reason: "run ended without result.json" });
  });

  it("keeps the slot after a stall until the process exits, then SIGKILLs and parks", async () => {
    const repo = createFixtureRepo((c) => {
      const limits = (c.limits ?? {}) as Record<string, unknown>;
      limits.stall_minutes = 1;
      c.limits = limits;
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    const runId = "20261029-140000-cccccc";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", runId, "events.jsonl"), "{\"event\":\"progress\"}\n");
    const signals: NodeJS.Signals[] = [];
    let resolveDone: (r: RunResult) => void = () => undefined;
    let clock = 1_700_000_000_000;
    let step = false;
    const ctl = new AbortController();
    const g = gate();
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 20,
      now: () => {
        if (step) clock += 10_000;
        return clock;
      },
      signal: ctl.signal,
      io: capture().io,
      start: ({ issue }) => {
        if (issue === 2) return g.start({ repo, issue, factoryHome });
        return {
          done: new Promise<RunResult>((r) => {
            resolveDone = r;
          }),
          pid: 0,
          runId: () => runId,
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM");
            if (signal === "SIGKILL") resolveDone(outcome(repo, 1, "failed", "killed"));
          },
          unref: () => undefined,
        };
      },
    });
    try {
      await waitFor("run id recorded", async () => (await entries(factoryHome, repo))[0]?.run_id === runId);
      step = true;
      await waitFor("sigterm", () => signals.includes("SIGTERM"));
      await new Promise((r) => setTimeout(r, 40));
      expect(signals).toEqual(["SIGTERM"]);
      expect(g.calls).toEqual([]);
      expect((await entries(factoryHome, repo)).find((e) => e.issue === 1)?.status).toBe("running");
      expect((await entries(factoryHome, repo)).find((e) => e.issue === 2)?.status).toBe("pending");
      await waitFor("sigkill", () => signals.includes("SIGKILL"));
      await waitFor("issue 2", () => g.calls.includes(2));
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await worker;
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(g.calls).toEqual([2]);
      const rows = await entries(factoryHome, repo);
      expect(rows.find((e) => e.issue === 1)).toMatchObject({ status: "parked" });
      expect(rows.find((e) => e.issue === 1)?.reason).toMatch(/stalled/);
      expect(rows.find((e) => e.issue === 2)?.status).toBe("done");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("does not stall a run when the wall clock jumps by much more than the tick", async () => {
    const repo = createFixtureRepo((c) => {
      const limits = (c.limits ?? {}) as Record<string, unknown>;
      limits.stall_minutes = 1;
      c.limits = limits;
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-140001-cccccd";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", runId, "events.jsonl"), "{\"event\":\"progress\"}\n");
    let killed = false;
    let clock = 1_700_000_000_000;
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      now: () => clock,
      signal: ctl.signal,
      io: capture().io,
      start: () => ({
        done: new Promise<RunResult>(() => undefined),
        pid: 0,
        runId: () => runId,
        kill: () => {
          killed = true;
        },
        unref: () => undefined,
      }),
    });
    try {
      await waitFor("run id recorded", async () => (await entries(factoryHome, repo))[0]?.run_id === runId);
      clock += 10 * 60_000;
      await new Promise((r) => setTimeout(r, 80));
      expect(killed).toBe(false);
      expect((await entries(factoryHome, repo))[0]?.status).toBe("running");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("requeues a stream abort from state.json transient, not from the reason text", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    const runId = "20261029-120000-abcdef";
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("first", () => g.calls.length === 1);
      const runDir = join(factoryHome, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      const statePath = join(runDir, "state.json");
      writeFileSync(statePath, JSON.stringify({ version: 1, run_id: runId, repo, task: { ref: "#1", issue: 1, title: "t", text: "", labels: [] }, result: "needs_human", transient: true }) + "\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(statePath, old, old);
      g.release(1, outcome(repo, 1, "needs_human", "provider stream aborted after 3 retries: reset; factory resume " + runId, { run_id: runId }));
      await waitFor("second issue first", () => g.calls.length === 2);
      expect(g.calls).toEqual([1, 2]);
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await waitFor("requeued", () => g.calls.length === 3);
      expect(g.calls).toEqual([1, 2, 1]);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("puts a repo-lock locked result back to pending instead of parking it", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [2]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("started", () => g.calls.length === 1);
      g.release(2, outcome(repo, 2, "locked", "repo abc is locked by run 20261029-140000-cccccc (pid 99)"));
      await waitFor("retried", () => g.calls.length === 2);
      expect((await entries(factoryHome, repo))[0]?.status).not.toBe("parked");
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await worker;
      expect((await entries(factoryHome, repo))[0]?.status).toBe("done");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("does not update-branch a PR whose number is only a suffix of a done run's URL", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const runId = "20261029-160000-aaaaaa";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(
      join(factoryHome, "runs", runId, "result.json"),
      JSON.stringify(outcome(repo, 17, "done", "", { run_id: runId, pr: "https://github.test/pull/17", branch: "factory/17-goal" })) + "\n",
    );
    github.factoryPrs.push({ number: 7, branch: "factory/7-other", files: ["src/a.js"] });
    github.prStates.set("7", { state: "open", draft: false, behind: true });
    github.factoryPrs.push({ number: 17, branch: "factory/17-goal", files: ["src/b.js"] });
    github.prStates.set("17", { state: "open", draft: false, behind: true });
    await runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: capture().io });
    expect(github.updatedBranches).toEqual(["17"]);
  });

  it("retries a failed behind update and still updates the other PRs", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    for (const [id, issue, pr, branch] of [
      ["20261029-170000-aaaaaa", 7, "7", "factory/7-a"],
      ["20261029-170001-bbbbbb", 9, "9", "factory/9-b"],
    ] as const) {
      mkdirSync(join(factoryHome, "runs", id), { recursive: true });
      writeFileSync(join(factoryHome, "runs", id, "result.json"), JSON.stringify(outcome(repo, issue, "done", "", { run_id: id, pr: `https://github.test/pull/${pr}`, branch })) + "\n");
      github.factoryPrs.push({ number: Number(pr), branch, files: ["src/a.js"] });
      github.prStates.set(pr, { state: "open", draft: false, behind: true });
    }
    const orig = github.updateBranch.bind(github);
    const attempts = new Map<string, number>();
    github.updateBranch = async (dir, pr) => {
      attempts.set(pr, (attempts.get(pr) ?? 0) + 1);
      if (pr === "7" && attempts.get(pr) === 1) throw new Error("network down");
      return orig(dir, pr);
    };
    const cap = capture();
    await runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: cap.io });
    expect(attempts.get("7")).toBe(2);
    expect(github.updatedBranches).toEqual(["9", "7"]);
    expect(cap.err()).toContain("update-branch #7 failed");
  });

  it("with --until stays up while a done factory PR is open, and without it exits when nothing is behind", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const runId = "20261029-180000-aaaaaa";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", runId, "result.json"), JSON.stringify(outcome(repo, 7, "done", "", { run_id: runId, pr: "https://github.test/pull/7", branch: "factory/7-goal" })) + "\n");
    github.factoryPrs.push({ number: 7, branch: "factory/7-goal", files: ["src/a.js"] });
    github.prStates.set("7", { state: "open", draft: false, behind: false });
    const idle = capture();
    await runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: idle.io });
    expect(idle.out()).toContain("queue: idle");
    expect(github.updatedBranches).toEqual([]);

    let clock = 1_700_000_000_000;
    let polls = 0;
    const until = capture();
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      untilMs: clock + 60_000,
      now: () => clock,
      sleep: async () => {
        polls += 1;
        if (polls === 2) github.prStates.set("7", { state: "open", draft: false, behind: true });
        if (polls >= 4) clock += 60_000;
      },
      start: () => { throw new Error("should not start"); },
      io: until.io,
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(github.updatedBranches).toEqual(["7"]);
    expect(until.out()).toContain("queue: until reached");
  });

  it("V02: pending CI keeps the worker up under --until and does not take a coding slot", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const runId = "20261112-120000-bbbbbb";
    const pr = "https://github.test/pull/8";
    const branch = "factory/8-goal";
    const dir = join(factoryHome, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, run_id: runId, repo, task: { ref: "#8", title: "t", text: "", labels: [] }, no_pr: false,
      step: "finished", result: "done", reason: "", branch, worktree: null, base_sha: null,
      packages: {}, failures: {}, handoffs: [], rounds: 1, findings: [], gate_count: 1,
      pr, pr_draft: false, approved_sha: "abc123", ci_wait: "pending", updated_at: "2026-11-12T00:00:00.000Z",
    }));
    writeFileSync(join(dir, "result.json"), JSON.stringify(outcome(repo, 8, "done", "", { run_id: runId, pr, branch, merge_policy: "auto" })) + "\n");
    github.settings.required_checks = ["done"];
    github.prs.push({ repoDir: repo, head: branch, base: "main", title: "t", body: "", draft: false, url: pr });
    github.remoteShas.set(branch, "abc123");
    github.prStates.set(pr, { state: "open", draft: false, ci: "pending" });
    let clock = 1_700_000_000_000;
    let polls = 0;
    const cap = capture();
    let started = 0;
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      untilMs: clock + 60_000,
      now: () => clock,
      sleep: async () => {
        polls += 1;
        if (polls === 2) github.prStates.set(pr, { state: "open", draft: false, ci: "green" });
        if (polls >= 3) clock += 60_000;
      },
      start: () => {
        started += 1;
        throw new Error("should not start");
      },
      io: cap.io,
    });
    expect(started).toBe(0);
    expect(github.autoMerged).toEqual([pr]);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(cap.out()).toContain(`queue: auto-merge ${pr}`);
  });

  it("does not update or reapprove a legacy automatic PR without a local checkpoint", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const runId = "20261112-140000-bbbbbb";
    const pr = "https://github.test/pr/7";
    const branch = "factory/7-goal";
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const dir = join(factoryHome, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, run_id: runId, repo, task: { ref: "#7", title: "t", text: "", labels: [] }, no_pr: false,
      step: "finished", result: "done", reason: "", branch, worktree: null, base_sha: null,
      packages: {}, failures: {}, handoffs: [], rounds: 1, findings: [], gate_count: 1,
      pr, pr_draft: false, approved_sha: oldSha, updated_at: "2026-11-12T00:00:00.000Z",
    }));
    writeFileSync(join(dir, "result.json"), JSON.stringify(outcome(repo, 7, "done", "", { run_id: runId, pr, branch, merge_policy: "auto" })) + "\n");
    github.prs.push({ repoDir: repo, head: branch, base: "main", title: "t", body: "", draft: false, url: pr });
    github.remoteShas.set(branch, oldSha);
    github.updateBranchHead = newSha;
    github.factoryPrs.push({ number: 7, branch, files: ["src/a.js"] });
    github.prStates.set(pr, { state: "open", draft: false, behind: true });
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      start: () => {
        throw new Error("should not start");
      },
      io: capture().io,
    });
    expect(github.updatedBranches).toEqual([]);
    expect(github.approvedShas).toEqual([]);
    expect(github.autoMerged).toEqual([]);
    expect((await github.findOpenPr(repo, branch))?.headSha).toBe(oldSha);
    expect(github.remoteShas.get(branch)).toBe(oldSha);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).approved_sha).toBe(oldSha);
  });

  it("a poller never changes a bot_review SHA; a human-policy branch update grants no approval", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const plant = (id: string, n: number, policy: "bot_review" | "human_review", branch: string, sha: string) => {
      const pr = `https://github.test/pr/${n}`;
      const dir = join(factoryHome, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `#${n}`, title: "t", text: "", labels: [] }, no_pr: false,
        step: "finished", result: "done", reason: "", branch, worktree: null, base_sha: null,
        packages: {}, failures: {}, handoffs: [], rounds: 1, findings: [], gate_count: 1,
        pr, pr_draft: false, approved_sha: sha, reviewed_sha: sha, updated_at: "2026-11-12T00:00:00.000Z",
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify(outcome(repo, n, "done", "", { run_id: id, pr, branch, merge_policy: policy })) + "\n");
      github.prs.push({ repoDir: repo, head: branch, base: "main", title: "t", body: "", draft: false, url: pr });
      github.remoteShas.set(branch, sha);
      github.factoryPrs.push({ number: n, branch, files: [`src/${n}.js`] });
      github.prStates.set(pr, { state: "open", draft: false, behind: true });
      return { dir, pr, sha };
    };
    const bot = plant("20261112-150000-bbbbbb", 8, "bot_review", "factory/8-goal", "a".repeat(40));
    const human = plant("20261112-150001-cccccc", 9, "human_review", "factory/9-goal", "c".repeat(40));
    await runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 15,
      start: () => {
        throw new Error("should not start");
      },
      io: capture().io,
    });
    const botHead = github.remoteShas.get("factory/8-goal");
    expect(botHead).toBeTruthy();
    expect(botHead).toBe(bot.sha);
    expect(github.approvedShas).toEqual([]);
    const botState = JSON.parse(readFileSync(join(bot.dir, "state.json"), "utf8")) as { approved_sha?: string; reviewed_sha?: string };
    expect(botState.approved_sha).toBe(bot.sha);
    expect(botState.reviewed_sha).toBe(bot.sha);
    expect(github.updatedBranches).toEqual(["9"]);
    const humanState = JSON.parse(readFileSync(join(human.dir, "state.json"), "utf8")) as { approved_sha?: string };
    expect(humanState.approved_sha).toBe(human.sha);
    expect(github.approvedShas).not.toContain(github.remoteShas.get("factory/9-goal"));
  });

  it("does not approve an update when the previous head was missing, disable failed, or the new commit is not the merge", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const plant = async (github: FakeGitHub, sha: string) => {
      await updateQueue(factoryHome, repo, () => undefined);
      const runId = "20261112-160000-bbbbbb";
      const pr = "https://github.test/pr/7";
      const branch = "factory/7-goal";
      const dir = join(factoryHome, "runs", runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: runId, repo, task: { ref: "#7", title: "t", text: "", labels: [] }, no_pr: false,
        step: "finished", result: "done", reason: "", branch, worktree: null, base_sha: null,
        packages: {}, failures: {}, handoffs: [], rounds: 1, findings: [], gate_count: 1,
        pr, pr_draft: false, approved_sha: sha, updated_at: "2026-11-12T00:00:00.000Z",
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify(outcome(repo, 7, "done", "", { run_id: runId, pr, branch, merge_policy: "auto" })) + "\n");
      github.prs.push({ repoDir: repo, head: branch, base: "main", title: "t", body: "", draft: false, url: pr });
      github.factoryPrs.push({ number: 7, branch, files: ["src/a.js"] });
      github.prStates.set(pr, { state: "open", draft: false, behind: true });
      return { dir, pr, branch };
    };
    const missing = new FakeGitHub();
    const oldSha = "a".repeat(40);
    const missingRun = await plant(missing, oldSha);
    await runQueue({ factoryHome, github: missing, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: capture().io });
    expect(missing.approvedShas).toEqual([]);
    expect(JSON.parse(readFileSync(join(missingRun.dir, "state.json"), "utf8")).approved_sha).toBe(oldSha);

    const broken = new FakeGitHub();
    const brokenRun = await plant(broken, oldSha);
    broken.remoteShas.set(brokenRun.branch, oldSha);
    broken.disableError = "disable refused";
    await runQueue({ factoryHome, github: broken, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: capture().io });
    expect(broken.approvedShas).toEqual([]);
    expect(broken.autoMergeDisabled).toEqual([]);
    expect(JSON.parse(readFileSync(join(brokenRun.dir, "state.json"), "utf8")).approved_sha).toBe(oldSha);

    const pushed = new FakeGitHub();
    const pushedRun = await plant(pushed, oldSha);
    pushed.remoteShas.set(pushedRun.branch, oldSha);
    pushed.updateBranchParents = [oldSha];
    await runQueue({ factoryHome, github: pushed, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: capture().io });
    expect(pushed.updatedBranches).toEqual([]);
    expect(pushed.approvedShas).toEqual([]);
    expect(JSON.parse(readFileSync(join(pushedRun.dir, "state.json"), "utf8")).approved_sha).toBe(oldSha);
  });

  it("uses result.json on restart even when the stored pid is alive, and ignores a pid whose command line is not the run", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-190000-aaaaaa";
    const runDir = join(factoryHome, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "result.json"), JSON.stringify(outcome(repo, 1, "done", "", { run_id: runId, pr: "https://github.test/pr/1" })) + "\n");
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, run_id: runId, repo, task: { ref: "#1", issue: 1, title: "t", text: "", labels: [] }, result: "done" }) + "\n");
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await updateQueue(factoryHome, repo, (q) => {
        q.entries[0]!.status = "running";
        q.entries[0]!.run_id = runId;
        q.entries[0]!.pid = sleeper.pid;
      });
      let calls = 0;
      await runQueue({
        factoryHome,
        github,
        repo,
        slots: 1,
        pollMs: 15,
        start: () => {
          calls += 1;
          return { done: new Promise(() => undefined), pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
        },
        io: capture().io,
      });
      expect(calls).toBe(0);
      expect((await entries(factoryHome, repo))[0]).toMatchObject({ status: "done", run_id: runId });
      expect(sleeper.exitCode).toBeNull();
    } finally {
      sleeper.kill("SIGKILL");
    }

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    await enqueue(home2, repo2, gh2, [3]);
    const foreign = spawn("sleep", ["30"], { stdio: "ignore" });
    const missed = "20261029-190001-bbbbbb";
    try {
      await updateQueue(home2, repo2, (q) => {
        q.entries[0]!.status = "running";
        q.entries[0]!.run_id = missed;
        q.entries[0]!.pid = foreign.pid;
      });
      await runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: capture().io });
      expect((await entries(home2, repo2))[0]).toMatchObject({ status: "parked", reason: "run ended without result.json" });
      expect(foreign.exitCode).toBeNull();
    } finally {
      foreign.kill("SIGKILL");
    }

    const repo3 = createFixtureRepo();
    const home3 = home();
    const gh3 = new FakeGitHub();
    await enqueue(home3, repo3, gh3, [4]);
    const liveId = "20261029-190002-cccccc";
    // A second command keeps bash from execing sleep, so `ps` still shows the run id.
    const live = spawn("bash", ["-c", `sleep 30; echo ${liveId}`], { stdio: "ignore", detached: true });
    const ctl = new AbortController();
    try {
      await updateQueue(home3, repo3, (q) => {
        q.entries[0]!.status = "running";
        q.entries[0]!.run_id = liveId;
        q.entries[0]!.pid = live.pid;
      });
      let calls = 0;
      const worker = runQueue({
        factoryHome: home3,
        github: gh3,
        repo: repo3,
        slots: 1,
        pollMs: 15,
        signal: ctl.signal,
        start: () => {
          calls += 1;
          return { done: new Promise(() => undefined), pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
        },
        io: capture().io,
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(calls).toBe(0);
      expect((await entries(home3, repo3))[0]?.status).toBe("running");
      ctl.abort();
      await worker;
      expect(live.exitCode).toBeNull();
    } finally {
      ctl.abort();
      if (live.pid) {
        try {
          process.kill(-live.pid, "SIGKILL");
        } catch {
          live.kill("SIGKILL");
        }
      }
    }
  });

  it("puts the run id on the factory run command line and uses that id", async () => {
    const runId = "20261029-210000-abc123";
    expect(factoryRunArgs("/cli.js", { repo: "/repo", issue: 4, runId })).toEqual([
      "/cli.js", "run", "--repo", "/repo", "--issue", "4", "--no-notify", "--run-id", runId,
    ]);
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    github.getIssue = async () => {
      throw new Error("stop before plan");
    };
    const profile = loadProfile(join(FIXTURES, "profile.yaml"));
    const result = await runFactory({ repo, issue: 1, noPr: true, runId }, { runner: new FakeRunner([]), github, profile, factoryHome, noNotify: true });
    expect(result.run_id).toBe(runId);
    expect(result.result).toBe("failed");
  });

  it("does not SIGTERM a stored pid whose command line is not the run, even after the stall window", async () => {
    const repo = createFixtureRepo((c) => {
      const limits = (c.limits ?? {}) as Record<string, unknown>;
      limits.stall_minutes = 1;
      c.limits = limits;
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-210001-aaaaaa";
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const lockKey = lockRepoKey(await repoLockId(repo));
    mkdirSync(join(factoryHome, "locks"), { recursive: true });
    writeFileSync(join(factoryHome, "locks", `${lockKey}.lock`), `${process.pid}\n${runId}\n`);
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.status = "running";
      q.entries[0]!.run_id = runId;
      q.entries[0]!.pid = sleeper.pid;
    });
    let clock = 1_700_000_000_000;
    let step = false;
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 20,
      now: () => {
        if (step) clock += 10_000;
        return clock;
      },
      signal: ctl.signal,
      start: () => { throw new Error("should not start"); },
      io: capture().io,
    });
    try {
      await waitFor("adopted", async () => (await entries(factoryHome, repo))[0]?.status === "running");
      step = true;
      await new Promise((r) => setTimeout(r, 1_500));
      expect(sleeper.exitCode).toBeNull();
      expect((await entries(factoryHome, repo))[0]?.status).toBe("running");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
      sleeper.kill("SIGKILL");
    }
  });

  it("starts --after when the dependency is not queued but the issue is closed or its factory PR is merged", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    github.issues.set(120, ready(120, { state: "closed" }));
    await enqueue(factoryHome, repo, github, [130], 120);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("closed dependency started", () => g.calls.length === 1);
      g.release(130, outcome(repo, 130, "done", "", { pr: "https://github.test/pr/130" }));
      await worker;
      expect((await entries(factoryHome, repo))[0]?.status).toBe("done");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    // Not factory-ready, so discovery leaves it unqueued. A merged factory PR is still enough.
    gh2.issues.set(120, ready(120, { state: "open", labels: [] }));
    gh2.factoryPrByIssue.set(120, { number: 4, state: "merged" });
    await enqueue(home2, repo2, gh2, [131], 120);
    const g2 = gate();
    const ctl2 = new AbortController();
    const worker2 = runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 1, pollMs: 15, signal: ctl2.signal, start: g2.start, io: capture().io });
    try {
      await waitFor("merged dependency started", () => g2.calls.includes(131));
      g2.release(131, outcome(repo2, 131, "done", "", { pr: "https://github.test/pr/131" }));
      await worker2;
    } finally {
      ctl2.abort();
      await worker2.catch(() => undefined);
    }

    const repo3 = createFixtureRepo();
    const home3 = home();
    const gh3 = new FakeGitHub();
    gh3.issues.set(120, ready(120, { state: "open", labels: [] }));
    await enqueue(home3, repo3, gh3, [132], 120);
    const g3 = gate();
    const ctl3 = new AbortController();
    const worker3 = runQueue({ factoryHome: home3, github: gh3, repo: repo3, slots: 1, pollMs: 15, signal: ctl3.signal, start: g3.start, io: capture().io });
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(g3.calls).toEqual([]);
      expect((await entries(home3, repo3))[0]?.status).toBe("pending");
    } finally {
      ctl3.abort();
      await worker3;
    }
  });

  it("does not hold the queue write lock across a github call, and a hung call does not freeze the worker", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const key = await repoQueueKey(repo);
    let sawLockFree = false;
    let calls = 0;
    const orig = github.getIssue.bind(github);
    github.getIssue = async (dir, n) => {
      calls += 1;
      const probe = await tryPathLock(join(queueDir(factoryHome), `${key}.write.lock`), "probe", () => "free", { waitMs: 0 });
      sawLockFree = probe.ok;
      if (calls === 1) await new Promise((r) => setTimeout(r, 5_000));
      return orig(dir, n);
    };
    const g = gate();
    const started = Date.now();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, netTimeoutMs: 80, start: g.start, io: capture().io });
    try {
      await waitFor("started despite hung getIssue", () => g.calls.length === 1, 3_000);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(sawLockFree).toBe(true);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
    } finally {
      await worker.catch(() => undefined);
    }
  });

  it("queue CLI rejects a bad --until and lists an empty home", async () => {
    const { main } = await import("../../src/cli.js");
    const factoryHome = home();
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = factoryHome;
    try {
      const err: string[] = [];
      expect(await main(["queue", "run", "--until", "99:99"], { out: () => undefined, err: (s) => err.push(s) })).toBe(2);
      expect(err.join("")).toContain("invalid --until");
      let out = "";
      expect(await main(["queue", "list", "--json"], { out: (s) => void (out += s), err: () => undefined })).toBe(0);
      expect(JSON.parse(out)).toEqual({ queues: [] });
      expect(await main(["queue", "nope"], { out: () => undefined, err: () => undefined })).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });
});
