/**
 * The queue's one failed exit: every outcome that is not done, a question, a provider wait, a base
 * problem, a lock or a pause fails the ticket on its issue, closes the run's PR and waits for nobody.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, githubUnavailable } from "../../src/gh.js";
import { isFailedExit } from "../../src/pipeline/failure.js";
import { stopFor } from "../../src/pipeline/outcome.js";
import { loadQueueByKey, repoQueueKey, summarizeQueue, updateQueue, type QueueEntry, type QueueFile } from "../../src/queue/store.js";
import { applyOutcome, MAX_REPORT_ATTEMPTS, runQueue, type StartRunRequest } from "../../src/queue/worker.js";

import { createFixtureRepo, FIXTURES, gitIn } from "../helpers/repo.js";

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
          const branch = `factory/7-multiply-${starts.length}`;
          const pr = await gh.createPr({ repoDir: repo, head: branch, base: "main", title: "feat: multiply", body: "", draft: false });
          // The run's checkpoint: its branch, worktree and the head it pushed.
          const head = gitIn(repo, "rev-parse", "HEAD").trim();
          gh.remoteShas.set(branch, head);
          const dir = join(home, "runs", req.runId!);
          mkdirSync(join(dir, "worktree"), { recursive: true });
          writeFileSync(join(dir, "plan.json"), "{}");
          writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, run_id: req.runId, repo, task: { ref: "#7", issue: 7, text: "", labels: [] }, step: "finalize", result: null, reason: "", branch, worktree: repo, base_sha: null, approved_sha: head, pr, packages: {}, failures: {}, handoffs: [], rounds: 0, findings: [], gate_count: 0, pr_draft: false, no_pr: false, updated_at: new Date().toISOString() }));
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

  it("a fresh run never reports on the previous run's PR", async () => {
    const s = await setup();
    await s.work((pr) => ({ result: "failed", reason: "resolver gave up", pr }));
    s.gh.issues.get(7)!.labels = ["factory-ready"];
    // The fresh run fails before result.json names a PR: its own state's PR is the target.
    const entry = await s.work(() => ({ result: "failed", reason: "second try gave up", pr: null }));
    expect(entry).toMatchObject({ status: "parked", failed: { reported: true }, run_id: s.starts[1]!.runId });
    expect(s.gh.closed).toEqual(["https://github.test/pr/1", "https://github.test/pr/2"]);
    expect(s.gh.comments.get(7)!.at(-1)!.body).toContain("https://github.test/pr/2");
  });

  it("a PR whose head is not the run's own commit is never closed", async () => {
    const s = await setup();
    const entry = await s.work((pr) => {
      // Someone pushed to the run's branch after it ended.
      s.gh.remoteShas.set(s.gh.prs[0]!.head, "f".repeat(40));
      return { result: "failed", reason: "resolver gave up", pr };
    });
    expect(entry).toMatchObject({ status: "parked", failed: { reported: true } });
    expect(s.gh.closed).toEqual([]);
    expect(s.gh.remoteShas.get(s.gh.prs[0]!.head)).toBe("f".repeat(40));
  });

  it("spent provider retries fail the ticket with a reason, but leave its PR open", async () => {
    const s = await setup();
    const entry = await s.work((pr) => ({ result: "needs_human", reason: "provider down; factory resume x", stop: stopFor("transient_retry"), pr }));
    expect(s.starts).toHaveLength(3);
    expect(entry).toMatchObject({ status: "parked", failed: { reported: true, keep_pr: true } });
    expect(entry.reason).toMatch(/^provider retries spent \(2\/2\); provider down/);
    expect(s.gh.closed).toEqual([]);
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-failed"]);
    expect(s.gh.comments.get(7)![0]!.body).toContain("stays open");
    // The kept PR holds a fresh start, visibly, until a human closes it.
    s.gh.issues.get(7)!.labels = ["factory-ready"];
    const held = await s.work(() => ({}));
    expect(held).toMatchObject({ status: "parked", reason: "open factory PR #1", blocked_by: [1] });
    expect(s.starts).toHaveLength(3);
    // A person closes the PRs the retried runs left open.
    for (const p of s.gh.prs) await s.gh.closePr(s.repo, p.url, { branch: p.head, heads: [s.gh.remoteShas.get(p.head)!] });
    // A human restart gets fresh retry budgets.
    const again = await s.work((pr) => ({ result: "done", pr }));
    expect(again).toMatchObject({ status: "done" });
    expect(again.requeues).toBeUndefined();
  });

  it("a spawn error gets the bounded retry before the failed exit", async () => {
    const s = await setup();
    let tries = 0;
    await runQueue({
      factoryHome: s.home, github: s.gh, repo: s.repo, pollMs: 5, io: { out: () => {}, err: () => {} },
      start: () => {
        tries++;
        throw new Error("spawn EAGAIN");
      },
    });
    const entry = loadQueueByKey(s.home, await repoQueueKey(s.repo))!.entries[0]!;
    expect(tries).toBe(3);
    expect(entry).toMatchObject({ status: "parked", reason: "spawn EAGAIN (retried 2 times)", failed: { reported: false } });
    // The next tick reports it.
    const reported = await s.work(() => ({}));
    expect(reported).toMatchObject({ status: "parked", failed: { reported: true } });
    expect(s.gh.comments.get(7)![0]!.body).toContain("spawn EAGAIN");
  });

  it("a permanent close error still posts the comment and labels, and stops retrying at the bound", async () => {
    const s = await setup();
    s.gh.closeError = "HTTP 403: Resource not accessible by integration";
    const first = await s.work((pr) => ({ result: "failed", reason: "resolver gave up", pr }));
    expect(first).toMatchObject({ status: "parked", failed: { reported: false, attempts: 1 } });
    expect(s.gh.comments.get(7)).toHaveLength(1);
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-failed"]);
    await updateQueue(s.home, s.repo, (q) => void (q.entries[0]!.failed!.attempts = MAX_REPORT_ATTEMPTS - 1));
    const capped = await s.work(() => ({}));
    expect(capped.failed).toEqual({ reported: false, attempts: MAX_REPORT_ATTEMPTS });
    await s.work(() => ({}));
    expect(loadQueueByKey(s.home, await repoQueueKey(s.repo))!.entries[0]!.failed!.attempts).toBe(MAX_REPORT_ATTEMPTS);
    expect(s.gh.comments.get(7)).toHaveLength(1);
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
    ["usage window", r({ result: "needs_human", stop: stopFor("provider_window_wait"), window_resets_at: Date.now() + 3_600_000 }), false],
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
    // Reported on the issue, but a stop that waits for a person never closes its PR.
    expect(f.failed).toEqual({ reported: false, keep_pr: true });
  });

  it("only HTTP 5xx forms and outage wording count as a GitHub outage", () => {
    expect(githubUnavailable("HTTP 503: Service Unavailable")).toBe(true);
    expect(githubUnavailable("fatal: unable to access: The requested URL returned error: 502")).toBe(true);
    expect(githubUnavailable("gh: timeout")).toBe(true);
    expect(githubUnavailable("! [remote rejected] factory/42-fix-500-error (protected branch hook declined)")).toBe(false);
    expect(githubUnavailable("HTTP 403: Resource not accessible by integration")).toBe(false);
  });

  it("any other locked result goes back to pending", () => {
    const e = entry();
    expect(applyOutcome(q(), e, r({ result: "locked", reason: "resource db is held by run x (pid 1)" }))).toBe("requeue");
    expect(e.status).toBe("pending");
  });
});
