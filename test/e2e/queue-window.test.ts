/**
 * Issue #177 end to end: a `provider_window_wait` stop parks the queue entry without a coding slot,
 * the entry becomes pending again after its (bounded) window across a worker restart, and the
 * resume revalidates the issue revision and the pause before reusing the original checkpoint and PR.
 * Generic capacity stays the existing transient requeue. Fake runner and FakeGitHub only.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import type { Io } from "../../src/commands/gates.js";
import { queueAdd } from "../../src/commands/queue.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { readState } from "../../src/pipeline/state.js";
import { issueRevision } from "../../src/queue/admit.js";
import { clearPause, pauseRequested, requestPause } from "../../src/queue/pause.js";
import { loadQueueByKey, repoQueueKey, saveQueue, type QueueEntry } from "../../src/queue/store.js";
import { MAX_WINDOW_WAITS, MAX_WINDOW_WAIT_MS, runQueue, type StartRun, type StartRunRequest } from "../../src/queue/worker.js";
import { createFixtureRepo } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const WINDOW = { cause: "provider_window_wait", action: "wait" } as const;
const MIN = 60_000;

function outcome(repo: string, runId: string, issueNo: number, extra: Partial<RunResult> = {}): RunResult {
  return {
    run_id: runId,
    repo,
    task: `#${issueNo}`,
    type: "feature",
    lane: "standard",
    result: "needs_human",
    risk: null,
    merge_policy: null,
    pr: null,
    rounds: 0,
    minutes: 0,
    cost_usd: 0,
    reason: `every usable model is at its usage limit until the window resets; factory resume ${runId}`,
    branch: `factory/${issueNo}-x`,
    worktree: null,
    run_dir: "",
    ...extra,
  } as RunResult;
}

interface Gate {
  start: StartRun;
  reqs: StartRunRequest[];
  release: (issueNo: number, result: RunResult) => void;
}

function gate(): Gate {
  const reqs: StartRunRequest[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  return {
    reqs,
    release(issueNo, result) {
      const resolve = pending.get(issueNo);
      if (!resolve) throw new Error(`no pending start for #${issueNo}`);
      resolve(result);
    },
    start: (req) => {
      reqs.push(req);
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => {
        resolve = r;
      });
      pending.set(req.issue, resolve);
      return { done, pid: 0, runId: () => req.runId, kill: () => undefined, unref: () => undefined };
    },
  };
}

async function enqueue(factoryHome: string, repo: string, github: FakeGitHub, issues: number[]): Promise<void> {
  for (const n of issues) github.issues.set(n, { number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open" } as Issue);
  const io: Io = { out: () => undefined, err: (s) => { throw new Error(s); } };
  expect(await queueAdd({ factoryHome, repo, issues, github }, io)).toBe(0);
}

async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function entriesOf(factoryHome: string, repo: string): Promise<QueueEntry[]> {
  return loadQueueByKey(factoryHome, await repoQueueKey(repo))!.entries;
}

const row = (home: string, repo: string, issue: number) => entriesOf(home, repo).then((all) => all.find((e) => e.issue === issue)!);

/** A checkpoint the resume path may reuse. Its mtimes are aged so it never looks like a live run. */
function writeCheckpoint(factoryHome: string, repo: string, runId: string, issueNo: number, extra: Record<string, unknown> = {}): void {
  const dir = join(factoryHome, "runs", runId);
  mkdirSync(join(dir, "worktree"), { recursive: true });
  const state = {
    version: 1, run_id: runId, repo, task: { ref: `#${issueNo}` }, no_pr: false, step: "implement", result: "needs_human", reason: "",
    branch: `factory/${issueNo}-x`, worktree: join(dir, "worktree"), pr: null, lane: "standard", packages: {}, failures: {}, handoffs: [], rounds: 0, findings: [], gate_count: 0, updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    repair: { gate_attempts: 3, network_retries: 1, format_used: true, infra_reruns: 1, class: "code" },
    continuation_attempts: 2,
    ...extra,
  };
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ acceptance: [] }));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, "state.json"), old, old);
}

function repairOf(factoryHome: string, runId: string): { repair?: unknown; continuation_attempts?: unknown } {
  const state = JSON.parse(readFileSync(join(factoryHome, "runs", runId, "state.json"), "utf8")) as { repair?: unknown; continuation_attempts?: unknown };
  return { repair: state.repair, continuation_attempts: state.continuation_attempts };
}

const SPENT_REPAIR = {
  repair: { gate_attempts: 3, network_retries: 1, format_used: true, infra_reruns: 1, class: "code" },
  continuation_attempts: 2,
};

/** Injected clock plus a sleep that only yields real time: ticks have a cadence, time moves when the test says so. */
function fakeTime() {
  let t = Date.now();
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        sleeps.push(ms);
        if (signal?.aborted) return reject(new Error("aborted"));
        const timer = setTimeout(resolve, 1);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      }),
  };
}

const io: Io = { out: () => undefined, err: () => undefined };

describe("queue waits for a provider usage window (#177)", () => {
  it("holds no slot, lets other work proceed, survives a restart and resumes the same checkpoint and PR", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1, 2]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker1 = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("issue 1 starts", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      const resetsAt = clock.now() + MIN;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: resetsAt, pr: "https://github.test/pr/1" }));
      // No slot is held by the wait: issue 2 starts right away and finishes while issue 1 waits.
      await waitFor("issue 2 takes the freed slot", () => g.reqs.some((r) => r.issue === 2));
      await waitFor("issue 1 parks with a window wait", async () => (await row(home, repo, 1)).status === "parked" && (await row(home, repo, 1)).wait_until !== undefined);
      g.release(2, outcome(repo, g.reqs.find((r) => r.issue === 2)!.runId!, 2, { result: "done", pr: "https://github.test/pr/2", reason: "" }));
      const parked = await row(home, repo, 1);
      expect(parked).toMatchObject({ status: "parked", run_id: runId, pr: "https://github.test/pr/1", window_waits: 1 });
      expect(parked.requeues).toBeUndefined();
      expect(parked.wait_until).toBe(resetsAt);
      writeCheckpoint(home, repo, runId, 1);

      // Restart with the window still closed: the wait survives on disk and nothing resumes early.
      ctl.abort();
      await worker1.catch(() => undefined);
      const ctl2 = new AbortController();
      const worker2 = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl2.signal, start: g.start, io });
      try {
        await waitFor("restarted worker ticks", () => clock.sleeps.length >= 5);
        expect(g.reqs.filter((r) => r.issue === 1)).toHaveLength(1);
        expect(await row(home, repo, 1).then((e) => e.status)).toBe("parked");
        // Waiting is a bounded periodic check, not a busy-poll.
        expect(clock.sleeps.every((ms) => ms >= 5)).toBe(true);

        // The window opened: pending again, then a resume of the original run, not a duplicate.
        clock.advance(MIN + 5_000);
        await waitFor("issue 1 restarts", () => g.reqs.filter((r) => r.issue === 1).length === 2);
        const resumeReq = g.reqs.filter((r) => r.issue === 1)[1]!;
        expect(resumeReq.resumeRunId).toBe(runId);
        expect(resumeReq.runId).toBe(runId);
        const released = await row(home, repo, 1);
        expect(released.window_waits).toBe(1);
        expect(released.wait_until).toBeUndefined();
        expect(released.requeues).toBeUndefined();
        // Opening the window must not hand the spent repair budget back.
        expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
        g.release(1, outcome(repo, runId, 1, { result: "done", pr: "https://github.test/pr/1", reason: "", stop: undefined }));
        await waitFor("issue 1 done", async () => (await row(home, repo, 1)).status === "done");
        expect((await row(home, repo, 1)).pr).toBe("https://github.test/pr/1");
        expect(g.reqs.filter((r) => r.issue === 1)).toHaveLength(2);
      } finally {
        ctl2.abort();
        await worker2.catch(() => undefined);
      }
    } finally {
      ctl.abort();
      await worker1.catch(() => undefined);
    }
  });

  it("a pause keeps the entry parked past its window; after the pause clears it resumes", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    // stay: the worker keeps its bounded periodic check while the paused entry waits.
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io, stay: true });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      const resetsAt = clock.now() + MIN;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: resetsAt }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      requestPause(home, { runId }, "operator pause");
      clock.advance(MIN + 5_000);
      await waitFor("ticks past the window", () => clock.sleeps.length >= 5);
      expect(await row(home, repo, 1).then((e) => e.status)).toBe("parked");
      expect(g.reqs).toHaveLength(1);
      clearPause(home, { runId });
      await waitFor("resumes after the pause clears", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a changed issue revision drops the stale checkpoint instead of resuming it", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      const resetsAt = clock.now() + MIN;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: resetsAt }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      github.issues.set(1, { number: 1, title: "Issue 1 (rewritten)", body: "Different scope.", labels: ["factory-ready"], state: "open" } as Issue);
      clock.advance(MIN + 5_000);
      await waitFor("restart after the window", () => g.reqs.length === 2);
      // The saved plan was for the old text: start fresh, do not resume the stale checkpoint.
      expect(g.reqs[1]!.resumeRunId).toBeUndefined();
      expect(g.reqs[1]!.runId).not.toBe(runId);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a far window wakes only for the bounded recheck and spends no wait budget", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      const resetsAt = clock.now() + 2 * MAX_WINDOW_WAIT_MS + 1_000;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: resetsAt }));
      await waitFor("parked with a capped recheck", async () => (await row(home, repo, 1)).wait_until !== undefined);
      expect(await row(home, repo, 1).then((e) => e.wait_until)).toBeLessThan(resetsAt);
      // Advance to the capped recheck, still far before the real reset: re-check only, no resume, no budget.
      clock.advance(MAX_WINDOW_WAIT_MS + 5_000);
      await waitFor("recheck moved", async () => (await row(home, repo, 1)).wait_until === resetsAt);
      const e = await row(home, repo, 1);
      expect(e.status).toBe("parked");
      expect(e.window_waits).toBe(1);
      expect(g.reqs).toHaveLength(1);
      // The window opens: pending again with the original checkpoint.
      clock.advance(MAX_WINDOW_WAIT_MS);
      await waitFor("resume after the real reset", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("window waits are bounded and never touch the requeue or repair budgets", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      for (let stop = 1; stop <= MAX_WINDOW_WAITS + 1; stop++) {
        await waitFor(`start ${stop}`, () => g.reqs.length === stop);
        const req = g.reqs[stop - 1]!;
        g.release(1, outcome(repo, req.runId!, 1, { stop: WINDOW, window_resets_at: clock.now() + MIN }));
        await waitFor(`parked ${stop}`, async () => (await row(home, repo, 1)).status === "parked" && (await row(home, repo, 1)).window_waits === stop);
        clock.advance(MIN + 5_000);
      }
      // The budget is spent: permanent park, the worker goes idle and never starts the issue again.
      await waitFor("worker exits with the entry parked", () => worker.then(() => true, () => false));
      expect(g.reqs).toHaveLength(MAX_WINDOW_WAITS + 1);
      const e = await row(home, repo, 1);
      expect(e.status).toBe("parked");
      expect(e.wait_until).toBeUndefined();
      expect(e.window_waits).toBeGreaterThan(MAX_WINDOW_WAITS);
      expect(e.requeues).toBeUndefined();
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a window that has already opened becomes pending on the next revalidation and resumes the same checkpoint", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() - 1_000, pr: "https://github.test/pr/1" }));
      await waitFor("resume after an already-open window", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
      expect((await row(home, repo, 1)).pr).toBe("https://github.test/pr/1");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a stop that no longer authorizes the wait does not resume and does not reset spent repair budgets", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io, stay: true });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1, { stop: { cause: "provider_window_wait", action: "wait" } });
      const resetsAt = clock.now() + MIN;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: resetsAt, pr: "https://github.test/pr/1" }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      writeCheckpoint(home, repo, runId, 1, { stop: { cause: "budget_exhausted", action: "decide" } });
      const slept = clock.sleeps.length;
      clock.advance(MIN + 5_000);
      await waitFor("ticked after the window", () => clock.sleeps.length > slept + 2);
      expect(g.reqs).toHaveLength(1);
      const parked = await row(home, repo, 1);
      expect(parked.status).toBe("parked");
      expect(parked.run_id).toBe(runId);
      expect(parked.pr).toBe("https://github.test/pr/1");
      expect(parked.requeues).toBeUndefined();
      expect(parked.window_waits).toBe(1);
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("an issue pause, not only a run pause, keeps the entry parked past its window", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() + MIN }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      requestPause(home, { repo, issue: 1 }, "operator pause");
      const slept = clock.sleeps.length;
      clock.advance(MIN + 5_000);
      await waitFor("ticked after the window", () => clock.sleeps.length > slept + 2);
      expect(g.reqs).toHaveLength(1);
      expect(await row(home, repo, 1).then((e) => e.status)).toBe("parked");
      clearPause(home, { repo, issue: 1 });
      await waitFor("resumes after the issue pause clears", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a released window whose stop no longer authorizes resume does not start a second implementation", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const issue = github.issues.get(1)!;
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1, { stop: { cause: "human_approval", action: "approve" } });
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: Date.now() + 60 * MIN, pr: "https://github.test/pr/1" }));
      await waitFor("parked", async () => (await row(home, repo, 1)).status === "parked");
      ctl.abort();
      await worker.catch(() => undefined);
      const key = await repoQueueKey(repo);
      const file = loadQueueByKey(home, key)!;
      const entry = file.entries.find((e) => e.issue === 1)!;
      entry.status = "pending";
      entry.run_id = runId;
      entry.issue_rev = issueRevision(issue.title, issue.body);
      entry.window_waits = 1;
      entry.pr = "https://github.test/pr/1";
      delete entry.wait_until;
      delete entry.window_resets_at;
      delete entry.pid;
      saveQueue(home, file);
      const ctl2 = new AbortController();
      const worker2 = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, signal: ctl2.signal, start: g.start, io, stay: true });
      try {
        await waitFor("worker considered the pending resume", async () => (await row(home, repo, 1)).status !== "pending" || g.reqs.length > 1);
        await new Promise((r) => setTimeout(r, 40));
        expect(g.reqs).toHaveLength(1);
        const parked = await row(home, repo, 1);
        expect(parked.status).toBe("parked");
        expect(parked.run_id).toBe(runId);
        expect(parked.pr).toBe("https://github.test/pr/1");
        expect(parked.window_waits).toBe(1);
        expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
      } finally {
        ctl2.abort();
        await worker2.catch(() => undefined);
      }
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("a temporary admission block at window wake keeps the checkpoint and does not start a second implementation", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const issue = github.issues.get(1)!;
    const rev = issueRevision(issue.title, issue.body);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io, stay: true });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1, { stop: { cause: "provider_window_wait", action: "wait" }, pr: "https://github.test/pr/1" });
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() + MIN, pr: "https://github.test/pr/1" }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      expect((await row(home, repo, 1)).issue_rev).toBe(rev);
      // The window is open, but admission is only temporarily blocked. Dropping run_id here would
      // start a fresh implementation and reset repair budgets once the label returns.
      issue.labels = ["needs-decision", "factory-ready"];
      const slept = clock.sleeps.length;
      clock.advance(MIN + 5_000);
      await waitFor("window wake ticked", () => clock.sleeps.length > slept + 1);
      const blocked = await row(home, repo, 1);
      expect(g.reqs).toHaveLength(1);
      expect(blocked.run_id).toBe(runId);
      expect(blocked.issue_rev).toBe(rev);
      expect(blocked.pr).toBe("https://github.test/pr/1");
      expect(blocked.window_waits).toBe(1);
      expect(blocked.requeues).toBeUndefined();
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);

      issue.labels = ["factory-ready"];
      await waitFor("resumes the original checkpoint once admission returns", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
      expect(g.reqs.filter((r) => r.issue === 1).every((r) => r.runId === runId)).toBe(true);
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
      expect((await row(home, repo, 1)).pr).toBe("https://github.test/pr/1");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("revalidates a ready-label pause left on a usage-window entry and does not bypass a real pause", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io, stay: true });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1, { stop: { cause: "provider_window_wait", action: "wait" } });
      github.issues.get(1)!.labels = [];
      await waitFor("paused for the missing ready label", async () => (await row(home, repo, 1)).paused === true);
      expect(pauseRequested(home, { runId, repo, issue: 1 })).toContain("factory-ready");
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() + MIN, pr: "https://github.test/pr/9" }));
      await waitFor("parked on the window with the pause still set", async () => {
        const e = await row(home, repo, 1);
        return e.status === "parked" && e.wait_until !== undefined && e.paused === true;
      });
      const slept = clock.sleeps.length;
      clock.advance(MIN + 5_000);
      await waitFor("ticks past the window while the label is still gone", () => clock.sleeps.length > slept + 1);
      // The missing label is still a real pause: do not resume, and do not drop the checkpoint.
      expect(g.reqs).toHaveLength(1);
      expect(await row(home, repo, 1)).toMatchObject({ status: "parked", run_id: runId, paused: true, pr: "https://github.test/pr/9" });
      expect(pauseRequested(home, { runId })).toContain("factory-ready");
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);

      github.issues.get(1)!.labels = ["factory-ready"];
      await waitFor("clears the stale admission pause and resumes the same checkpoint", () => g.reqs.length === 2);
      expect(g.reqs[1]).toMatchObject({ issue: 1, resumeRunId: runId, runId });
      expect(pauseRequested(home, { runId })).toBeUndefined();
      expect(pauseRequested(home, { repo, issue: 1 })).toBeUndefined();
      expect((await row(home, repo, 1)).paused).not.toBe(true);
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("an operator pause on a window wait is not cleared when the ready label is present", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1]);
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io, stay: true });
    try {
      await waitFor("start", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      writeCheckpoint(home, repo, runId, 1);
      github.issues.get(1)!.labels = [];
      await waitFor("paused", async () => (await row(home, repo, 1)).paused === true);
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() + MIN }));
      await waitFor("parked", async () => (await row(home, repo, 1)).wait_until !== undefined);
      requestPause(home, { runId, repo, issue: 1 }, "operator pause");
      github.issues.get(1)!.labels = ["factory-ready"];
      const slept = clock.sleeps.length;
      clock.advance(MIN + 5_000);
      await waitFor("ticks past the window", () => clock.sleeps.length > slept + 2);
      expect(g.reqs).toHaveLength(1);
      expect(await row(home, repo, 1)).toMatchObject({ status: "parked", run_id: runId });
      expect(pauseRequested(home, { runId })).toBe("operator pause");
      expect(repairOf(home, runId)).toEqual(SPENT_REPAIR);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("an overlap wake-up still starts while another entry waits on a usage window", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-win-"));
    const github = new FakeGitHub();
    await enqueue(home, repo, github, [1, 2]);
    github.prStates.set("9", { state: "open", draft: false });
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("issue 1 starts", () => g.reqs.length === 1);
      const runId = g.reqs[0]!.runId!;
      g.release(1, outcome(repo, runId, 1, { stop: WINDOW, window_resets_at: clock.now() + 60 * MIN }));
      await waitFor("issue 2 starts", () => g.reqs.some((r) => r.issue === 2));
      g.release(2, outcome(repo, g.reqs.find((r) => r.issue === 2)!.runId!, 2, { result: "locked", reason: "planned paths overlap open factory PR #9 (src/math.js)" }));
      await waitFor("issue 2 parked on the PR", async () => (await row(home, repo, 2)).blocked_by?.[0] === 9);
      expect(await row(home, repo, 1).then((e) => e.status)).toBe("parked");
      github.prStates.set("9", { state: "closed", draft: false });
      await waitFor("issue 2 unparks while issue 1 still waits", () => g.reqs.filter((r) => r.issue === 2).length === 2);
      expect(await row(home, repo, 1).then((e) => e.wait_until)).toBeGreaterThan(clock.now());
      expect(g.reqs.filter((r) => r.issue === 1)).toHaveLength(1);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });
});

/** Replace the first scripted implement call with these failing calls of the same role. */
function failFirstImplement(errors: FakeStep[]) {
  return (steps: FakeStep[]): FakeStep[] => {
    const out: FakeStep[] = [];
    let replaced = false;
    for (const s of steps) {
      if (!replaced && s.role === "implement") {
        out.push(...errors);
        replaced = true;
        continue;
      }
      out.push(s);
    }
    return out;
  };
}

describe("the pipeline records the explicit usage window (#177)", () => {
  it("an implement chain where every usable model has a resetting usage window stops with provider_window_wait and a reset time", async () => {
    const at = (model: string): FakeStep => ({ role: "implement", model, error: { message: "Weekly usage limit reached. Resets in 2 hours." } });
    const errors = [at("opencode-go/deepseek-v4.1-flash"), at("opencode-go/deepseek-v4-pro")];
    const r = await runScenario({ script: "clean.json", steps: failFirstImplement(errors) });
    expect(r.result.result).toBe("needs_human");
    expect(r.resultFile.stop).toEqual({ cause: "provider_window_wait", action: "wait" });
    expect(r.resultFile.window_resets_at).toBeGreaterThan(Date.now() + 60 * 60_000);
    expect(readState(r.runDir).stop).toEqual({ cause: "provider_window_wait", action: "wait" });
  });

  it("generic capacity with reset-like wording stays transient_retry and schedules no window", async () => {
    const at = (model: string): FakeStep => ({ role: "implement", model, error: { message: "429 the model is at capacity; try again shortly", status: 429 } });
    const errors = [
      ...Array.from({ length: 3 }, () => at("opencode-go/deepseek-v4.1-flash")),
      ...Array.from({ length: 3 }, () => at("opencode-go/deepseek-v4-pro")),
    ];
    const r = await runScenario({ script: "clean.json", steps: failFirstImplement(errors) });
    expect(r.resultFile.stop).toEqual({ cause: "transient_retry", action: "retry" });
    expect(r.resultFile.window_resets_at).toBeUndefined();
  });

  it("a usage limit without an explicit reset window does not become a window wait", async () => {
    const at = (model: string): FakeStep => ({ role: "implement", model, error: { message: "usage limit reached" } });
    const errors = [at("opencode-go/deepseek-v4.1-flash"), at("opencode-go/deepseek-v4-pro")];
    const r = await runScenario({ script: "clean.json", steps: failFirstImplement(errors) });
    expect(r.resultFile.stop).not.toEqual({ cause: "provider_window_wait", action: "wait" });
    expect(r.resultFile.window_resets_at).toBeUndefined();
  });
});
