/**
 * The queue's one failed exit: every outcome that is not done, a question, a provider wait, a base
 * problem, a lock or a pause fails the ticket on its issue, closes the run's PR and waits for nobody.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import { isFailedExit } from "../../src/pipeline/failure.js";
import { stopFor } from "../../src/pipeline/outcome.js";
import { loadQueueByKey, repoQueueKey, summarizeQueue, updateQueue, type QueueEntry, type QueueFile } from "../../src/queue/store.js";
import { applyOutcome, runQueue, type StartRunRequest } from "../../src/queue/worker.js";
import { createFixtureRepo, FIXTURES } from "../helpers/repo.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");

function result(req: StartRunRequest, over: Partial<RunResult>): RunResult {
  return {
    run_id: req.runId ?? "20261116-000000-ffffff", repo: req.repo, task: `#${req.issue}`, type: "feature", lane: "standard", result: "done",
    risk: "low", merge_policy: "human_review", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "",
    branch: null, worktree: null, run_dir: "", ...over,
  };
}

interface Setup {
  repo: string;
  home: string;
  gh: FakeGitHub;
  starts: StartRunRequest[];
  /** Runs the worker until the queue is idle; each start opens a factory PR and ends with `outcome(pr)`. */
  work: (outcome: (pr: string) => Partial<RunResult>) => Promise<QueueEntry>;
}

async function setup(): Promise<Setup> {
  const repo = createFixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  const gh = new FakeGitHub();
  gh.issues.set(7, { number: 7, title: "Multiply", body, labels: ["factory-ready"] });
  await updateQueue(home, repo, (q) => void q.entries.push({ issue: 7, status: "pending", added_at: "2026-11-16T00:00:00Z" }));
  const starts: StartRunRequest[] = [];
  const work = async (outcome: (pr: string) => Partial<RunResult>): Promise<QueueEntry> => {
    await runQueue({
      factoryHome: home, github: gh, repo, pollMs: 5, io: { out: () => {}, err: () => {} },
      start: (req) => {
        starts.push(req);
        const done = (async () => {
          const pr = await gh.createPr({ repoDir: repo, head: `factory/7-multiply-${starts.length}`, base: "main", title: "feat: multiply", body: "", draft: false });
          return result(req, outcome(pr));
        })();
        return { done, pid: 0, runId: () => req.runId, kill: () => {}, unref: () => {} };
      },
    });
    return loadQueueByKey(home, await repoQueueKey(repo))!.entries.find((e) => e.issue === 7)!;
  };
  return { repo, home, gh, starts, work };
}

describe("queue failed exit", () => {
  it("an unknown non-done result ends failed and is reported on the issue once; the PR is closed", async () => {
    const s = await setup();
    const entry = await s.work((pr) => ({ result: "needs_human", reason: "a stop nobody listed", stop: stopFor("unknown"), pr }));
    const pr = s.gh.prs[0]!.url;
    expect(entry).toMatchObject({ status: "parked", reason: "a stop nobody listed", failed: { reported: true }, run_id: s.starts[0]!.runId });
    expect(s.gh.closed).toEqual([pr]);
    expect(s.gh.prStates.get(pr)?.state).toBe("closed");
    expect(s.gh.factoryPrs).toEqual([]);
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-failed"]);
    const comments = s.gh.comments.get(7)!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("a stop nobody listed");
    expect(comments[0]!.body).toContain(`<!-- factory:failed run=${s.starts[0]!.runId} -->`);
    expect(summarizeQueue(loadQueueByKey(s.home, await repoQueueKey(s.repo))!).next[0]!.reason).toBe("failed: a stop nobody listed");
  });

  it("a GitHub error leaves the entry failed but unreported; a later tick reports it once", async () => {
    const s = await setup();
    s.gh.commentError = "HTTP 502";
    const first = await s.work((pr) => ({ result: "failed", reason: "resolver gave up", pr }));
    expect(first).toMatchObject({ status: "parked", failed: { reported: false } });
    expect(summarizeQueue(loadQueueByKey(s.home, await repoQueueKey(s.repo))!).next[0]!.reason).toBe("failed (not reported on the issue yet): resolver gave up");
    s.gh.commentError = null;
    const second = await s.work(() => ({}));
    expect(second).toMatchObject({ status: "parked", failed: { reported: true } });
    expect(s.starts).toHaveLength(1);
    expect(s.gh.comments.get(7)).toHaveLength(1);
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-failed"]);
  });

  it("a failed entry restarts as a FRESH run once factory-ready is back and factory-failed is gone", async () => {
    const s = await setup();
    await s.work((pr) => ({ result: "failed", reason: "resolver gave up", pr }));
    // Labels still say failed: nothing starts.
    s.gh.issues.get(7)!.labels = ["factory-failed", "factory-ready"];
    await s.work(() => ({}));
    expect(s.starts).toHaveLength(1);
    // The area session rewrote the ticket and swapped the labels back.
    s.gh.issues.get(7)!.labels = ["factory-ready"];
    const entry = await s.work((pr) => ({ result: "done", pr }));
    expect(s.starts).toHaveLength(2);
    expect(s.starts[1]!.resumeRunId).toBeUndefined();
    expect(s.starts[1]!.runId).not.toBe(s.starts[0]!.runId);
    expect(entry).toMatchObject({ status: "done", run_id: s.starts[1]!.runId, pr: "https://github.test/pr/2" });
    expect(s.gh.closed).toEqual(["https://github.test/pr/1"]);
    expect(entry.failed).toBeUndefined();
  });

  it("a hard-list done run is not failed: its ready PR stays open for a human merge", async () => {
    const s = await setup();
    const entry = await s.work((pr) => ({ result: "done", merge_policy: "human_review", risk: "high", pr }));
    const pr = s.gh.prs[0]!.url;
    expect(entry).toMatchObject({ status: "done", pr });
    expect(entry.failed).toBeUndefined();
    expect(s.gh.closed).toEqual([]);
    expect(s.gh.prStates.get(pr)?.state).toBe("open");
    expect(s.gh.comments.get(7)).toBeUndefined();
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-ready"]);
  });

  it("a question is not failed: it waits for the answer", async () => {
    const s = await setup();
    // The run posted the questions and swapped the labels.
    const entry = await s.work(() => (s.gh.issues.get(7)!.labels = ["needs-input"], { result: "needs_input", reason: "plan needs input", stop: stopFor("explicit_decision"), questions: ["Which rounding?"], questions_posted: true }));
    expect(entry).toMatchObject({ status: "parked", awaiting_answer: { questions: ["Which rounding?"], posted: true } });
    expect(entry.failed).toBeUndefined();
    expect(s.gh.closed).toEqual([]);
    expect(s.gh.issues.get(7)!.labels).toEqual(["needs-input"]);
    expect(s.gh.comments.get(7)).toBeUndefined();
  });

  it("a run that already reported its failure is not reported twice", async () => {
    const s = await setup();
    // The run itself commented, swapped the labels and closed its PR.
    const entry = await s.work((pr) => (s.gh.issues.get(7)!.labels = ["factory-failed"], { result: "failed", reason: "resolver gave up", failure_reported: true, pr }));
    expect(entry).toMatchObject({ status: "parked", failed: { reported: true } });
    expect(s.gh.comments.get(7)).toBeUndefined();
    expect(s.gh.closed).toEqual([]);
  });
});

describe("which outcomes fail", () => {
  const q = (): QueueFile => ({ version: 1, repo: "/r", repo_key: "k", entries: [] });
  const entry = (): QueueEntry => ({ issue: 1, status: "running", added_at: "2026-11-16T00:00:00Z" });
  const r = (over: Partial<RunResult>): RunResult => result({ issue: 1, repo: "/r", runId: "20261116-000000-aaaaaa", factoryHome: "/h" } as StartRunRequest, over);

  it.each([
    ["done", r({}), false],
    ["question", r({ result: "needs_input", questions: ["?"] }), false],
    ["transient retry", r({ result: "needs_human", stop: stopFor("transient_retry") }), false],
    ["usage window", r({ result: "needs_human", stop: stopFor("provider_window_wait") }), false],
    ["base_red", r({ result: "base_red" }), false],
    ["locked", r({ result: "locked", reason: "resource db is held by run x (pid 1)" }), false],
    ["failed", r({ result: "failed", reason: "x" }), true],
    ["unknown stop", r({ result: "needs_human", stop: stopFor("unknown") }), true],
    ["decision stop", r({ result: "needs_human", stop: stopFor("explicit_decision") }), true],
    ["no stop at all", r({ result: "needs_human" }), true],
    ["question without questions", r({ result: "needs_input" }), true],
  ] as const)("%s", (_label, res, failed) => {
    expect(isFailedExit(res)).toBe(failed);
    const e = entry();
    applyOutcome(q(), e, res);
    expect(e.failed !== undefined).toBe(failed);
  });

  it("a pause (human_approval with a pause marker) is not failed; the same stop without a marker is", () => {
    const paused = r({ result: "needs_human", reason: "paused: operator", stop: stopFor("human_approval") });
    const e = entry();
    applyOutcome(q(), e, paused, { paused: true });
    expect(e).toMatchObject({ status: "parked" });
    expect(e.failed).toBeUndefined();
    const f = entry();
    applyOutcome(q(), f, paused);
    expect(f.failed).toEqual({ reported: false });
  });

  it("any other locked result goes back to pending", () => {
    const e = entry();
    expect(applyOutcome(q(), e, r({ result: "locked", reason: "resource db is held by run x (pid 1)" }))).toBe("requeue");
    expect(e.status).toBe("pending");
  });
});
