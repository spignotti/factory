import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { autoMergeAlreadyEnabled, FakeGitHub } from "../../src/gh.js";
import { autoMergeCompletes, mayEnableAutoMerge } from "../../src/pipeline/merge-ready.js";
import { enableReadyMerges } from "../../src/queue/worker.js";

describe("merge readiness", () => {
  it("V03: auto-merge completes only when required done succeeded on this head", () => {
    expect(autoMergeCompletes({ enabled: true, requiredChecks: ["done"], checks: [{ name: "done", conclusion: "success" }] })).toBe(true);
    expect(autoMergeCompletes({ enabled: true, requiredChecks: ["done"], checks: [{ name: "done", conclusion: "failure" }] })).toBe(false);
    expect(autoMergeCompletes({ enabled: true, requiredChecks: ["done"], checks: [{ name: "done", conclusion: "skipped" }] })).toBe(false);
    expect(autoMergeCompletes({ enabled: true, requiredChecks: ["done"], checks: [] })).toBe(false);
    expect(autoMergeCompletes({ enabled: false, requiredChecks: ["done"], checks: [{ name: "done", conclusion: "success" }] })).toBe(false);
    // The live factory ruleset requires `check`, not `done`. That path does not count as enforced.
    expect(autoMergeCompletes({ enabled: true, requiredChecks: ["check"], checks: [{ name: "check", conclusion: "success" }] })).toBe(false);
    expect(mayEnableAutoMerge({ policy: "auto", approvedSha: "aaa", headSha: "bbb", ci: "green", draft: false, state: "open" })).toBe(false);
    expect(mayEnableAutoMerge({ policy: "auto", approvedSha: "aaa", headSha: "aaa", ci: "pending", draft: false, state: "open" })).toBe(false);
    expect(mayEnableAutoMerge({ policy: "auto", approvedSha: "aaa", headSha: "aaa", ci: "green", draft: true, state: "open" })).toBe(false);
    expect(mayEnableAutoMerge({ policy: "human_review", approvedSha: "aaa", headSha: "aaa", ci: "green", draft: false, state: "open" })).toBe(false);
    expect(mayEnableAutoMerge({ policy: "auto", approvedSha: "aaa", headSha: "aaa", ci: "green", draft: false, state: "open" })).toBe(true);
  });

  it("a restarted enable that GitHub already accepted is not a second merge", () => {
    expect(autoMergeAlreadyEnabled("GraphQL: Auto merge is already enabled (enablePullRequestAutoMerge)")).toBe(true);
    expect(autoMergeAlreadyEnabled("pull request is not mergeable")).toBe(false);
  });

  it("V02/V03: the runner enables auto-merge once for the approved green SHA and not for a newer head", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-merge-"));
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const runId = "20261112-120000-abcdef";
    const pr = "https://github.test/pull/7";
    const branch = "factory/7-goal";
    const dir = join(home, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, run_id: runId, repo, task: { ref: "#7", title: "t", text: "", labels: [] }, no_pr: false,
      step: "finished", result: "done", reason: "", branch, worktree: null, base_sha: null,
      packages: {}, failures: {}, handoffs: [], rounds: 1, findings: [], gate_count: 1,
      pr, pr_draft: false, approved_sha: "aaa", ci_wait: "pending", updated_at: "2026-11-12T00:00:00.000Z",
    }));
    writeFileSync(join(dir, "result.json"), JSON.stringify({
      run_id: runId, repo, task: "#7", type: "feature", lane: "standard", result: "done", risk: "low",
      merge_policy: "auto", pr, rounds: 1, minutes: 1, cost_usd: 0, reason: "", branch, worktree: null, run_dir: dir,
    }));
    const github = new FakeGitHub();
    github.prs.push({ repoDir: repo, head: branch, base: "main", title: "t", body: "", draft: false, url: pr });
    github.remoteShas.set(branch, "bbb");
    github.prStates.set(pr, { state: "open", draft: false, ci: "green" });
    const enabled = new Set<string>();
    const io = { out: () => undefined, err: () => undefined };
    expect(await enableReadyMerges(github, repo, home, enabled, io, 1_000)).toBe(false);
    expect(github.autoMerged).toEqual([]);

    github.remoteShas.set(branch, "aaa");
    github.prStates.set(pr, { state: "open", draft: false, ci: "pending" });
    expect(await enableReadyMerges(github, repo, home, enabled, io, 1_000)).toBe(true);
    expect(github.autoMerged).toEqual([]);

    github.prStates.set(pr, { state: "open", draft: false, ci: "green" });
    expect(await enableReadyMerges(github, repo, home, enabled, io, 1_000)).toBe(false);
    expect(github.autoMerged).toEqual([pr]);
    expect(await enableReadyMerges(github, repo, home, enabled, io, 1_000)).toBe(false);
    expect(github.autoMerged).toEqual([pr]);

    const report = await statusReport({ factoryHome: home, github, since: "24h" });
    expect(report.running).toEqual([]);
    expect(report.prs).toEqual([expect.objectContaining({ pr, merge_policy: "auto", state: "open" })]);
    github.prStates.set(pr, { state: "open", draft: false, ci: "pending" });
    const waiting = await statusReport({ factoryHome: home, github, since: "24h" });
    expect(waiting.since?.blocked.map((row) => row.blockers)).toEqual([["CI pending"]]);
    expect(renderStatus(waiting)).toContain("CI pending");
    expect(waiting.running).toEqual([]);

    github.prStates.set(pr, { state: "closed", draft: false, ci: "green" });
    const closed = renderStatus(await statusReport({ factoryHome: home, github, since: "24h" }));
    expect(closed).toContain("closed");
    expect(closed).not.toContain("merged https://github.test/pull/7");
    github.prStates.set(pr, { state: "merged", draft: false, ci: "green" });
    const merged = renderStatus(await statusReport({ factoryHome: home, github, since: "24h" }));
    expect(merged).toContain("merged https://github.test/pull/7");
  });
});
