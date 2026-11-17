/**
 * A run that ends done with no commits and no PR (the change is already on the base) tells its issue:
 * one comment per run, `needs-input` on, `factory-ready` off. The issue stays open for a person.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import { queueAdd } from "../../src/commands/queue.js";
import { reportFailure } from "../../src/pipeline/failure.js";
import { noChangeMarker, reportNoChange } from "../../src/pipeline/no-change.js";
import { loadQueueByKey, repoQueueKey, updateQueue, type QueueEntry } from "../../src/queue/store.js";
import { MAX_REPORT_ATTEMPTS, runQueue, type StartRunRequest } from "../../src/queue/worker.js";
import { createFixtureRepo, FIXTURES } from "../helpers/repo.js";
import { runScenario, SECRET } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");

function withIssue(gh: FakeGitHub): void {
  gh.issues.set(7, { number: 7, title: "Multiply", body, labels: ["factory-ready", "prio:high"] });
}

/** The implementer finds the change already there: it writes nothing and says so. */
const alreadyThere = (steps: Parameters<NonNullable<Parameters<typeof runScenario>[0]["steps"]>>[0]) =>
  steps.map((s) =>
    s.role === "implement"
      ? { ...s, writes: {}, output: { ...(s.output as object), done: ["multiply already exists in src/math.js"], decisions: [`nothing to add; token ${SECRET} was in the log`] } }
      : s,
  );

describe("a done run with nothing to change", () => {
  it("tells the issue once, swaps factory-ready for needs-input and opens no PR", async () => {
    const r = await runScenario({ script: "clean.json", options: { issue: 7 }, github: withIssue, steps: alreadyThere });
    expect(r.result.result).toBe("done");
    expect(r.result.pr).toBeNull();
    expect(r.github.prs).toEqual([]);
    expect(r.resultFile.no_change_reported).toBe(true);
    expect(r.resultFile.no_change).toContain("multiply already exists in src/math.js");
    const comments = r.github.comments.get(7)!;
    expect(comments).toHaveLength(1);
    const posted = comments[0]!.body;
    expect(posted).toContain("found nothing to change against the current base branch");
    expect(posted).toContain("multiply already exists in src/math.js");
    expect(posted).toContain("close the issue");
    expect(posted).toContain("remove the `needs-input` label and add `factory-ready` again");
    expect(posted).toContain(noChangeMarker(r.runId));
    // The implementer's own words are redacted like the failure comment.
    expect(posted).not.toContain(SECRET);
    expect(r.github.issues.get(7)!.labels).toEqual(["prio:high", "needs-input"]);
    expect(r.github.issues.get(7)!.state ?? "open").toBe("open");
  });

  it("repeating the report posts nothing twice", async () => {
    const r = await runScenario({ script: "clean.json", options: { issue: 7 }, github: withIssue, steps: alreadyThere });
    await reportNoChange(r.github, r.repo, 7, r.runId, "again");
    await reportNoChange(r.github, r.repo, 7, r.runId, "again");
    expect(r.github.comments.get(7)).toHaveLength(1);
    expect(r.github.issues.get(7)!.labels).toEqual(["prio:high", "needs-input"]);
  });

  it("a comment already there never stands in for the label swap", async () => {
    const r = await runScenario({ script: "clean.json", options: { issue: 7 }, github: withIssue, steps: alreadyThere });
    // The comment landed but the label swap did not; a person replied and the labels are as before.
    r.github.issues.get(7)!.labels = ["factory-ready", "prio:high"];
    r.github.comments.get(7)!.push({ author: "maintainer", association: "OWNER", body: "Thanks, looking.", created_at: "2026-11-16T10:00:00Z" });
    await reportNoChange(r.github, r.repo, 7, r.runId, "again");
    expect(r.github.comments.get(7)).toHaveLength(2);
    expect(r.github.issues.get(7)!.labels).toEqual(["prio:high", "needs-input"]);
  });

  it("redacts before truncating: a secret that crosses the cut is still masked", async () => {
    const redact = (t: string) => t.split(SECRET).join("[redacted]");
    const summary = `${"x".repeat(1485)}${SECRET}`;
    const gh = new FakeGitHub();
    withIssue(gh);
    await reportNoChange(gh, "/repo", 7, "run-1", summary, redact);
    expect(gh.comments.get(7)![0]!.body).not.toContain("fake-foo");
    const reason = `${"y".repeat(1485)}${SECRET}`;
    await reportFailure(gh, "/repo", 7, "run-2", reason, { pr: null }, redact);
    expect(gh.comments.get(7)![1]!.body).not.toContain("fake-foo");
  });

  it("a GitHub error is recorded and never changes the done result", async () => {
    const r = await runScenario({ script: "clean.json", options: { issue: 7 }, github: (gh) => (withIssue(gh), (gh.commentError = "HTTP 502")), steps: alreadyThere });
    expect(r.result.result).toBe("done");
    expect(r.resultFile.no_change_reported).toBe(false);
    expect(r.resultFile.no_change).toContain("multiply already exists");
    expect(r.github.comments.get(7) ?? []).toHaveLength(0);
    expect(r.github.issues.get(7)!.labels).toEqual(["factory-ready", "prio:high"]);
  });

  it("a text task and a run that changed something write nothing", async () => {
    const text = await runScenario({ script: "clean.json", steps: alreadyThere });
    expect(text.result.result).toBe("done");
    expect(text.resultFile).not.toHaveProperty("no_change_reported");
    const changed = await runScenario({ script: "clean.json", options: { issue: 7 }, github: withIssue });
    expect(changed.resultFile).not.toHaveProperty("no_change");
    expect(changed.github.comments.get(7) ?? []).toHaveLength(0);
    expect(changed.github.issues.get(7)!.labels).toEqual(["factory-ready", "prio:high"]);
  });
});

function result(req: StartRunRequest, over: Partial<RunResult>): RunResult {
  return {
    run_id: req.runId ?? "20261116-000000-ffffff", repo: req.repo, task: `#${req.issue}`, type: "feature", lane: "standard", result: "done",
    risk: "low", merge_policy: "human_review", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "no open findings; no commits, no PR",
    branch: null, worktree: null, run_dir: "", ...over,
  };
}

async function queueSetup() {
  const repo = createFixtureRepo();
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  const gh = new FakeGitHub();
  withIssue(gh);
  gh.issues.get(7)!.labels = ["factory-ready"];
  await updateQueue(home, repo, (q) => void q.entries.push({ issue: 7, status: "pending", added_at: "2026-11-16T00:00:00Z" }));
  const starts: StartRunRequest[] = [];
  const work = async (outcome: Partial<RunResult> | (() => Partial<RunResult>)): Promise<QueueEntry> => {
    await runQueue({
      factoryHome: home, github: gh, repo, pollMs: 5, io: { out: () => {}, err: () => {} },
      start: (req) => {
        starts.push(req);
        return { done: Promise.resolve(result(req, typeof outcome === "function" ? outcome() : outcome)), pid: 0, runId: () => req.runId, kill: () => {}, unref: () => {} };
      },
    });
    return loadQueueByKey(home, await repoQueueKey(repo))!.entries.find((e) => e.issue === 7)!;
  };
  return { gh, starts, work, repo, home };
}

describe("queue: a done run with nothing to change", () => {
  it("stays done, is not re-queued while needs-input is set, and starts fresh once factory-ready is back", async () => {
    const s = await queueSetup();
    // The run told the issue itself.
    const first = await s.work(() => (s.gh.issues.get(7)!.labels = ["needs-input"], { no_change: "already merged", no_change_reported: true }));
    expect(first).toMatchObject({ status: "done", no_change: { summary: "already merged", posted: true }, delivery: { pr: null } });
    expect(s.starts).toHaveLength(1);
    // needs-input alone, or factory-ready with needs-input still on: nothing starts.
    await s.work({});
    s.gh.issues.get(7)!.labels = ["needs-input", "factory-ready"];
    await s.work({});
    expect(s.starts).toHaveLength(1);
    // A person added the missing detail and swapped the labels.
    s.gh.issues.get(7)!.labels = ["factory-ready"];
    const again = await s.work({ reason: "second run" });
    expect(s.starts).toHaveLength(2);
    expect(s.starts[1]!.resumeRunId).toBeUndefined();
    expect(s.starts[1]!.runId).not.toBe(s.starts[0]!.runId);
    expect(again).toMatchObject({ status: "done", run_id: s.starts[1]!.runId, delivery: { pr: null } });
    expect(again.no_change).toBeUndefined();
  });

  it("a GitHub error leaves it unreported; a later tick reports it once and the issue is not started again", async () => {
    const s = await queueSetup();
    s.gh.commentError = "HTTP 502";
    const first = await s.work({ no_change: "already merged", no_change_reported: false });
    expect(first).toMatchObject({ status: "done", no_change: { summary: "already merged", posted: false } });
    expect(s.gh.issues.get(7)!.labels).toEqual(["factory-ready"]);
    // Still ready on GitHub, but the entry is done: nothing starts while the report is pending.
    s.gh.commentError = null;
    const second = await s.work({});
    expect(second).toMatchObject({ status: "done", no_change: { posted: true } });
    expect(s.starts).toHaveLength(1);
    const comments = s.gh.comments.get(7)!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(noChangeMarker(s.starts[0]!.runId!));
    expect(comments[0]!.body).toContain("already merged");
    expect(s.gh.issues.get(7)!.labels).toEqual(["needs-input"]);
    // A third tick neither posts again nor starts.
    await s.work({});
    expect(s.gh.comments.get(7)).toHaveLength(1);
    expect(s.starts).toHaveLength(1);
  });

  it("a comment and a reply without the label swap: the retry swaps the labels and nothing restarts", async () => {
    const s = await queueSetup();
    s.gh.issueLabelError = "HTTP 502";
    const first = await s.work({ no_change: "already merged", no_change_reported: false });
    expect(first.no_change).toMatchObject({ posted: false, attempts: 1 });
    s.gh.comments.get(7)!.push({ author: "maintainer", association: "OWNER", body: "On it.", created_at: "2026-11-16T10:00:00Z" });
    s.gh.issueLabelError = null;
    const second = await s.work({});
    expect(second).toMatchObject({ status: "done", no_change: { posted: true } });
    expect(s.starts).toHaveLength(1);
    expect(s.gh.issues.get(7)!.labels).toEqual(["needs-input"]);
  });

  it("stops retrying the report after MAX_REPORT_ATTEMPTS", async () => {
    const s = await queueSetup();
    s.gh.commentError = "HTTP 502";
    let entry = await s.work({ no_change: "already merged", no_change_reported: false });
    for (let i = 1; i < MAX_REPORT_ATTEMPTS + 2; i++) entry = await s.work({});
    expect(entry.no_change).toMatchObject({ posted: false, attempts: MAX_REPORT_ATTEMPTS });
    s.gh.commentError = null;
    await s.work({});
    expect(s.gh.comments.get(7) ?? []).toHaveLength(0);
    expect(s.starts).toHaveLength(1);
  }, 120_000);

  it("queue add for the issue replaces the done entry instead of racing it", async () => {
    const s = await queueSetup();
    await s.work(() => (s.gh.issues.get(7)!.labels = ["needs-input"], { no_change: "already merged", no_change_reported: true }));
    s.gh.issues.get(7)!.labels = ["factory-ready"];
    const out: string[] = [];
    expect(await queueAdd({ factoryHome: s.home, repo: s.repo, issues: [7], github: s.gh }, { out: (t) => void out.push(t), err: (t) => void out.push(t) })).toBe(0);
    const q = loadQueueByKey(s.home, await repoQueueKey(s.repo))!;
    expect(q.entries.filter((e) => e.issue === 7)).toMatchObject([{ status: "pending" }]);
    const entry = await s.work({});
    expect(s.starts).toHaveLength(2);
    expect(entry.no_change).toBeUndefined();
  });

  it("a plain done run without the field is unchanged", async () => {
    const s = await queueSetup();
    const entry = await s.work({ reason: "done" });
    expect(entry).toMatchObject({ status: "done" });
    expect(entry.no_change).toBeUndefined();
    expect(s.gh.comments.get(7) ?? []).toHaveLength(0);
  });
});
