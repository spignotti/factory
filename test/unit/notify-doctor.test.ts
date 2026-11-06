import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/events.js";
import { enqueueOutbox, withEventId } from "../../src/notify-outbox.js";
import { notifyDoctorChecks, notifyRunFinished, requireNotifyHook } from "../../src/notify.js";
import { outboxCount } from "../../src/notify-outbox.js";
import { main } from "../../src/cli.js";

const URL_ = "https://hooks.example.test/x";

/** Run id whose start time stays inside the 7-day doctor window. */
function recentRunId(at: Date, suffix: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}-${suffix}`;
}

function repoWithOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-doc-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  return dir;
}

describe("notify doctor and run guard", () => {
  it("notifyDoctorChecks fails on a non-empty outbox and recent skipped notify", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-doc-home-"));
    const repo = repoWithOrigin();
    const now = new Date();
    const runId = recentRunId(new Date(now.getTime() - 60 * 60 * 1000), "abcabc");
    const runDir = join(factoryHome, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const events = new EventLog(runDir, runId, () => now.getTime(), []);
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        version: 1,
        run_id: runId,
        repo,
        task: { ref: "t", labels: [] },
        no_pr: true,
        step: "finished",
        result: "done",
        reason: "",
        branch: null,
        worktree: null,
        base_sha: null,
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
    events.emit({ step: "run", event: "notify", data: { status: "skipped", repo: "acme/widgets" } });
    enqueueOutbox(factoryHome, {
      event_id: "abc",
      enqueued_at: new Date().toISOString(),
      repo: "acme/widgets",
      kind: "failed",
      payload: withEventId(
        { event: "factory.run_finished", run_id: runId, repo: "acme/widgets", result: "done", reason: "ok", pr: null, finished_at: now.toISOString() },
        "acme/widgets",
      ),
    });
    const checks = await notifyDoctorChecks(factoryHome, now.getTime());
    expect(checks.some((c) => c.name === "notify outbox" && c.status === "fail")).toBe(true);
    expect(checks.some((c) => c.name === "notify delivery" && c.status === "fail")).toBe(true);
    expect(checks.some((c) => c.name === "notify coverage" && c.status === "fail")).toBe(true);
  });

  it("factory run exits 2 without a notify hook unless --no-notify", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-doc-home-"));
    const repo = repoWithOrigin();
    expect((await requireNotifyHook(factoryHome, repo)).ok).toBe(false);
    const err: string[] = [];
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = factoryHome;
    try {
      expect(await main(["run", "--repo", repo, "--text", "plan.md"], { out: () => undefined, err: (s) => void err.push(s) })).toBe(2);
      expect(err.join("")).toMatch(/notify hook|--no-notify/);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });

  it("requireNotifyHook passes when the repo hook exists", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-doc-home-"));
    const repo = repoWithOrigin();
    writeFileSync(join(factoryHome, "notify.yaml"), `repos:\n  acme/widgets:\n    url: ${URL_}\n    key: k\n`, { mode: 0o600 });
    expect((await requireNotifyHook(factoryHome, repo)).ok).toBe(true);
  });

  it("notify delivery ignores skips resolved by a later successful delivery to the same repo", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-doc-home-"));
    writeFileSync(join(factoryHome, "notify.yaml"), `repos:\n  acme/widgets:\n    url: ${URL_}\n    key: k\n`, { mode: 0o600 });
    const repo = repoWithOrigin();
    const mkRun = (id: string, ms: number) => {
      const runDir = join(factoryHome, "runs", id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "result.json"), JSON.stringify({ run_id: id, repo }));
      return new EventLog(runDir, id, () => ms, []);
    };
    const now = Date.now();
    mkRun(recentRunId(new Date(now - 3_600_000), "aaaaaa"), now - 3_600_000).emit({ step: "run", event: "notify", data: { status: "skipped", repo: "acme/widgets" } });
    mkRun(recentRunId(new Date(now - 60_000), "bbbbbb"), now - 60_000).emit({ step: "run", event: "notify", data: { status: "sent", repo: "acme/widgets" } });
    let checks = await notifyDoctorChecks(factoryHome, now);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    mkRun(recentRunId(new Date(now - 1_000), "cccccc"), now - 1_000).emit({ step: "run", event: "notify", data: { status: "failed", repo: "acme/widgets" } });
    checks = await notifyDoctorChecks(factoryHome, now);
    expect(checks.find((c) => c.name === "notify delivery")).toMatchObject({ status: "fail" });
  });

  it("--no-notify (disabled) sends nothing, writes no outbox entry and logs disabled", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-doc-home-"));
    const repo = repoWithOrigin();
    const runDir = mkdtempSync(join(tmpdir(), "factory-doc-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    let calls = 0;
    const out = await notifyRunFinished(
      { run_id: "20261030-101010-abcdef", repo, task: "t", type: "feature", lane: "standard", result: "done", risk: "low", merge_policy: "auto", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "ok", branch: null, worktree: null, run_dir: runDir },
      { factoryHome, disabled: true, fetch: async () => (calls++, { status: 200 }) },
      events,
    );
    expect(out).toBeUndefined();
    expect(calls).toBe(0);
    expect(outboxCount(factoryHome)).toBe(0);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"status":"disabled"');
  });
});
