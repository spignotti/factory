import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { statusReport } from "../../src/commands/status.js";
import { FakeGitHub } from "../../src/gh.js";
import { EventLog } from "../../src/events.js";

describe("status extended sections", () => {
  it("reports orphaned runs from dead lock holders", async () => {
    const home = join(tmpdir(), `status-orphan-${Date.now()}`);
    const runId = "20261030-150000-abc123";
    const runDir = join(home, "runs", runId);
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "repo.lock"), "999999999\n20261030-150000-abc123");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        version: 1,
        run_id: runId,
        repo: "/tmp/r",
        task: { ref: "plan.md", labels: [] },
        no_pr: true,
        step: "implement",
        result: null,
        reason: "",
        branch: "b",
        worktree: "/wt",
        base_sha: "sha",
        packages: {},
        failures: {},
        handoffs: [],
        rounds: 0,
        findings: [],
        gate_count: 0,
        pr: null,
        pr_draft: null,
        lane: "standard",
        lane_escalation: [],
        updated_at: new Date().toISOString(),
      }),
    );
    const s = await statusReport({ factoryHome: home, github: new FakeGitHub(), now: () => Date.now() });
    expect(s.orphaned.map((r) => r.run_id)).toEqual([runId]);
    expect(s.interrupted).toEqual([]);
  });

  it("a lock holder with an earlier queued event (path overlap) is running, not queued", async () => {
    const home = join(tmpdir(), `status-holder-${Date.now()}`);
    const runId = "20261030-150000-abc123";
    const runDir = join(home, "runs", runId);
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "repo.lock"), `${process.pid}\n${runId}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({
        version: 1,
        run_id: runId,
        repo: "/tmp/r",
        task: { ref: "plan.md", labels: [] },
        no_pr: true,
        step: "implement",
        result: null,
        reason: "",
        branch: "b",
        worktree: "/wt",
        base_sha: "sha",
        packages: {},
        failures: {},
        handoffs: [],
        rounds: 0,
        findings: [],
        gate_count: 0,
        pr: null,
        pr_draft: null,
        lane: "standard",
        lane_escalation: [],
        updated_at: new Date().toISOString(),
      }));
    new EventLog(runDir, runId, () => Date.now(), []).emit({ step: "intake", event: "queued", data: { repo: "r", overlap: ["a"], waiter_pid: process.pid } });
    const s = await statusReport({ factoryHome: home, github: new FakeGitHub(), now: () => Date.now() });
    expect(s.queued).toEqual([]);
    expect(s.running.map((r) => r.run_id)).toEqual([runId]);
    expect(s.running[0]!.check).toBeNull();
  });

  it("shows the check named by the latest running heartbeat", async () => {
    const home = join(tmpdir(), `status-check-${Date.now()}`);
    const runId = "20261030-150000-abc123";
    const runDir = join(home, "runs", runId);
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "repo.lock"), `${process.pid}\n${runId}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({
      version: 1, run_id: runId, repo: "/tmp/r", task: { ref: "plan.md", labels: [] }, no_pr: true,
      step: "finalize", result: null, reason: "", branch: "b", worktree: "/wt", base_sha: "sha",
      packages: {}, failures: {}, handoffs: [], rounds: 0, findings: [], gate_count: 1,
      pr: null, pr_draft: null, lane: "standard", lane_escalation: [], updated_at: new Date().toISOString(),
    }));
    const log = new EventLog(runDir, runId, () => Date.now(), []);
    log.emit({ step: "finalize", event: "progress", data: { check: "red_green", phase: "running", where: "base" } });
    log.emit({ step: "finalize", event: "heartbeat", data: { check: "red_green", phase: "running", where: "base" } });
    const s = await statusReport({ factoryHome: home, github: new FakeGitHub(), now: () => Date.now() });
    expect(s.running[0]).toMatchObject({ step: "finalize", check: "red_green" });
  });
});
