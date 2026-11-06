import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, type RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import { gc } from "../../src/commands/gc.js";
import { abandonRun } from "../../src/commands/abandon.js";
import { repoLockId } from "../../src/git.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { resumeFactory } from "../../src/pipeline/run.js";
import { createFixtureRepo } from "../helpers/repo.js";
import { main } from "../../src/cli.js";
import {
  type Fetch,
  flushNotifyOutbox,
  loadNotifyConfig,
  notifyChecks,
  notifyDoctorChecks,
  notifyRunFinished,
  notifyTest,
  requireNotifyTarget,
} from "../../src/notify.js";
import { listOutboxEntries, outboxCount } from "../../src/notify-outbox.js";

const REPO_URL = "https://hooks.example.test/repo-hook-secret";
const TARGET_URL = "https://hooks.example.test/mercator-hook-secret";
const KEY_R = "crsr_repo-sender-key-0123456789";
const KEY_T = "crsr_target-sender-key-0123456789";

/** Run id whose start time stays inside the 7-day doctor window. */
function recentRunId(at: Date, suffix: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}-${suffix}`;
}

const yaml = () => `targets:
  mercator:
    url: ${TARGET_URL}
    key: ${KEY_T}
  other:
    url: https://hooks.example.test/other-hook-secret
    key: crsr_other-sender-key-0123456789
repos:
  acme/widgets:
    url: ${REPO_URL}
    key: ${KEY_R}
`;

function home(text = yaml()): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-target-"));
  writeFileSync(join(dir, "notify.yaml"), text);
  chmodSync(join(dir, "notify.yaml"), 0o600);
  return dir;
}

function repoWithOrigin(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-target-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  return dir;
}

function result(repo: string, runDir: string, over: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "20261030-101010-abcdef", repo, task: "task.md", type: "feature", lane: "standard", result: "done", risk: "low",
    merge_policy: "auto", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "ok", branch: null, worktree: null, run_dir: runDir, ...over,
  };
}

function writeState(runDir: string, repo: string, over: Record<string, unknown> = {}): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      version: 1,
      run_id: "20261030-101010-abcdef",
      repo,
      task: { ref: "t", title: "t", text: "t", labels: [] },
      no_pr: true,
      step: "implement",
      result: "needs_human",
      reason: "wait",
      branch: "factory/t",
      worktree: null,
      base_sha: "abc",
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
      ...over,
    }),
  );
}

function spy(): { fetch: Fetch; calls: { url: string; body: Record<string, unknown>; auth: string }[] } {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, auth: init.headers.Authorization ?? "" });
    return { status: 200 };
  };
  return { fetch, calls };
}

describe("named notify targets", () => {
  it("parses notify.yaml without targets", () => {
    const cfg = loadNotifyConfig(home("repos:\n  acme/widgets:\n    url: https://hooks.example.test/h\n    key: k\n"))!;
    expect(cfg.targets).toEqual({});
    expect(cfg.repos["acme/widgets"]).toBeDefined();
  });

  it("posts a finished run to the stored target and keeps secrets out of state, events and the payload log", async () => {
    const factoryHome = home();
    const repo = repoWithOrigin();
    const runDir = join(factoryHome, "runs", "20261030-101010-abcdef");
    writeState(runDir, repo, { notify_target: "mercator", result: "done" });
    const events = new EventLog(runDir, "20261030-101010-abcdef", Date.now, []);
    const { fetch, calls } = spy();
    const out = await notifyRunFinished(result(repo, runDir), { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0] }, events, new Date("2026-10-30T00:20:41Z"));
    expect(out).toMatchObject({ status: "sent" });
    expect(calls[0]).toMatchObject({ url: TARGET_URL, auth: `Bearer ${KEY_T}` });
    expect(calls[0]!.body).toMatchObject({ target: "mercator", repo: "acme/widgets", event: "factory.run_finished" });
    const blob = readFileSync(join(runDir, "events.jsonl"), "utf8") + readFileSync(join(runDir, "state.json"), "utf8");
    expect(blob).toContain('"target":"mercator"');
    expect(blob).not.toContain("mercator-hook-secret");
    expect(blob).not.toContain(KEY_T);
    expect(blob).not.toContain(KEY_R);
    expect(blob).not.toContain("repo-hook-secret");
  });

  it("a run without a stored target posts to the repo hook and omits target", async () => {
    const factoryHome = home();
    const repo = repoWithOrigin();
    const runDir = mkdtempSync(join(tmpdir(), "factory-target-run-"));
    const { fetch, calls } = spy();
    await notifyRunFinished(result(repo, runDir), { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0] });
    expect(calls[0]!.url).toBe(REPO_URL);
    expect(calls[0]!.body.target).toBeUndefined();
  });

  it("a removed target falls back to the repo hook and logs the reason", async () => {
    const factoryHome = home("repos:\n  acme/widgets:\n    url: " + REPO_URL + "\n    key: " + KEY_R + "\n");
    const repo = repoWithOrigin();
    const runDir = join(factoryHome, "runs", "20261030-101010-abcdef");
    writeState(runDir, repo, { notify_target: "mercator" });
    const events = new EventLog(runDir, "20261030-101010-abcdef", Date.now, []);
    const { fetch, calls } = spy();
    await notifyRunFinished(result(repo, runDir), { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0] }, events);
    expect(calls[0]!.url).toBe(REPO_URL);
    expect(calls[0]!.body.target).toBeUndefined();
    const log = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(log).toContain("notify target mercator is not in notify.yaml; using the repo hook");
    expect(log).not.toContain("repo-hook-secret");
    expect(log).not.toContain(KEY_R);
  });

  it("unknown --notify fails before a run and never echoes a URL", async () => {
    const factoryHome = home();
    const repo = repoWithOrigin();
    const missing = await requireNotifyTarget(factoryHome, "no-such");
    expect(missing).toEqual({ ok: false, message: "unknown notify target no-such" });
    const leaked = await requireNotifyTarget(factoryHome, "https://hooks.example.test/secret-path");
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) {
      expect(leaked.message).not.toContain("hooks.example");
      expect(leaked.message).not.toContain("secret-path");
    }
    const err: string[] = [];
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = factoryHome;
    try {
      expect(await main(["run", "--repo", repo, "--text", "plan.md", "--notify", "no-such"], { out: () => undefined, err: (s) => void err.push(s) })).toBe(2);
      expect(await main(["resume", "20261030-101010-abcdef", "--notify", TARGET_URL], { out: () => undefined, err: (s) => void err.push(s) })).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
    const text = err.join("");
    expect(text).toContain("unknown notify target no-such");
    expect(text).not.toContain("mercator-hook-secret");
    expect(text).not.toContain(TARGET_URL);
    expect(text).not.toContain(KEY_T);
  });

  it("a failed delivery is queued with the target and flush posts to that target", async () => {
    const factoryHome = home();
    const repo = repoWithOrigin();
    const runDir = join(factoryHome, "runs", "20261030-101010-abcdef");
    writeState(runDir, repo, { notify_target: "mercator" });
    const fail: Fetch = async () => ({ status: 503 });
    await notifyRunFinished(result(repo, runDir), { factoryHome, fetch: fail, sleep: async () => undefined, backoffMs: [0] });
    expect(outboxCount(factoryHome)).toBe(1);
    const [entry] = listOutboxEntries(factoryHome);
    expect(entry).toMatchObject({ target: "mercator", kind: "failed" });
    expect(entry!.payload.target).toBe("mercator");
    expect(JSON.stringify(entry)).not.toContain("mercator-hook-secret");
    expect(JSON.stringify(entry)).not.toContain(KEY_T);
    const { fetch, calls } = spy();
    const rep = await flushNotifyOutbox(factoryHome, { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0] });
    expect(rep).toMatchObject({ sent: 1, remaining: 0 });
    expect(calls[0]!.url).toBe(TARGET_URL);
    expect(calls[0]!.body.target).toBe("mercator");
  });

  it("doctor lists target names and a failed target delivery stays failed after a repo send", async () => {
    const factoryHome = home();
    const checks = await notifyChecks(factoryHome);
    expect(checks[0]!.detail).toContain("targets mercator, other");
    expect(checks[0]!.detail).toContain("hooks for acme/widgets");
    expect(JSON.stringify(checks)).not.toContain("mercator-hook-secret");
    const repo = repoWithOrigin();
    const now = Date.now();
    const mk = (id: string) => {
      const runDir = join(factoryHome, "runs", id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "result.json"), JSON.stringify({ run_id: id, repo }));
      writeFileSync(join(runDir, "state.json"), JSON.stringify({ version: 1, run_id: id, repo, step: "finished", result: "done" }));
      return new EventLog(runDir, id, () => now, []);
    };
    mk(recentRunId(new Date(now - 120_000), "aaaaaa")).emit({ step: "run", event: "notify", data: { status: "failed", repo: "acme/widgets", target: "mercator" } });
    mk(recentRunId(new Date(now - 60_000), "bbbbbb")).emit({ step: "run", event: "notify", data: { status: "sent", repo: "acme/widgets" } });
    const doc = await notifyDoctorChecks(factoryHome, now);
    expect(doc.find((c) => c.name === "notify delivery")).toMatchObject({ status: "fail" });
  });

  it("notify test --target pings that target", async () => {
    const { fetch, calls } = spy();
    const r = await notifyTest("acme/widgets", { factoryHome: home(), fetch, sleep: async () => undefined, notifyTarget: "mercator" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("target mercator");
    expect(calls[0]!.url).toBe(TARGET_URL);
    expect(calls[0]!.body).toMatchObject({ event: "factory.notify_test", target: "mercator" });
    expect(r.message).not.toContain("mercator-hook-secret");
  });

  it("abandon and gc needs_input abandon notify the stored target", async () => {
    const factoryHome = home();
    const repo = repoWithOrigin();
    const runId = "20261030-101010-abcdef";
    const runDir = join(factoryHome, "runs", runId);
    writeState(runDir, repo, { notify_target: "mercator", result: "needs_input", updated_at: "2020-01-01T00:00:00.000Z" });
    const { fetch, calls } = spy();
    const abandoned = await abandonRun({ factoryHome, runId, reason: "abandoned with factory abandon", notifyFetch: fetch, notifyBackoffMs: [0], sleep: async () => undefined });
    expect(abandoned.notified).toBe(true);
    expect(calls[0]!.url).toBe(TARGET_URL);
    expect(calls[0]!.body).toMatchObject({ result: "abandoned", target: "mercator" });

    const runId2 = "20261030-101011-abcdef";
    writeState(join(factoryHome, "runs", runId2), repo, { run_id: runId2, notify_target: "mercator", result: "needs_input", updated_at: "2020-01-01T00:00:00.000Z" });
    const calls2: string[] = [];
    const fetch2: Fetch = async (url, init) => {
      calls2.push(url);
      expect(JSON.parse(init.body).target).toBe("mercator");
      return { status: 200 };
    };
    const report = await gc({
      factoryHome,
      github: new FakeGitHub(),
      evidence: false,
      retentionStages: false,
      writeLog: false,
      needsInputWorkingDays: 0,
      notifyFetch: fetch2,
      notifyBackoffMs: [0],
      notifySleep: async () => undefined,
    });
    expect(report.abandoned.map((a) => a.run_id)).toContain(runId2);
    expect(calls2).toEqual([TARGET_URL]);
  });

  it("resume of a stored target notifies that target", async () => {
    const factoryHome = home();
    const repo = createFixtureRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
    const runId = "20261030-101010-abcdef";
    const runDir = join(factoryHome, "runs", runId);
    writeState(runDir, repo, { notify_target: "mercator", worktree: join(runDir, "wt"), base_sha: "deadbeef" });
    const release = acquireRepoLock(factoryHome, await repoLockId(repo), "20261029-000000-aaaaaa");
    expect(release).toBeTypeOf("function");
    try {
      const { fetch, calls } = spy();
      const locked = await resumeFactory(runId, {}, {
        factoryHome,
        notifyFetch: fetch,
        notifyBackoffMs: [0],
        sleep: async () => undefined,
        runner: {} as never,
        github: new FakeGitHub(),
        profile: {} as never,
      });
      expect(locked.result).toBe("locked");
      expect(calls[0]!.url).toBe(TARGET_URL);
      expect(calls[0]!.body.target).toBe("mercator");
    } finally {
      release?.();
    }
  });
});
