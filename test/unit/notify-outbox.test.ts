import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, type RunResult } from "../../src/events.js";
import { Interrupted } from "../../src/interrupt.js";
import { repoLockId } from "../../src/git.js";
import { flushNotifyOutbox, notifyRunFinished, START_FLUSH, type Fetch } from "../../src/notify.js";
import { listOutboxEntries, notifyAbortSignal, notifyEventId, NOTIFY_SIGTERM_GRACE_MS, outboxCount } from "../../src/notify-outbox.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { runFactory } from "../../src/pipeline/run.js";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { FakeGitHub } from "../../src/gh.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { createFixtureRepo, FIXTURES } from "../helpers/repo.js";

const URL_ = "https://hooks.example.test/automations/webhook/abc-123-secret-id";
const KEY = "crsr_super-secret-sender-key-0123456789";

function home(yaml?: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-outbox-"));
  if (yaml !== undefined) {
    writeFileSync(join(dir, "notify.yaml"), yaml);
    chmodSync(join(dir, "notify.yaml"), mode);
  }
  return dir;
}

function repoWithOrigin(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-outbox-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
  return dir;
}

const yamlFor = (repo = "acme/widgets") => `repos:\n  ${repo}:\n    url: ${URL_}\n    key: ${KEY}\n`;

function result(repo: string, over: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "20261030-101010-abcdef", repo, task: "plan.md", type: "feature", lane: "standard", result: "done", risk: "low",
    merge_policy: "auto", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "ok", branch: "factory/x", worktree: "/wt", run_dir: "/rd", ...over,
  };
}

describe("notify outbox", () => {
  it("event_id is stable for the same run finish", () => {
    const a = notifyEventId("acme/widgets", "factory.run_finished", "20261030-101010-abcdef", "2026-10-30T00:20:41.000Z");
    const b = notifyEventId("acme/widgets", "factory.run_finished", "20261030-101010-abcdef", "2026-10-30T00:20:41.000Z");
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
  });

  it("failed delivery enqueues payload without URL or key; flush sends and removes", async () => {
    const factoryHome = home(yamlFor());
    const runDir = mkdtempSync(join(tmpdir(), "factory-outbox-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    const calls: unknown[] = [];
    const fetch: Fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return { status: 500 };
    };
    await notifyRunFinished(result(repo), { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0, 0, 0] }, events);
    expect(outboxCount(factoryHome)).toBe(1);
    const [entry] = listOutboxEntries(factoryHome);
    expect(entry!.payload.event_id).toHaveLength(24);
    expect(JSON.stringify(entry)).not.toContain(KEY);
    expect(JSON.stringify(entry)).not.toContain("abc-123-secret-id");
    expect(calls).toHaveLength(4);

    const sent: unknown[] = [];
    const okFetch: Fetch = async (_url, init) => (sent.push(JSON.parse(init.body)), { status: 200 });
    const rep = await flushNotifyOutbox(factoryHome, { factoryHome, fetch: okFetch, sleep: async () => undefined, backoffMs: [0] });
    expect(rep).toMatchObject({ sent: 1, remaining: 0 });
    expect(sent[0]).toMatchObject({ event_id: entry!.payload.event_id });
    expect(outboxCount(factoryHome)).toBe(0);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"status":"failed"');
  });

  it("skipped and config error enqueue outbox entries", async () => {
    const factoryHome = home(yamlFor("acme/other"));
    const runDir = mkdtempSync(join(tmpdir(), "factory-outbox-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    await notifyRunFinished(result(repo), { factoryHome, fetch: async () => ({ status: 200 }) }, events);
    expect(listOutboxEntries(factoryHome)[0]).toMatchObject({ kind: "skipped" });

    const bad = home("repos: [\n");
    await notifyRunFinished(result(repo), { factoryHome: bad, fetch: async () => ({ status: 200 }) });
    expect(listOutboxEntries(bad)[0]).toMatchObject({ kind: "error" });
  });

  it("notify retries after run SIGTERM for the grace window", async () => {
    const factoryHome = home(yamlFor());
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    const run = new AbortController();
    const attempts: number[] = [];
    let n = 0;
    const fetch: Fetch = async () => {
      attempts.push(++n);
      if (n === 1) {
        run.abort(new Interrupted("SIGTERM"));
        return { status: 500 };
      }
      return { status: 200 };
    };
    const out = await notifyRunFinished(result(repo), {
      factoryHome,
      fetch,
      sleep: async () => undefined,
      backoffMs: [0, 0, 0],
      signal: run.signal,
    });
    expect(out).toMatchObject({ status: "sent", attempts: 2 });
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });

  it("notifyAbortSignal aborts after grace when the run signal already aborted", async () => {
    const run = new AbortController();
    run.abort(new Interrupted("SIGTERM"));
    const sig = notifyAbortSignal(run.signal, 30);
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(sig.aborted).toBe(true);
  });

  it("write-ahead: the entry exists while the POST is in flight and is removed once sent", async () => {
    const factoryHome = home(yamlFor());
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    let during = -1;
    const fetch: Fetch = async () => {
      during = outboxCount(factoryHome);
      return { status: 200 };
    };
    const out = await notifyRunFinished(result(repo), { factoryHome, fetch, sleep: async () => undefined, backoffMs: [0] });
    expect(out).toMatchObject({ status: "sent" });
    expect(during).toBe(1);
    expect(outboxCount(factoryHome)).toBe(0);
  });

  it("redacts run secrets from the reason before it is persisted", async () => {
    const factoryHome = home(yamlFor());
    const runDir = mkdtempSync(join(tmpdir(), "factory-outbox-run-"));
    const events = new EventLog(runDir, "r1", Date.now, ["repo-secret-value-123456"]);
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    await notifyRunFinished(result(repo, { reason: "gate failed: token repo-secret-value-123456" }), { factoryHome, fetch: async () => ({ status: 500 }), sleep: async () => undefined, backoffMs: [0] }, events);
    const [entry] = listOutboxEntries(factoryHome);
    expect(entry!.payload.reason).toBe("gate failed: token [redacted]");
  });

  it("start flush is bounded: one attempt, later entries of a down repo wait, budget stops it", async () => {
    const factoryHome = home(yamlFor());
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    for (const id of ["20261030-101010-aaaaaa", "20261030-101010-bbbbbb", "20261030-101010-cccccc"]) {
      await notifyRunFinished(result(repo, { run_id: id }), { factoryHome, fetch: async () => ({ status: 503 }), sleep: async () => undefined, backoffMs: [0] });
    }
    expect(outboxCount(factoryHome)).toBe(3);
    let calls = 0;
    const down: Fetch = async () => (calls++, { status: 503 });
    const rep = await flushNotifyOutbox(factoryHome, { factoryHome, fetch: down, sleep: async () => undefined, backoffMs: [0] }, START_FLUSH);
    expect(calls).toBe(1);
    expect(rep).toMatchObject({ sent: 0, failed: 1, skipped: 2, remaining: 3 });

    let ticks = 0;
    // start, first entry within budget, then the budget is spent
    const clock = () => (ticks++ < 2 ? 0 : 100);
    const rep2 = await flushNotifyOutbox(factoryHome, { factoryHome, fetch: async () => ({ status: 200 }) }, { attempts: 1, budgetMs: 10, now: clock });
    expect(rep2.sent).toBe(1);
    expect(rep2.remaining).toBe(2);
  });

  it("NOTIFY_SIGTERM_GRACE_MS is 45 seconds", () => {
    expect(NOTIFY_SIGTERM_GRACE_MS).toBe(45_000);
  });

  it("external repo lock blocks runFactory with locked", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 1 }));
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
    const home = mkdtempSync(join(tmpdir(), "factory-lock-block-"));
    const id = await repoLockId(repo);
    const release = acquireRepoLock(home, id, "holder-run")!;
    expect(release).toBeTypeOf("function");
    try {
      const result = await runFactory(
        { repo, textFile: join(FIXTURES, "tasks", "multiply.md") },
        { runner: new FakeRunner([]), github: new FakeGitHub(), profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: home },
      );
      expect(result.result).toBe("locked");
    } finally {
      release();
    }
  });
});
