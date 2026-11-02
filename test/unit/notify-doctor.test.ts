import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/events.js";
import { enqueueOutbox, withEventId } from "../../src/notify-outbox.js";
import { notifyDoctorChecks, requireNotifyHook } from "../../src/notify.js";
import { main } from "../../src/cli.js";

const URL_ = "https://hooks.example.test/x";

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
    const runDir = join(factoryHome, "runs", "20261030-140000-abcabc");
    mkdirSync(runDir, { recursive: true });
    const events = new EventLog(runDir, "20261030-140000-abcabc", () => Date.now(), []);
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({
        version: 1,
        run_id: "20261030-140000-abcabc",
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
        { event: "factory.run_finished", run_id: "20261030-140000-abcabc", repo: "acme/widgets", result: "done", reason: "ok", pr: null, finished_at: new Date().toISOString() },
        "acme/widgets",
      ),
    });
    const checks = await notifyDoctorChecks(factoryHome);
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
});
