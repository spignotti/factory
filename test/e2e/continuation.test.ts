import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import { readState } from "../../src/pipeline/state.js";
import { issueRevision } from "../../src/queue/admit.js";
import { clearPause, pauseRequested, requestPause } from "../../src/queue/pause.js";
import { loadQueueByKey, repoQueueKey, updateQueue } from "../../src/queue/store.js";
import { runQueue } from "../../src/queue/worker.js";
import { FIXTURES, commitFile } from "../helpers/repo.js";
import { resumeScenario, runScenario } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");
const issue = { number: 7, title: "Multiply", body, labels: ["factory-ready"] };

async function redPr() {
  let checks = 0;
  return runScenario({ script: "clean.json", options: { issue: 7 }, patch: (cfg) => { cfg.merge = { auto_merge_max_risk: "low" }; }, github: (gh) => {
    gh.issues.set(7, issue);
    gh.baseStatus = async () => checks++ === 0 ? "none" : "red";
  } });
}

describe("bounded post-push continuation", () => {
  it("reuses a test invocation that already supplied gate evidence", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "evidence-count-")), "runs");
    const r = await runScenario({ script: "clean.json", github: (gh) => { gh.status = "green"; },
      patch: (cfg) => { cfg.checks = [{ name: "unit", run: "node --test test/multiply.test.js", tier: "fast" }]; },
      steps: (steps) => steps.map((s) => s.role !== "implement" ? s : { ...s, writes: { ...s.writes,
        "test/multiply.test.js": `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "ran\\n");\n${s.writes!["test/multiply.test.js"]}`,
      } }),
    });
    expect(r.result.result).toBe("done");
    // One fast gate and one final full gate; neither adds a duplicate evidence invocation.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });
  it("repairs a CI-only assertion on the same PR, then reviews the actual fixed commit", async () => {
    const r = await redPr();
    expect(r.result.result).toBe("needs_human");
    expect(readState(r.runDir).continuation?.kind).toBe("ci");
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
    await updateQueue(r.factoryHome, r.repo, (q) => q.entries.push({
      issue: 7, status: "parked", added_at: new Date().toISOString(), run_id: r.runId,
      issue_rev: issueRevision(issue.title, issue.body), pr: r.result.pr!,
    }));
    let resumed: Awaited<ReturnType<typeof resumeScenario>> | undefined;
    const starts: string[] = [];
    await runQueue({ factoryHome: r.factoryHome, github: r.github, repo: r.repo, pollMs: 10,
      start: (req) => {
        expect(req.resumeRunId).toBe(r.runId);
        starts.push(req.resumeRunId!);
        const done = resumeScenario(r, { script: "clean.json", steps: (steps) => steps
          .filter((s) => !s.role.startsWith("plan_"))
          .map((s) => s.role !== "implement" ? s : { ...s,
            writes: { ...s.writes, "src/math.js": `${s.writes!["src/math.js"]}\n// Correct the CI-only boundary.\n` },
            output: { ...(s.output as object), package: "fix" },
          }) }).then((result) => { resumed = result; return result.result; });
        return { done, pid: 0, runId: () => r.runId, kill: () => {}, unref: () => {} };
      },
    });
    expect(starts).toEqual([r.runId]);
    expect(resumed!.result).toMatchObject({ result: "done", pr: r.result.pr, run_id: r.runId, branch: readState(r.runDir).branch, worktree: readState(r.runDir).worktree });
    expect(resumed!.runner.calls.map((c) => c.role)).toEqual(["implement", "review_plan", "review_simplicity", "pr_writer"]);
    expect(r.github.prs).toHaveLength(1);
    const st = readState(r.runDir);
    expect(st.continuation_attempts).toBe(1);
    expect(st.continuation).toBeUndefined();
    expect(st.reviewed_sha).toBe(st.approved_sha);
    expect(st.reviewed_sha).not.toBe((JSON.parse(r.file("ci-failure-1.json")) as { sha: string }).sha);
  });

  it("does not edit product code when the diagnosed CI head is no longer current", async () => {
    const r = await redPr();
    const st = readState(r.runDir);
    st.continuation = { kind: "ci", sha: "f".repeat(40) };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
    const next = await resumeScenario(r, { script: "clean.json" });
    expect(next.result.reason).toMatch(/head moved before diagnosis/);
    expect(next.runner.calls).toEqual([]);
  });

  it("does not reset the persisted attempt budget or edit code for an unknown CI failure", async () => {
    const r = await redPr();
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "external", output_tail: "No actionable diagnosis" }];
    const resumed = await resumeScenario(r, { script: "clean.json" });
    expect(resumed.result.result).toBe("needs_human");
    expect(resumed.runner.calls).toEqual([]);
    expect(readState(r.runDir).continuation_attempts).toBe(1);
    const st = readState(r.runDir);
    st.continuation_attempts = 2;
    st.continuation = { kind: "ci", sha: st.reviewed_sha! };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    const exhausted = await resumeScenario(r, { script: "clean.json" });
    expect(exhausted.result.reason).toMatch(/exhausted/);
    expect(exhausted.runner.calls).toEqual([]);
    expect(readState(r.runDir).continuation_attempts).toBe(2);
  });

  it("revalidates a moved base with gates and delta review instead of stamping a review SHA", async () => {
    const r = await runScenario({ script: "clean.json" });
    const prior = readState(r.runDir).reviewed_sha;
    commitFile(r.repo, "src/new-base.js", "export const fresh = true;\n", "feat: base moved");
    const st = readState(r.runDir);
    st.continuation = { kind: "base", sha: st.approved_sha! };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    const next = await resumeScenario(r, { script: "clean.json", steps: (s) => s.filter((x) => ["review_plan", "review_simplicity", "pr_writer"].includes(x.role)) });
    expect(next.result.result).toBe("done");
    expect(next.runner.calls.map((c) => c.role)).toEqual(["review_plan", "review_simplicity", "pr_writer"]);
    expect(next.runner.calls[0]!.prompt).toContain("incremental_diff");
    expect(readState(r.runDir).reviewed_sha).not.toBe(prior);
    expect(r.github.updatedBranches).toEqual([]);
  });

  it("leaves uncommitted work untouched during automatic recovery", async () => {
    const r = await redPr();
    writeFileSync(join(r.runDir, "worktree/src/personal.js"), "uncommitted\n");
    const next = await resumeScenario(r, { script: "clean.json" });
    expect(next.result.reason).toMatch(/uncommitted changes/);
    expect(next.runner.calls).toEqual([]);
    expect(readFileSync(join(r.runDir, "worktree/src/personal.js"), "utf8")).toBe("uncommitted\n");
  });

  it("does not edit product code when a pause marker is set, even on an already queued continuation", async () => {
    const r = await redPr();
    const math = join(readState(r.runDir).worktree!, "src/math.js");
    const before = readFileSync(math, "utf8");
    const attempts = readState(r.runDir).continuation_attempts;
    requestPause(r.factoryHome, { runId: r.runId }, "operator pause");
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
    const next = await resumeScenario(r, {
      script: "clean.json",
      steps: (steps) => steps.map((s) => s.role !== "implement" ? s : {
        ...s,
        writes: { ...s.writes, "src/math.js": `${s.writes!["src/math.js"]}\n// paused repair must not land\n` },
      }),
    });
    expect(next.runner.calls.map((c) => c.role)).not.toContain("implement");
    expect(next.runner.calls).toEqual([]);
    expect(readFileSync(math, "utf8")).toBe(before);
    expect(readFileSync(math, "utf8")).not.toContain("paused repair must not land");
    expect(next.result.result).toBe("needs_human");
    expect(next.result.reason).toMatch(/paused: operator pause/);
    expect(next.resultFile.stop).toEqual({ cause: "human_approval", action: "approve" });
    expect(readState(r.runDir).continuation_attempts).toBe(attempts);
    expect(pauseRequested(r.factoryHome, { runId: r.runId })).toBe("operator pause");
    expect(r.github.autoMerged).toEqual([]);
  });
});

describe("worker continuation follows the stored stop, not a stale field", () => {
  function writeStop(runDir: string, stop: unknown | undefined): void {
    const st = readState(runDir);
    if (stop === undefined) delete st.stop;
    else st.stop = stop as NonNullable<typeof st.stop>;
    writeFileSync(join(runDir, "state.json"), JSON.stringify(st));
    const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as { stop?: unknown };
    if (stop === undefined) delete result.stop;
    else result.stop = stop;
    writeFileSync(join(runDir, "result.json"), JSON.stringify(result) + "\n");
  }

  async function denied(stop: unknown | undefined, label: string): Promise<void> {
    const r = await redPr();
    writeStop(r.runDir, stop);
    r.github.baseStatus = async () => "green";
    r.github.issues.set(8, { number: 8, title: "Other", body: "Independent work.", labels: ["factory-ready"], state: "open" });
    await updateQueue(r.factoryHome, r.repo, (q) => {
      q.entries.push({
        issue: 7, status: "parked", added_at: "2026-01-01T00:00:00Z", run_id: r.runId,
        issue_rev: issueRevision(issue.title, issue.body), pr: r.result.pr!,
      });
      q.entries.push({ issue: 8, status: "pending", added_at: "2026-01-02T00:00:00Z" });
    });
    const starts: { issue: number; resume?: string }[] = [];
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome: r.factoryHome, github: r.github, repo: r.repo, slots: 1, pollMs: 10, signal: ctl.signal,
      start: (req) => {
        starts.push({ issue: req.issue, resume: req.resumeRunId });
        const done: RunResult = {
          run_id: req.resumeRunId ?? `20261029-130000-${req.issue.toString(16).padStart(6, "0")}`,
          repo: r.repo, task: `#${req.issue}`, type: "feature", lane: "standard", result: "done",
          risk: "low", merge_policy: "human_review", pr: req.resumeRunId ? r.result.pr : "https://github.test/pr/8",
          rounds: 0, minutes: 0, cost_usd: 0, reason: "", branch: null, worktree: null, run_dir: "",
        };
        return { done: Promise.resolve(done), pid: 0, runId: () => done.run_id, kill: () => undefined, unref: () => undefined };
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (starts.some((s) => s.resume)) break;
      const rows = loadQueueByKey(r.factoryHome, await repoQueueKey(r.repo))?.entries ?? [];
      if (starts.some((s) => s.issue === 8) && rows.find((e) => e.issue === 7)?.status === "parked") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ctl.abort();
    await worker.catch(() => undefined);
    const entries = loadQueueByKey(r.factoryHome, await repoQueueKey(r.repo))!.entries;
    expect(starts, label).toEqual([{ issue: 8 }]);
    expect(entries.find((e) => e.issue === 7), label).toMatchObject({ status: "parked", run_id: r.runId });
    expect(r.github.autoMergeDisabled, label).toEqual([]);
    expect(r.github.autoMerged, label).toEqual([]);
    expect(r.github.prs).toHaveLength(1);
  }

  it("does not continue a decision stop; independent work uses the free slot", async () => {
    await denied({ cause: "explicit_decision", action: "decide" }, "decision");
  });

  it("does not continue a protected approval stop; independent work uses the free slot", async () => {
    await denied({ cause: "human_approval", action: "approve" }, "protected");
  });

  it("does not continue an unknown stop; independent work uses the free slot", async () => {
    await denied({ cause: "unknown", action: "none" }, "unknown");
  });

  it("does not continue a budget_exhausted stop; independent work uses the free slot", async () => {
    await denied({ cause: "budget_exhausted", action: "decide" }, "budget");
  });

  it("does not continue a stopped run whose stop metadata is missing", async () => {
    await denied(undefined, "missing");
  }, 120_000);

  it("does not continue a stopped run whose repair action does not match", async () => {
    await denied({ cause: "technical_repair", action: "none" }, "mismatch");
  }, 120_000);

  it("does not start an already queued continuation while paused; independent work uses the slot", async () => {
    const r = await redPr();
    const math = join(readState(r.runDir).worktree!, "src/math.js");
    const before = readFileSync(math, "utf8");
    requestPause(r.factoryHome, { runId: r.runId }, "operator pause");
    r.github.baseStatus = async () => "green";
    r.github.issues.set(8, { number: 8, title: "Other", body: "Independent work.", labels: ["factory-ready"], state: "open" });
    await updateQueue(r.factoryHome, r.repo, (q) => {
      q.entries.push({
        issue: 7, status: "pending", added_at: "2026-01-01T00:00:00Z", run_id: r.runId,
        issue_rev: issueRevision(issue.title, issue.body), pr: r.result.pr!,
      });
      q.entries.push({ issue: 8, status: "pending", added_at: "2026-01-02T00:00:00Z" });
    });
    const starts: { issue: number; resume?: string }[] = [];
    const killed: number[] = [];
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome: r.factoryHome, github: r.github, repo: r.repo, slots: 1, pollMs: 10, signal: ctl.signal,
      start: (req) => {
        starts.push({ issue: req.issue, resume: req.resumeRunId });
        const done: RunResult = {
          run_id: req.resumeRunId ?? `20261029-130000-${req.issue.toString(16).padStart(6, "0")}`,
          repo: r.repo, task: `#${req.issue}`, type: "feature", lane: "standard", result: "done",
          risk: "low", merge_policy: "human_review", pr: req.resumeRunId ? r.result.pr : "https://github.test/pr/8",
          rounds: 0, minutes: 0, cost_usd: 0, reason: "", branch: null, worktree: null, run_dir: "",
        };
        return {
          done: Promise.resolve(done), pid: 0, runId: () => done.run_id,
          kill: () => killed.push(req.issue), unref: () => undefined,
        };
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const rows = loadQueueByKey(r.factoryHome, await repoQueueKey(r.repo))?.entries ?? [];
      const eight = rows.find((e) => e.issue === 8);
      if (starts.some((s) => s.issue === 8) && eight?.status === "done") break;
      if (starts.some((s) => s.resume === r.runId)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ctl.abort();
    await worker.catch(() => undefined);
    const paused = loadQueueByKey(r.factoryHome, await repoQueueKey(r.repo))!.entries.find((e) => e.issue === 7);
    expect(starts).toEqual([{ issue: 8 }]);
    expect(paused).toMatchObject({ status: "pending", run_id: r.runId });
    expect(killed).toEqual([]);
    expect(pauseRequested(r.factoryHome, { runId: r.runId })).toBe("operator pause");
    expect(readFileSync(math, "utf8")).toBe(before);
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.autoMergeDisabled).toEqual([]);
    clearPause(r.factoryHome, { runId: r.runId });
    const after: { issue: number; resume?: string }[] = [];
    const ctl2 = new AbortController();
    // An immediate done is requeued on the next poll and records the same resume before abort is observed.
    let releaseStarted: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const again = runQueue({
      factoryHome: r.factoryHome, github: r.github, repo: r.repo, slots: 1, pollMs: 10, signal: ctl2.signal,
      start: (req) => {
        after.push({ issue: req.issue, resume: req.resumeRunId });
        const done: RunResult = {
          run_id: req.resumeRunId ?? `20261029-140000-${req.issue.toString(16).padStart(6, "0")}`,
          repo: r.repo, task: `#${req.issue}`, type: "feature", lane: "standard", result: "done",
          risk: "low", merge_policy: "human_review", pr: r.result.pr, rounds: 0, minutes: 0, cost_usd: 0,
          reason: "", branch: null, worktree: null, run_dir: "",
        };
        return { done: startedGate.then(() => done), pid: 0, runId: () => done.run_id, kill: () => undefined, unref: () => undefined };
      },
    });
    const deadline2 = Date.now() + 20_000;
    while (Date.now() < deadline2) {
      const rows = loadQueueByKey(r.factoryHome, await repoQueueKey(r.repo))?.entries ?? [];
      const claimed = rows.some((e) => e.issue === 7 && e.status === "running" && e.run_id === r.runId);
      if (claimed && after.length === 1 && after[0]?.issue === 7 && after[0]?.resume === r.runId) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ctl2.abort();
    await again.catch(() => undefined);
    releaseStarted();
    expect(after).toEqual([{ issue: 7, resume: r.runId }]);
  }, 120_000);
});
