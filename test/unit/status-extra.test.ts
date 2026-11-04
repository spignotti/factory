import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus, statusReport } from "../../src/commands/status.js";
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
    expect(s.running[0]).toMatchObject({ step: "finalize", check: "red_green", retry: null });
  });

  it("shows an in-flight stream retry, and drops it once the call finishes", async () => {
    const home = join(tmpdir(), `status-retry-${Date.now()}`);
    const runId = "20261104-150805-15d527";
    const runDir = join(home, "runs", runId);
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "repo.lock"), `${process.pid}\n${runId}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), JSON.stringify({
      version: 1, run_id: runId, repo: "/tmp/pm", task: { ref: "issue #40", labels: [] }, no_pr: true,
      step: "implement", result: null, reason: "", branch: "b", worktree: "/wt", base_sha: "sha",
      packages: { P1: "done", P2: "done", P3: "done", P4: "done" }, failures: {}, handoffs: [], rounds: 0,
      findings: [], gate_count: 0, pr: null, pr_draft: null, lane: "standard", lane_escalation: [],
      updated_at: new Date().toISOString(),
    }));
    const log = new EventLog(runDir, runId, () => Date.now(), []);
    log.emit({ step: "implement", event: "step_started", data: { package: "P5" } });
    log.emit({ step: "implement", event: "agent_error", role: "implement", model: "opencode-go/deepseek-v4.1-flash", data: { class: "stream" } });
    log.emit({ step: "implement", event: "step_retry", role: "implement", model: "opencode-go/deepseek-v4.1-flash", data: { class: "stream", attempt: 1, max: 2, delay_ms: 2000, package: "P5" } });
    log.emit({ step: "implement", event: "heartbeat", role: "implement" });
    const s = await statusReport({ factoryHome: home, github: new FakeGitHub(), now: () => Date.now() });
    expect(s.running[0]?.retry).toEqual({ class: "stream", attempt: 1, max: 2, package: "P5" });
    expect(renderStatus(s)).toContain("20261104-150805-15d527 issue #40 — implement [stream retry 1/2 P5], standard");
    log.emit({ step: "implement", event: "agent_finished", role: "implement", model: "opencode-go/deepseek-v4.1-flash" });
    const after = await statusReport({ factoryHome: home, github: new FakeGitHub(), now: () => Date.now() });
    expect(after.running[0]?.retry).toBeNull();
  });
});
