import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { queueAdd, queueCommand, queueList, queueRemove } from "../../src/commands/queue.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import type { Io } from "../../src/commands/gates.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { activeHolders } from "../../src/pipeline/lock.js";
import { runFactory } from "../../src/pipeline/run.js";
import { loadQueueByKey, repoQueueKey, updateQueue, type QueueEntry } from "../../src/queue/store.js";
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
    const transient = () => outcome(repo, 1, "needs_human", "transient capacity error after retries: overloaded");
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
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("issue started", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "done", "", { pr: "https://github.test/pr/1" }));
      await worker;
      expect(github.updatedBranches).toEqual(["7"]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("SIGTERMs a run whose events.jsonl has not grown for stall_minutes x 2", async () => {
    const repo = createFixtureRepo((c) => {
      const limits = (c.limits ?? {}) as Record<string, unknown>;
      limits.stall_minutes = 1;
      c.limits = limits;
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261029-140000-cccccc";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(join(factoryHome, "runs", runId, "events.jsonl"), "{\"event\":\"progress\"}\n");
    let killed: NodeJS.Signals | undefined;
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
        done: new Promise(() => undefined),
        pid: 0,
        runId: () => runId,
        kill: (signal) => {
          killed = signal;
        },
        unref: () => undefined,
      }),
    });
    try {
      await waitFor("run id recorded", async () => (await entries(factoryHome, repo))[0]?.run_id === runId);
      clock += 3 * 60_000;
      await waitFor("stalled", () => killed !== undefined);
      await worker;
      expect(killed).toBe("SIGTERM");
      expect((await entries(factoryHome, repo))[0]?.status).toBe("parked");
      expect((await entries(factoryHome, repo))[0]?.reason).toMatch(/stalled/);
    } finally {
      ctl.abort();
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
