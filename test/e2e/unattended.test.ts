/**
 * #184: the integration gate for an unattended queue. Merge is proved by GitHub's expected-head
 * merge or auto-merge record, never by a stubbed `done`. Waiting states hold no coding slot.
 * Fake runner and FakeGitHub only; no live provider, credentials or customer data.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Io } from "../../src/commands/gates.js";
import { queueAdd, queueCommand } from "../../src/commands/queue.js";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { issueRevision } from "../../src/queue/admit.js";
import { applyBatch, loadBatch } from "../../src/queue/batch.js";
import { factKey, recoverApply } from "../../src/queue/recover.js";
import { loadQueueByKey, repoQueueKey, saveQueue, updateQueue, type QueueEntry } from "../../src/queue/store.js";
import { runQueue, type StartRun, type StartRunRequest } from "../../src/queue/worker.js";
import { createFixtureRepo } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const WINDOW = { cause: "provider_window_wait", action: "wait" } as const;
const DECISION = { cause: "explicit_decision", action: "decide" } as const;
const MIN = 60_000;
const io: Io = { out: () => undefined, err: () => undefined };

function outcome(repo: string, runId: string, issueNo: number, extra: Partial<RunResult> = {}): RunResult {
  return {
    run_id: runId, repo, task: `#${issueNo}`, type: "feature", lane: "standard", result: "needs_human",
    risk: null, merge_policy: null, pr: null, rounds: 0, minutes: 0, cost_usd: 0, reason: "",
    branch: `factory/${issueNo}-x`, worktree: null, run_dir: "", ...extra,
  } as RunResult;
}

function gate() {
  const reqs: StartRunRequest[] = [];
  const pending = new Map<number, (r: RunResult) => void>();
  const start: StartRun = (req) => {
    reqs.push(req);
    let resolve!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => { resolve = r; });
    pending.set(req.issue, resolve);
    return { done, pid: 0, runId: () => req.runId, kill: () => undefined, unref: () => undefined };
  };
  return {
    reqs,
    start,
    release(issueNo: number, result: RunResult) {
      const resolve = pending.get(issueNo);
      if (!resolve) throw new Error(`no pending start for #${issueNo}`);
      resolve(result);
    },
  };
}

function fakeTime() {
  let t = Date.now();
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, 1);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    }),
  };
}

async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function checkpoint(factoryHome: string, repo: string, runId: string, issueNo: number, extra: Record<string, unknown> = {}): void {
  const dir = join(factoryHome, "runs", runId);
  mkdirSync(join(dir, "worktree"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ acceptance: [], protected_changes: [] }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    version: 1, run_id: runId, repo, task: { issue: issueNo, ref: `#${issueNo}`, text: `# Issue ${issueNo}\n\nDo the work.` },
    no_pr: false, step: "implement", result: "needs_human", reason: "", branch: `factory/${issueNo}-x`,
    worktree: join(dir, "worktree"), pr: `https://github.test/pr/${issueNo}`, lane: "standard",
    packages: {}, failures: {}, handoffs: [], rounds: 0, findings: [], gate_count: 0,
    repair: { gate_attempts: 2, network_retries: 1, format_used: false, infra_reruns: 0 },
    continuation_attempts: 1, updated_at: new Date(Date.now() - 3_600_000).toISOString(), ...extra,
  }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, "state.json"), old, old);
}

async function row(home: string, repo: string, issue: number): Promise<QueueEntry> {
  const entries = loadQueueByKey(home, await repoQueueKey(repo))!.entries;
  const found = entries.find((e) => e.issue === issue);
  if (!found) throw new Error(`no queue row #${issue}`);
  return found;
}

describe("unattended queue acceptance (#184)", () => {
  it("finishes independent work, holds no slot for waits, and does not resume a human decision", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-unattended-"));
    const github = new FakeGitHub();
    const ready = (n: number): Issue => ({ number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open" });
    for (const n of [1, 2, 3, 4]) github.issues.set(n, ready(n));
    expect(await queueAdd({ factoryHome: home, repo, issues: [2], github }, io)).toBe(0);
    const windowRun = "20261114-150000-aaaaaa";
    const blockedRun = "20261114-150001-bbbbbb";
    const decisionRun = "20261114-150002-cccccc";
    checkpoint(home, repo, windowRun, 1, { stop: WINDOW, pr: "https://github.test/pr/1" });
    checkpoint(home, repo, blockedRun, 4, { stop: { cause: "technical_repair", action: "repair" } });
    checkpoint(home, repo, decisionRun, 3, { stop: DECISION });
    writeFileSync(join(home, "runs", decisionRun, "result.json"), JSON.stringify({ stop: DECISION, result: "needs_human", run_id: decisionRun }) + "\n");
    const resetsAt = Date.now() + 30 * MIN;
    await updateQueue(home, repo, (q) => {
      q.entries.push(
        { issue: 1, status: "parked", added_at: "2026-11-14T00:00:00.000Z", run_id: windowRun, issue_rev: issueRevision("Issue 1", "Do the work."), pr: "https://github.test/pr/1", wait_until: resetsAt, window_resets_at: resetsAt, window_waits: 1, reason: "provider window" },
        { issue: 3, status: "parked", added_at: "2026-11-14T00:00:00.000Z", run_id: decisionRun, issue_rev: issueRevision("Issue 3", "Do the work."), reason: "needs a human decision" },
        { issue: 4, status: "parked", added_at: "2026-11-14T00:00:00.000Z", run_id: blockedRun, issue_rev: issueRevision("Issue 4", "Do the work."), blocked_by: [9], reason: "planned paths overlap open factory PR #9" },
      );
    });
    github.prStates.set("9", { state: "open", draft: false });
    const clock = fakeTime();
    const g = gate();
    const ctl = new AbortController();
    const worker = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("independent work starts", () => g.reqs.some((r) => r.issue === 2));
      expect(g.reqs.map((r) => r.issue)).toEqual([2]);
      expect(await row(home, repo, 1)).toMatchObject({ status: "parked" });
      expect(await row(home, repo, 3)).toMatchObject({ status: "parked" });
      expect(await row(home, repo, 4)).toMatchObject({ status: "parked" });
      const spent = JSON.parse(readFileSync(join(home, "runs", windowRun, "state.json"), "utf8")) as { repair: { gate_attempts: number } };
      expect(spent.repair.gate_attempts).toBe(2);

      const facts = new Map([[factKey(repo, 3), { issue: { title: "Issue 3", body: "Do the work.", labels: ["factory-ready"], state: "open" as const } }]]);
      const recovered = await recoverApply(home, { issues: [3] }, { facts, nowMs: clock.now() });
      expect(recovered.released).toEqual([]);
      expect(await row(home, repo, 3)).toMatchObject({ status: "parked", run_id: decisionRun });

      g.release(2, outcome(repo, g.reqs[0]!.runId!, 2, { result: "done", pr: "https://github.test/pr/2", reason: "" }));
      github.prStates.set("9", { state: "merged", draft: false });
      await waitFor("dependent resumes after the blocker closes", () => g.reqs.some((r) => r.issue === 4 && r.resumeRunId === blockedRun));
      expect(g.reqs.filter((r) => r.issue === 1)).toEqual([]);
      expect(g.reqs.filter((r) => r.issue === 3)).toEqual([]);
      g.release(4, outcome(repo, blockedRun, 4, { result: "done", pr: "https://github.test/pr/4", reason: "" }));
      await waitFor("dependent run releases its slot", async () => (await row(home, repo, 4)).status !== "running");

      clock.advance(31 * MIN);
      await waitFor("window wait resumes the same checkpoint", () => g.reqs.some((r) => r.issue === 1 && r.resumeRunId === windowRun));
      const after = JSON.parse(readFileSync(join(home, "runs", windowRun, "state.json"), "utf8")) as { repair: { gate_attempts: number }; continuation_attempts: number };
      expect(after.repair.gate_attempts).toBe(2);
      expect(after.continuation_attempts).toBe(1);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }

    const again = new AbortController();
    const restarted = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: again.signal, start: g.start, io });
    try {
      await waitFor("restarted worker ticks", async () => (await row(home, repo, 2)).status === "done" || g.reqs.length >= 0);
      expect(g.reqs.filter((r) => r.issue === 2)).toHaveLength(1);
      expect(await row(home, repo, 3)).toMatchObject({ status: "parked" });
    } finally {
      again.abort();
      await restarted.catch(() => undefined);
    }

    expect(await queueCommand(["pause"], { factoryHome: home, github, io })).toBe(0);
    github.issues.set(5, ready(5));
    expect(await queueAdd({ factoryHome: home, repo, issues: [5], github }, io)).toBe(0);
    const paused = new AbortController();
    const held = runQueue({ factoryHome: home, github, repo, slots: 1, pollMs: 5, now: clock.now, sleep: clock.sleep, signal: paused.signal, start: g.start, io });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(g.reqs.some((r) => r.issue === 5)).toBe(false);
      expect(await row(home, repo, 5)).toMatchObject({ status: "pending" });
    } finally {
      paused.abort();
      await held.catch(() => undefined);
    }
  }, 30_000);

  it("merges an explicitly approved head and refuses a conflicting second head, including across a restart", async () => {
    const repo = createFixtureRepo();
    const home = mkdtempSync(join(tmpdir(), "factory-unattended-batch-"));
    const reviewed = "a".repeat(40);
    const moved = "d".repeat(40);
    const plant = (id: string, issue: number, sha: string) => {
      const dir = join(home, "runs", id);
      mkdirSync(join(dir, "worktree"), { recursive: true });
      writeFileSync(join(dir, "plan.json"), "{}\n");
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, step: "finished", repo, branch: `factory/${issue}-fix`, pr: `https://github.test/pr/${issue}`,
        reviewed_sha: sha, worktree: join(dir, "worktree"), task: { issue, text: `# ${issue}\n\nbody` },
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({ result: "done", risk: "low", merge_policy: "human_review", pr: `https://github.test/pr/${issue}` }) + "\n");
    };
    plant("20261114-160000-aaaaaa", 7, reviewed);
    plant("20261114-160001-bbbbbb", 8, reviewed);
    const github = new FakeGitHub();
    github.settings = { private: true, auto_merge_allowed: true, branch_protected: true, required_checks: ["done"], merge_methods: { squash: true, merge: false, rebase: false } };
    for (const n of [7, 8]) {
      github.prs.push({ repoDir: repo, head: `factory/${n}-fix`, base: "main", title: "t", body: "b", draft: false, url: `https://github.test/pr/${n}` });
      github.prStates.set(`https://github.test/pr/${n}`, { state: "open", draft: false, ci: "green", behind: false, ...(n === 8 ? { conflicting: true } : {}) });
      github.remoteShas.set(`factory/${n}-fix`, reviewed);
      github.factoryPrs.push({ number: n, branch: `factory/${n}-fix`, files: ["src/math.js"] });
    }
    await applyBatch(home, github, [{ repo, number: 7 }, { repo, number: 8 }]);
    saveQueue(home, { version: 1, repo, repo_key: await repoQueueKey(repo), entries: [{ issue: 7, status: "done", added_at: "2026-11-14T00:00:00.000Z" }] });
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 5, signal: ctl.signal, io,
      start: () => { throw new Error("batch merge must not start a coding run"); },
    });
    try {
      await waitFor("first approved head merges and the conflict is refused", () => github.mergedNow.length === 1 && loadBatch(home)?.prs.find((p) => p.number === 8)?.status === "needs_approval");
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
    expect(github.mergedNow).toEqual([{ pr: "https://github.test/pr/7", sha: reviewed, method: "squash" }]);
    expect(github.approvedShas).toEqual([]);
    expect(loadBatch(home)?.prs.find((p) => p.number === 8)?.status).toBe("needs_approval");
    expect(JSON.parse(readFileSync(join(home, "runs", "20261114-160001-bbbbbb", "result.json"), "utf8")).merge_policy).toBe("human_review");

    github.prStates.set("https://github.test/pr/7", { state: "merged", draft: false, ci: "green" });
    github.remoteShas.set("factory/8-fix", moved);
    const ctl2 = new AbortController();
    const restarted = runQueue({
      factoryHome: home, github, repo, slots: 1, pollMs: 5, signal: ctl2.signal, io,
      start: () => { throw new Error("restart must not start a coding run"); },
    });
    try {
      await waitFor("conflicting head is refused", () => loadBatch(home)?.prs.find((p) => p.number === 8)?.status === "needs_approval");
    } finally {
      ctl2.abort();
      await restarted.catch(() => undefined);
    }
    expect(github.mergedNow).toHaveLength(1);
    expect(loadBatch(home)?.prs.find((p) => p.number === 7)?.status).toBe("merged");
  }, 30_000);

  it("an immediately mergeable run records the exact head, and a protected change does not", async () => {
    let n = 0;
    const merged = await runScenario({
      script: "clean.json",
      patch: (c) => {
        (c.limits as Record<string, unknown>).pr_ci_wait_minutes = 2;
        ((c.merge ??= {}) as Record<string, unknown>).auto_merge_max_risk = "medium";
      },
      github: (gh) => {
        gh.settings.required_checks = ["done"];
        gh.settings.merge_methods = { squash: true, merge: false, rebase: false };
        gh.baseStatus = async () => (n++ === 0 ? "none" : "green");
      },
    });
    expect(merged.result).toMatchObject({ result: "done", merge_policy: "auto" });
    const head = merged.github.remoteShas.get(merged.result.branch!);
    expect(merged.github.autoMerged).toEqual([merged.result.pr]);
    expect(merged.github.autoMergeShas).toEqual([{ pr: merged.result.pr, sha: head }]);
    expect(merged.github.approvedShas).toEqual([head]);
    expect(merged.events.some((e) => e.role === "implement")).toBe(true);
    expect(merged.events.some((e) => e.role === "review_plan")).toBe(true);
    expect(merged.events.some((e) => e.role === "review_simplicity")).toBe(true);

    let repoDir = "";
    const protectedRun = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.merge = { auto_merge_max_risk: "medium" }),
      before: (dir) => void (repoDir = dir),
      steps: (steps) => steps.map((s) => {
        if (s.role === "plan_high") {
          const plan = s.output as { packages: { files: string[] }[]; protected_changes?: unknown[] };
          plan.packages[0]!.files.push(".factory/repo.yaml");
          plan.protected_changes = [{ file: ".factory/repo.yaml", change: "add a red check", reason: "the task asks for it" }];
        }
        if (s.role === "implement" && repoDir) {
          const cfg = readFileSync(join(repoDir, ".factory/repo.yaml"), "utf8");
          s.writes = { ...s.writes, ".factory/repo.yaml": cfg.replace("checks:", "checks:\n  - { name: red, run: \"false\", tier: fast }") };
        }
        return s;
      }),
    });
    expect(protectedRun.result).toMatchObject({ result: "done", merge_policy: "human_review", risk: "high" });
    expect(protectedRun.github.autoMerged).toEqual([]);
    expect(protectedRun.github.mergedNow).toEqual([]);
  }, 120_000);
});
