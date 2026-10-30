import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, type RunResult } from "../../src/events.js";
import { type Fetch, hookKey, loadNotifyConfig, NotifyConfigError, notifyChecks, notifyRunFinished, notifyTest, ownerRepoOf, sendNotification } from "../../src/notify.js";
import { main } from "../../src/cli.js";

const URL_ = "https://hooks.example.test/automations/webhook/abc-123-secret-id";
const KEY = "crsr_super-secret-sender-key-0123456789";

function home(yaml?: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-notify-"));
  if (yaml !== undefined) {
    writeFileSync(join(dir, "notify.yaml"), yaml);
    chmodSync(join(dir, "notify.yaml"), mode);
  }
  return dir;
}

function repoWithOrigin(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-notify-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
  return dir;
}

const yamlFor = (repo = "acme/widgets", extra = "") => `repos:\n  ${repo}:\n    url: ${URL_}\n    key: ${KEY}\n${extra}`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(statuses: (number | Error)[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const s = statuses.shift() ?? 200;
    if (s instanceof Error) throw s;
    return { status: s };
  };
  return { fetch, calls };
}

const noSleep = async () => undefined;

function result(repo: string, over: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "20261030-101010-abcdef", repo, task: "task.md", type: "feature", lane: "standard", result: "needs_human", risk: null, merge_policy: null,
    pr: null, rounds: 0, minutes: 3, cost_usd: 0, reason: "watchdog: no event for 1491s", branch: null, worktree: null, run_dir: "/tmp/x", ...over,
  };
}

describe("notify.yaml", () => {
  it("is optional; a 0600 file maps owner/name to a hook with Authorization: Bearer defaults", () => {
    expect(loadNotifyConfig(home())).toBeUndefined();
    const cfg = loadNotifyConfig(home(yamlFor()))!;
    expect(cfg.repos["acme/widgets"]).toMatchObject({ url: URL_, header: "Authorization", scheme: "Bearer" });
    expect(cfg).toMatchObject({ attempts: 4, timeout_s: 10 });
  });

  it("refuses a group/world-readable file, and errors never echo the URL or key", () => {
    expect(() => loadNotifyConfig(home(yamlFor(), 0o644))).toThrow(/chmod 600/);
    const bad = [
      `repos:\n  acme/widgets:\n    url: http://plain.example.test/${KEY}\n    key: ${KEY}\n`,
      `repos:\n  acme/widgets:\n    url: ${URL_}\n`,
      `repos:\n  acme/widgets:\n    url: ${URL_}\n    key: ${KEY}\n    key_file: /x\n`,
      `repos:\n  not-a-repo:\n    url: ${URL_}\n    key: ${KEY}\n`,
      `repos:\n  acme/widgets:\n    url: ${URL_}\n    key: "${KEY}\n   : [\n`,
    ];
    for (const y of bad) {
      let msg = "";
      try {
        loadNotifyConfig(home(y));
      } catch (e) {
        expect(e).toBeInstanceOf(NotifyConfigError);
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(KEY);
      expect(msg).not.toContain("abc-123-secret-id");
    }
  });

  it("key_file: read and trimmed; must exist and be 0600", () => {
    const dir = home();
    const file = join(dir, "iris.key");
    writeFileSync(file, `${KEY}\n`);
    chmodSync(file, 0o600);
    expect(hookKey({ url: URL_, key_file: file, header: "Authorization", scheme: "Bearer" })).toBe(KEY);
    chmodSync(file, 0o644);
    expect(() => hookKey({ url: URL_, key_file: file, header: "Authorization", scheme: "Bearer" })).toThrow(/chmod 600/);
    expect(() => hookKey({ url: URL_, key_file: join(dir, "missing"), header: "Authorization", scheme: "Bearer" })).toThrow(/does not exist/);
  });

  it("owner/name from canonical repo ids; local paths have none", () => {
    expect(ownerRepoOf("github.com/acme/widgets")).toBe("acme/widgets");
    expect(ownerRepoOf("path/tmp/x/origin")).toBeUndefined();
    expect(ownerRepoOf("local/tmp/repo")).toBeUndefined();
  });
});

describe("sendNotification", () => {
  const hook = { url: URL_, key: KEY, header: "Authorization", scheme: "Bearer" };
  const payload = { event: "factory.run_finished" as const, run_id: "r", repo: "acme/widgets", result: "done", reason: "ok", pr: null, finished_at: "2026-10-30T10:00:00.000Z" };

  it("POSTs JSON with the key in the configured header", async () => {
    const { fetch, calls } = fakeFetch([200]);
    expect(await sendNotification(hook, KEY, payload, { fetch, sleep: noSleep })).toEqual({ status: "sent", attempts: 1, http_status: 200 });
    expect(calls[0]!.headers).toMatchObject({ "content-type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(calls[0]!.body).toEqual(payload);
    const custom = fakeFetch([204]);
    await sendNotification({ ...hook, header: "X-Automation-Key", scheme: "" }, KEY, payload, { fetch: custom.fetch, sleep: noSleep });
    expect(custom.calls[0]!.headers["X-Automation-Key"]).toBe(KEY);
  });

  it("retries network errors, 429 and 5xx with backoff; stops at 4xx; never throws", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const flaky = fakeFetch([new Error(`connect ECONNREFUSED ${URL_}`), 503, 429, 200]);
    expect(await sendNotification(hook, KEY, payload, { fetch: flaky.fetch, sleep, attempts: 4, backoffMs: [1, 2] })).toMatchObject({ status: "sent", attempts: 4 });
    expect(slept).toEqual([1, 2, 2]);
    const denied = fakeFetch([401, 200]);
    expect(await sendNotification(hook, KEY, payload, { fetch: denied.fetch, sleep: noSleep })).toMatchObject({ status: "failed", attempts: 1, http_status: 401 });
    const down = fakeFetch([new Error(`boom ${URL_} ${KEY}`), new Error("x"), new Error(`boom ${KEY}`)]);
    const out = await sendNotification(hook, KEY, payload, { fetch: down.fetch, sleep: noSleep, attempts: 3 });
    expect(out).toMatchObject({ status: "failed", attempts: 3, http_status: null });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("an aborted signal stops further attempts", async () => {
    const ctl = new AbortController();
    const { fetch, calls } = fakeFetch([500, 500, 500]);
    const p = sendNotification(hook, KEY, payload, { fetch: async (u, i) => (ctl.abort(), fetch(u, i)), sleep: noSleep, signal: ctl.signal });
    expect((await p).attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("notifyRunFinished", () => {
  it("sends the minimal payload for the repo's hook and logs a notify event without URL or key", async () => {
    const factoryHome = home(yamlFor());
    const runDir = mkdtempSync(join(tmpdir(), "factory-notify-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    const repo = repoWithOrigin("git@github.com:acme/widgets.git");
    const { fetch, calls } = fakeFetch([200]);
    const out = await notifyRunFinished(result(repo, { pr: "https://github.com/acme/widgets/pull/8" }), { factoryHome, fetch, sleep: noSleep }, events, new Date("2026-10-30T00:20:41Z"));
    expect(out).toMatchObject({ status: "sent" });
    expect(calls[0]!.body).toEqual({
      event: "factory.run_finished", run_id: "20261030-101010-abcdef", repo: "acme/widgets", result: "needs_human",
      reason: "watchdog: no event for 1491s", pr: "https://github.com/acme/widgets/pull/8", finished_at: "2026-10-30T00:20:41.000Z",
    });
    const log = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(log).toContain('"event":"notify"');
    expect(log).toContain('"status":"sent"');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain("abc-123-secret-id");
  });

  it("no notify.yaml: nothing sent, nothing logged; no hook for the repo: skipped; a broken config never throws", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "factory-notify-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    const { fetch, calls } = fakeFetch([]);
    expect(await notifyRunFinished(result(repo), { factoryHome: home(), fetch }, events)).toBeUndefined();
    expect(await notifyRunFinished(result(repo), { factoryHome: home(yamlFor("acme/other")), fetch }, events)).toBeUndefined();
    expect(await notifyRunFinished(result(repo), { factoryHome: home(yamlFor(), 0o644), fetch }, events)).toBeUndefined();
    expect(await notifyRunFinished(result(repo), { factoryHome: home("repos: [\n"), fetch }, events)).toBeUndefined();
    expect(calls).toEqual([]);
    const log = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(log).toContain('"status":"skipped"');
    expect(log).toContain('"status":"error"');
    expect(log).not.toContain(KEY);
  });

  it("a failed delivery is logged as failed and returned, not thrown", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "factory-notify-run-"));
    const events = new EventLog(runDir, "r1", Date.now, []);
    const repo = repoWithOrigin("https://github.com/acme/widgets.git");
    const { fetch } = fakeFetch([500, 500, 500, 500]);
    expect(await notifyRunFinished(result(repo), { factoryHome: home(yamlFor()), fetch, sleep: noSleep }, events)).toMatchObject({ status: "failed", attempts: 4 });
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"status":"failed"');
  });
});

describe("notify test and doctor", () => {
  it("notifyTest sends a test ping and reports without the URL", async () => {
    const { fetch, calls } = fakeFetch([200]);
    const r = await notifyTest("acme/widgets", { factoryHome: home(yamlFor()), fetch, sleep: noSleep }, new Date("2026-10-30T10:00:00Z"));
    expect(r).toEqual({ ok: true, message: "test ping for acme/widgets sent (HTTP 200, 1 attempt)" });
    expect(calls[0]!.body).toMatchObject({ event: "factory.notify_test", repo: "acme/widgets", result: "test", run_id: null });
    const missing = await notifyTest("acme/nope", { factoryHome: home(yamlFor()), fetch });
    expect(missing.ok).toBe(false);
    const failed = await notifyTest("acme/widgets", { factoryHome: home(yamlFor()), fetch: fakeFetch([403]).fetch, sleep: noSleep });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.message).toContain("HTTP 403");
    expect(failed.message).not.toContain("abc-123-secret-id");
  });

  it("CLI: factory notify without `test <owner/name>` prints usage", async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (s: string) => void err.push(s) };
    expect(await main(["notify"], io)).toBe(2);
    expect(await main(["notify", "test"], io)).toBe(2);
    expect(err.join("")).toContain("factory notify test <owner/name>");
  });

  it("doctor lists repos with hooks (no URL), fails on loose perms or an unusable key file, warns for the checked repo", async () => {
    const ok = await notifyChecks(home(yamlFor("acme/widgets") + `  acme/gadgets:\n    url: ${URL_}\n    key: ${KEY}\n`));
    expect(ok).toEqual([{ name: "notify", status: "ok", detail: "notify.yaml 0600; hooks for acme/gadgets, acme/widgets" }]);
    expect(JSON.stringify(ok)).not.toContain("abc-123-secret-id");
    expect((await notifyChecks(home()))[0]).toMatchObject({ status: "info" });
    expect((await notifyChecks(home(yamlFor(), 0o640)))[0]).toMatchObject({ status: "fail" });
    const keyFile = home(`repos:\n  acme/widgets:\n    url: ${URL_}\n    key_file: /nonexistent/iris.key\n`);
    expect((await notifyChecks(keyFile))[0]).toMatchObject({ status: "fail" });
    const other = await notifyChecks(home(yamlFor("acme/gadgets")), repoWithOrigin("https://github.com/acme/widgets.git"));
    expect(other[1]).toMatchObject({ name: "notify repo", status: "warn" });
    const mine = await notifyChecks(home(yamlFor()), repoWithOrigin("https://github.com/acme/widgets.git"));
    expect(mine[1]).toMatchObject({ name: "notify repo", status: "ok" });
  });
});
