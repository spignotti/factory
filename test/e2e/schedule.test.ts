import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { queueAdd } from "../../src/commands/queue.js";
import type { Io } from "../../src/commands/gates.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { issueRevision, FAIR_WAIT_MS } from "../../src/queue/admit.js";
import { pauseRequested, requestPause } from "../../src/queue/pause.js";
import { loadQueueByKey, repoQueueKey, updateQueue, type QueueEntry } from "../../src/queue/store.js";
import { runQueue, type StartRun, type StartRunRequest } from "../../src/queue/worker.js";
import { runScenario } from "../helpers/scenario.js";
import { createFixtureRepo } from "../helpers/repo.js";

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { out: (s) => void (out += s), err: (s) => void (err += s) }, out: () => out, err: () => err };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "factory-schedule-"));
}

function ready(n: number, extra: Partial<Issue> = {}): Issue {
  return { number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open", ...extra };
}

/** `listOpenIssues` is per repository. The fake otherwise returns every planted issue. */
function scopeOpenIssues(github: FakeGitHub, byRepo: Map<string, number[]>): void {
  github.listOpenIssues = async (repoDir?: string) => {
    const allow = new Set(byRepo.get(repoDir ?? "") ?? []);
    const issues = [...github.issues.values()].filter((issue) => allow.has(issue.number) && (issue.state ?? "open") === "open");
    return { issues: issues.map((issue) => ({ ...issue, state: issue.state ?? "open" })), complete: github.openIssuesComplete };
  };
}

function outcome(repo: string, issue: number, result: RunResult["result"], reason = "", extra: Partial<RunResult> = {}): RunResult {
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

async function enqueue(factoryHome: string, repo: string, github: FakeGitHub, issues: number[], after?: number): Promise<void> {
  for (const n of issues) if (!github.issues.has(n)) github.issues.set(n, ready(n));
  expect(await queueAdd({ factoryHome, repo, issues, after, github }, capture().io)).toBe(0);
}

async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function gate(): { start: StartRun; calls: StartRunRequest[]; release: (issue: number, result: RunResult) => void } {
  const calls: StartRunRequest[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  return {
    calls,
    release(issue, result) {
      const resolve = pending.get(issue);
      if (!resolve) throw new Error(`no pending start for #${issue}`);
      pending.delete(issue);
      resolve(result);
    },
    start: (req) => {
      calls.push(req);
      let resolve!: (r: RunResult) => void;
      const done = new Promise<RunResult>((r) => {
        resolve = r;
      });
      pending.set(req.issue, resolve);
      return { done, pid: 0, runId: () => req.runId, kill: () => undefined, unref: () => undefined };
    },
  };
}

describe("queue schedule", () => {
  it("discovers a ready issue once and skips blocked labels and a short page", async () => {
    const repo = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2 };
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    github.issues.set(2, ready(2));
    github.issues.set(3, ready(3, { labels: ["factory-ready", "needs-decision"] }));
    github.issues.set(4, ready(4, { labels: ["factory-proposal"] }));
    github.issues.set(5, ready(5, { title: "  " }));
    github.issues.set(6, ready(6, { labels: ["factory-ready", "needs-plan"] }));
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("discovered", () => g.calls.map((c) => c.issue).includes(2));
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls.map((c) => c.issue).sort()).toEqual([1, 2]);
      expect((await entries(factoryHome, repo)).map((e) => e.issue).sort()).toEqual([1, 2]);
      g.release(1, outcome(repo, 1, "done"));
      g.release(2, outcome(repo, 2, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
    const again = gate();
    await runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, start: again.start, io: capture().io });
    expect(again.calls).toEqual([]);
    expect((await entries(factoryHome, repo)).map((e) => e.issue).sort()).toEqual([1, 2]);

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    gh2.openIssuesComplete = false;
    await enqueue(home2, repo2, gh2, [1]);
    gh2.issues.set(8, ready(8));
    const g2 = gate();
    const ctl2 = new AbortController();
    const worker2 = runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 2, pollMs: 15, signal: ctl2.signal, start: g2.start, io: capture().io });
    try {
      await waitFor("only queued", () => g2.calls.length === 1);
      await new Promise((r) => setTimeout(r, 40));
      expect(g2.calls.map((c) => c.issue)).toEqual([1]);
      expect((await entries(home2, repo2)).map((e) => e.issue)).toEqual([1]);
    } finally {
      ctl2.abort();
      await worker2.catch(() => undefined);
    }
  });

  it("does not start when factory-ready is removed, and pauses a running issue without a second start", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    github.issues.get(1)!.labels = [];
    const g = gate();
    const cap = capture();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: cap.io });
    try {
      await waitFor("label reason", async () => (await entries(factoryHome, repo))[0]?.reason?.includes("factory-ready") === true);
      expect(g.calls).toEqual([]);
      expect((await entries(factoryHome, repo))[0]?.status).toBe("pending");
      github.issues.get(1)!.labels = ["factory-ready"];
      await waitFor("started", () => g.calls.length === 1);
      github.issues.get(1)!.labels = [];
      await waitFor("paused", async () => (await entries(factoryHome, repo))[0]?.paused === true);
      expect(g.calls).toHaveLength(1);
      const row = (await entries(factoryHome, repo))[0]!;
      expect(row.status).toBe("running");
      expect(row.run_id).toBeTruthy();
      expect(pauseRequested(factoryHome, { runId: row.run_id })).toContain("factory-ready");
      github.issues.get(1)!.labels = ["factory-ready"];
      await waitFor("resumed marker", async () => (await entries(factoryHome, repo))[0]?.paused !== true);
      expect(g.calls).toHaveLength(1);
      expect(pauseRequested(factoryHome, { runId: row.run_id })).toBeUndefined();
      g.release(1, outcome(repo, 1, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("runs two repos inside the global cap and serializes a shared resource", async () => {
    const factoryHome = home();
    const repoA = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2, resources: ["db"] };
    });
    const repoB = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2, resources: ["db"] };
    });
    const github = new FakeGitHub();
    await enqueue(factoryHome, repoA, github, [1]);
    await enqueue(factoryHome, repoB, github, [2]);
    scopeOpenIssues(github, new Map([[repoA, [1]], [repoB, [2]]]));
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, slots: 2, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("first coding run", () => g.calls.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(g.calls).toHaveLength(1);
      const waitingRepo = g.calls[0]!.issue === 1 ? repoB : repoA;
      const waitingIssue = g.calls[0]!.issue === 1 ? 2 : 1;
      expect((await entries(factoryHome, waitingRepo)).find((e) => e.issue === waitingIssue)?.reason).toContain("db");
      g.release(g.calls[0]!.issue, outcome(g.calls[0]!.repo, g.calls[0]!.issue, "done"));
      await waitFor("second after release", () => g.calls.length === 2);
      g.release(g.calls[1]!.issue, outcome(g.calls[1]!.repo, g.calls[1]!.issue, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }

    const home2 = home();
    const left = createFixtureRepo();
    const right = createFixtureRepo();
    const gh2 = new FakeGitHub();
    await enqueue(home2, left, gh2, [1]);
    await enqueue(home2, right, gh2, [2]);
    scopeOpenIssues(gh2, new Map([[left, [1]], [right, [2]]]));
    const g2 = gate();
    const ctl2 = new AbortController();
    const worker2 = runQueue({ factoryHome: home2, github: gh2, slots: 1, pollMs: 15, signal: ctl2.signal, start: g2.start, io: capture().io });
    try {
      await waitFor("global one", () => g2.calls.length === 1);
      await new Promise((r) => setTimeout(r, 40));
      expect(g2.calls).toHaveLength(1);
      const other = g2.calls[0]!.issue === 1 ? right : left;
      expect((await entries(home2, other))[0]?.reason).toBe("global coding cap");
      g2.release(g2.calls[0]!.issue, outcome(g2.calls[0]!.repo, g2.calls[0]!.issue, "done"));
      await waitFor("global second", () => g2.calls.length === 2);
      expect(g2.calls.map((c) => c.issue).sort()).toEqual([1, 2]);
      g2.release(g2.calls[1]!.issue, outcome(g2.calls[1]!.repo, g2.calls[1]!.issue, "done"));
      await worker2;
    } finally {
      ctl2.abort();
      await worker2.catch(() => undefined);
    }
  });

  it("parks a dependency cycle and a closed-without-merge predecessor without starting them again", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.after = 2;
      q.entries[1]!.after = 1;
    });
    const g = gate();
    const cap = capture();
    await runQueue({ factoryHome, github, repo, slots: 2, pollMs: 15, start: g.start, io: cap.io });
    expect(g.calls).toEqual([]);
    expect(cap.out()).toContain("queue: idle");
    const parked = await entries(factoryHome, repo);
    expect(parked.every((e) => e.status === "parked")).toBe(true);
    expect(parked[0]?.reason).toContain("dependency cycle: #1 -> #2 -> #1");
    expect(parked.every((e) => e.blocked_by === undefined)).toBe(true);

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    await enqueue(home2, repo2, gh2, [1]);
    await enqueue(home2, repo2, gh2, [2], 1);
    const g2 = gate();
    const cap2 = capture();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 2, pollMs: 15, signal: ctl.signal, start: g2.start, io: cap2.io });
    try {
      await waitFor("predecessor", () => g2.calls.length === 1);
      g2.release(1, outcome(repo2, 1, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
    expect(g2.calls.map((c) => c.issue)).toEqual([1]);
    expect(cap2.out()).toContain("queue: idle");
    expect((await entries(home2, repo2)).find((e) => e.issue === 2)?.reason).toBe("after #1 closed without merge");
  });

  it("resumes a saved plan after the blocker merges, and replans when the issue text changed", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1]);
    const runId = "20261112-120000-resume";
    const runDir = join(factoryHome, "runs", runId);
    mkdirSync(join(runDir, "worktree"), { recursive: true });
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({ version: 1, goal: "keep" }) + "\n");
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ step: "implement" }) + "\n");
    const rev = issueRevision("Issue 1", "Do the work.");
    await updateQueue(factoryHome, repo, (q) => {
      const entry = q.entries[0]!;
      entry.status = "parked";
      entry.blocked_by = [9];
      entry.run_id = runId;
      entry.issue_rev = rev;
    });
    github.prStates.set("9", { state: "merged", draft: false });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("resume", () => g.calls.length === 1);
      expect(g.calls[0]?.resumeRunId).toBe(runId);
      expect(g.calls[0]?.runId).toBe(runId);
      g.release(1, outcome(repo, 1, "done", "", { run_id: runId }));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }

    const repo2 = createFixtureRepo();
    const home2 = home();
    const gh2 = new FakeGitHub();
    await enqueue(home2, repo2, gh2, [1]);
    const run2 = join(home2, "runs", runId);
    mkdirSync(join(run2, "worktree"), { recursive: true });
    writeFileSync(join(run2, "plan.json"), JSON.stringify({ version: 1 }) + "\n");
    writeFileSync(join(run2, "state.json"), JSON.stringify({ step: "implement" }) + "\n");
    await updateQueue(home2, repo2, (q) => {
      const entry = q.entries[0]!;
      entry.status = "parked";
      entry.blocked_by = [9];
      entry.run_id = runId;
      entry.issue_rev = rev;
    });
    gh2.issues.get(1)!.body = "A different task.";
    gh2.prStates.set("9", { state: "merged", draft: false });
    const g2 = gate();
    const ctl2 = new AbortController();
    const worker2 = runQueue({ factoryHome: home2, github: gh2, repo: repo2, slots: 1, pollMs: 15, signal: ctl2.signal, start: g2.start, io: capture().io });
    try {
      await waitFor("fresh plan", () => g2.calls.length === 1);
      expect(g2.calls[0]?.resumeRunId).toBeUndefined();
      expect(g2.calls[0]?.runId).not.toBe(runId);
      g2.release(1, outcome(repo2, 1, "done"));
      await worker2;
    } finally {
      ctl2.abort();
      await worker2.catch(() => undefined);
    }
  });

  it("starts a mutual bundle as one run and only finishes evidenced extras", async () => {
    const repo = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2 };
    });
    const factoryHome = home();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1, { body: "Do the work.\nfactory-bundle: #2\nfactory-bundle: #3" }));
    github.issues.set(2, ready(2, { body: "Do the work.\nfactory-bundle: #1" }));
    github.issues.set(3, ready(3, { body: "Do the work.\nfactory-bundle: #1" }));
    github.issues.set(4, ready(4, { body: "Do the work.\nfactory-bundle: #1" }));
    await enqueue(factoryHome, repo, github, [1, 2, 3, 4]);
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 4, pollMs: 15, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("bundle start", () => g.calls.length >= 2);
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls.map((c) => c.issue).sort()).toEqual([1, 4]);
      expect(g.calls.find((c) => c.issue === 1)?.bundle).toEqual([2, 3]);
      const rows = await entries(factoryHome, repo);
      expect(rows.find((e) => e.issue === 2)?.bundled_with).toBe(1);
      expect(rows.find((e) => e.issue === 3)?.bundled_with).toBe(1);
      const runId = g.calls.find((c) => c.issue === 1)?.runId;
      expect(runId).toBeTruthy();
      const runDir = join(factoryHome, "runs", runId!);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "plan.json"), JSON.stringify({
        acceptance: [
          { id: "a2", text: "fulfills #2", verify: "review" },
          { id: "a3", text: "fulfills #3", verify: "test" },
        ],
      }) + "\n");
      g.release(1, outcome(repo, 1, "done", "", { run_id: runId, pr: "https://github.test/pr/1" }));
      g.release(4, outcome(repo, 4, "done", "", { pr: "https://github.test/pr/4" }));
      await waitFor("evidenced extra", async () => (await entries(factoryHome, repo)).find((e) => e.issue === 2)?.reason === "fulfilled with #1");
      expect(g.calls.filter((c) => c.issue === 2)).toEqual([]);
      // Missing evidence is not closed with the bundle. The extra may then run on its own.
      await waitFor("unevidenced extra", async () => {
        const row = (await entries(factoryHome, repo)).find((e) => e.issue === 3);
        return row?.reason === "not fulfilled with #1" || g.calls.some((c) => c.issue === 3);
      });
      const third = (await entries(factoryHome, repo)).find((e) => e.issue === 3);
      expect(third?.status).not.toBe("done");
      expect(third?.reason).not.toBe("fulfilled with #1");
      const own = g.calls.find((c) => c.issue === 3);
      if (own) g.release(3, outcome(repo, 3, "done", "", { pr: "https://github.test/pr/3" }));
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("starts an older normal ticket ahead of a newer high-priority one", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    github.issues.get(2)!.labels = ["factory-ready", "priority:high"];
    const now = Date.parse("2026-11-12T12:00:00Z");
    await updateQueue(factoryHome, repo, (q) => {
      q.entries[0]!.added_at = new Date(now - FAIR_WAIT_MS - 60_000).toISOString();
      q.entries[1]!.added_at = new Date(now - 60 * 60_000).toISOString();
    });
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, now: () => now, signal: ctl.signal, start: g.start, io: capture().io });
    try {
      await waitFor("fair start", () => g.calls.length === 1);
      await new Promise((r) => setTimeout(r, 40));
      expect(g.calls.map((c) => c.issue)).toEqual([1]);
      expect((await entries(factoryHome, repo))[0]?.choice).toContain("fair wait");
      g.release(1, outcome(repo, 1, "done"));
      await waitFor("younger high priority", () => g.calls.some((c) => c.issue === 2));
      g.release(2, outcome(repo, 2, "done"));
      await worker;
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("asks for a decision when update-branch conflicts and does not retry it", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    await updateQueue(factoryHome, repo, () => undefined);
    const runId = "20261112-120000-be11ad";
    mkdirSync(join(factoryHome, "runs", runId), { recursive: true });
    writeFileSync(
      join(factoryHome, "runs", runId, "result.json"),
      JSON.stringify(outcome(repo, 7, "done", "", { run_id: runId, pr: "https://github.test/pull/7", branch: "factory/7-goal" })) + "\n",
    );
    github.factoryPrs.push({ number: 7, branch: "factory/7-goal", files: ["src/a.js"] });
    github.prStates.set("7", { state: "open", draft: false, behind: true });
    let attempts = 0;
    github.updateBranch = async () => {
      attempts += 1;
      throw new Error("merge conflict in src/a.js");
    };
    const cap = capture();
    await runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, start: () => { throw new Error("should not start"); }, io: cap.io });
    expect(attempts).toBe(1);
    expect(cap.err()).toContain("update-branch #7 needs a decision");
    expect(cap.out()).toContain("queue: idle");
  });

  it("refuses needs-decision, factory-proposal and an empty task at queue add", async () => {
    const repo = createFixtureRepo();
    const factoryHome = home();
    const github = new FakeGitHub();
    github.issues.set(1, ready(1, { labels: ["factory-ready", "needs-decision"] }));
    github.issues.set(2, ready(2, { labels: ["factory-ready", "factory-proposal"] }));
    github.issues.set(3, ready(3, { body: " " }));
    const decision = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [1], github }, decision.io)).toBe(1);
    expect(decision.err()).toContain("carries needs-decision");
    const proposal = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [2], github }, proposal.io)).toBe(1);
    expect(proposal.err()).toContain("carries factory-proposal");
    const empty = capture();
    expect(await queueAdd({ factoryHome, repo, issues: [3], github }, empty.io)).toBe(1);
    expect(empty.err()).toContain("task is not sufficient");
    expect(await entries(factoryHome, repo)).toEqual([]);
  });
});

describe("pause during a run", () => {
  it("stops at the next step, keeps the worktree, and does not auto-merge", async () => {
    const runId = "20261112-150000-f08a0e";
    const roles: string[] = [];
    let factoryHome = "";
    const run = await runScenario({
      script: "clean.json",
      options: { runId, noPr: true },
      deps: { noNotify: true },
      before: (_repo, homeDir) => {
        factoryHome = homeDir;
      },
      onCall: (req) => {
        roles.push(req.role);
        if (req.role === "plan_high") requestPause(factoryHome, { runId }, "factory-ready removed");
      },
    });
    expect(run.result.result).toBe("needs_human");
    expect(run.result.reason).toContain("paused: factory-ready removed");
    expect(run.result.reason).toContain(`factory resume ${runId}`);
    expect(roles).toContain("plan_high");
    expect(roles).not.toContain("implement");
    expect(run.github.autoMerged).toEqual([]);
    expect(run.file("state.json")).toContain('"step": "implement"');
    expect(run.file("plan.json")).toContain("multiply");
  });
});
