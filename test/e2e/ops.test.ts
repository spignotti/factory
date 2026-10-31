import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoGc, gc } from "../../src/commands/gc.js";
import { publishEvidence } from "../../src/evaluate/evidence.js";
import { aggregate, parseSince, statsReport } from "../../src/commands/stats.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { FakeGitHub } from "../../src/gh.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { listRuns, runStartedAt } from "../../src/runs.js";
import { addOrigin, commitFile } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const stateOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;

/** A synthetic run directory (state/result/events) for status and stats. */
function fakeRun(home: string, id: string, v: { state?: Record<string, unknown>; result?: Record<string, unknown>; events?: Record<string, unknown>[] }): void {
  const dir = join(home, "runs", id);
  mkdirSync(dir, { recursive: true });
  const base = { version: 1, run_id: id, repo: "/r", task: { ref: `text:${id}.md` }, no_pr: false, step: "finished", result: "done", reason: "", branch: null, worktree: null, pr: null, lane: "standard" };
  if (v.state) writeFileSync(join(dir, "state.json"), JSON.stringify({ ...base, ...v.state }));
  if (v.result) writeFileSync(join(dir, "result.json"), JSON.stringify({ run_id: id, repo: "/r", task: `text:${id}.md`, rounds: 1, minutes: 10, ...v.result }));
  if (v.events) writeFileSync(join(dir, "events.jsonl"), v.events.map((e) => JSON.stringify({ ts: "", run_id: id, step: "x", role: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data: {}, ...e })).join("\n") + "\n");
}

describe("runs", () => {
  it("the start time comes from the run id (UTC); other directories are ignored", () => {
    expect(runStartedAt("20261029-081500-abcdef")?.toISOString()).toBe("2026-10-29T08:15:00.000Z");
    expect(runStartedAt("notes")).toBeUndefined();
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    fakeRun(home, "20261029-081500-abcdef", { state: {} });
    mkdirSync(join(home, "runs", "notes"));
    expect(listRuns(home).map((r) => r.run_id)).toEqual(["20261029-081500-abcdef"]);
  });
});

describe("factory status", () => {
  it("running (live lock holder), waiting, interrupted and open PRs; merged PRs and gc'ed runs drop out", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const gh = new FakeGitHub();
    gh.prStates.set("https://pr/1", { state: "open", draft: true });
    gh.prStates.set("https://pr/2", { state: "merged", draft: false });
    gh.prStates.set("https://pr/3", { state: "open", draft: false });
    fakeRun(home, "20261029-090000-000001", { state: { step: "review", result: null, branch: "factory/a" } });
    const release = acquireRepoLock(home, "/r", "20261029-090000-000001")!;
    fakeRun(home, "20261029-080000-000002", { state: { result: "needs_human", reason: "stalemate", pr: "https://pr/1" }, result: { merge_policy: "human_review", risk: "medium" } });
    fakeRun(home, "20261029-070000-000003", { state: { result: "needs_human", reason: "x", pr: "https://pr/2" } });
    fakeRun(home, "20261029-060000-000004", { state: { step: "implement", result: null } });
    fakeRun(home, "20261029-050000-000005", { state: { result: "done", pr: "https://pr/3" }, result: { merge_policy: "auto", risk: "low" } });
    fakeRun(home, "20261029-040000-000006", { state: { result: "needs_input", reason: "questions" }, result: { questions: ["which file?"] } });
    fakeRun(home, "20261029-030000-000007", { state: { result: "done", pr: "https://pr/gone", gc_at: "2026-10-29T10:00:00Z" } });
    fakeRun(home, "20261029-020000-000008", { state: { result: "done", pr: "https://pr/err" } });
    try {
      const s = await statusReport({ factoryHome: home, github: gh, now: () => Date.parse("2026-10-29T09:30:00Z") });
      expect(s.running).toEqual([expect.objectContaining({ run_id: "20261029-090000-000001", step: "review", pid: process.pid, minutes: 30, branch: "factory/a" })]);
      expect(s.waiting.map((w) => [w.run_id, w.result])).toEqual([
        ["20261029-040000-000006", "needs_input"],
        ["20261029-080000-000002", "needs_human"],
      ]);
      expect(s.waiting[0]!.questions).toEqual(["which file?"]);
      expect(s.interrupted.map((r) => r.run_id)).toEqual(["20261029-060000-000004"]);
      expect(s.prs).toEqual([
        expect.objectContaining({ pr: "https://pr/err", state: "unknown", draft: null }),
        expect.objectContaining({ pr: "https://pr/3", state: "open", draft: false, merge_policy: "auto", risk: "low", result: "done" }),
        expect.objectContaining({ pr: "https://pr/1", state: "open", draft: true, result: "needs_human" }),
      ]);
      expect(renderStatus(s)).toContain("interrupted (1):\n  20261029-060000-000004 text:20261029-060000-000004.md — stopped in implement; factory resume 20261029-060000-000004");
    } finally {
      release();
    }
  });

  it("works on a real run: a needs_human run with its draft PR", async () => {
    const r = await runScenario({ script: "stalemate.json" });
    const s = await statusReport({ factoryHome: r.factoryHome, github: r.github });
    expect(s.waiting).toEqual([expect.objectContaining({ run_id: r.runId, result: "needs_human", pr: r.result.pr, worktree: join(r.runDir, "worktree") })]);
    expect(s.prs).toEqual([expect.objectContaining({ pr: r.result.pr, state: "open", draft: true, merge_policy: "human_review" })]);
    expect(s.running).toEqual([]);
  });
});

describe("factory stats", () => {
  it("parses --since", () => {
    expect(parseSince("24h")).toBe(86_400_000);
    expect(parseSince("2w")).toBe(14 * 86_400_000);
    expect(() => parseSince("7")).toThrow(/invalid --since/);
  });

  it("aggregates results, lanes, rounds, gates, providers, roles, reasons and policies; previous period and delta", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const ev = (event: string, extra: Record<string, unknown> = {}) => ({ event, ...extra });
    fakeRun(home, "20261028-100000-000001", {
      state: { result: "done", lane: "fast" },
      result: { result: "done", type: "feature", rounds: 1, minutes: 4, merge_policy: "auto", pr: "https://pr/1" },
      events: [
        ev("agent_finished", { role: "implement", model: "opencode-go/kimi", tokens_in: 100, tokens_out: 10, cost_usd: 0.01, data: { billing: "subscription" } }),
        ev("agent_finished", { role: "pr_writer", model: "anthropic/x", tokens_in: 7, tokens_out: 3, cost_usd: 0.02, data: { billing: "metered" } }),
        // an older log line without billing: the built-in default (opencode-go = subscription) applies
        ev("agent_finished", { role: "pr_writer", model: "opencode-go/kimi", tokens_in: 1, tokens_out: 1, cost_usd: 0.5 }),
        ev("agent_error", { role: "plan_high", model: "openai/sol", data: { class: "capacity" } }),
        ev("model_fallback", { role: "plan_high", model: "openai/sol", data: { from: "openai/sol", to: "opencode-go/grok" } }),
        ev("gate_result", { data: { check: "unit", status: "fail" } }),
        ev("gate_result", { data: { check: "unit", status: "flaky" } }),
        ev("gate_result", { data: { base: true, check: "lint", status: "fail" } }),
      ],
    });
    fakeRun(home, "20261028-110000-000002", {
      state: { result: "needs_human", reason: "stalemate: x", lane: "standard" },
      result: { result: "needs_human", type: "bug", rounds: 3, minutes: 30, merge_policy: "human_review", pr: "https://pr/2" },
      events: [ev("lane_escalated"), ev("watchdog_abort"), ev("agent_error", { role: "review_plan", model: "openai/sol", data: { class: "limit" } })],
    });
    fakeRun(home, "20261028-120000-000003", { state: { result: "locked" }, result: { result: "locked", rounds: 0, minutes: 0 } });
    fakeRun(home, "20261028-130000-000004", { state: { result: null, step: "review" } });
    fakeRun(home, "20261021-100000-000005", { state: { result: "failed" }, result: { result: "failed", rounds: 2, minutes: 8, merge_policy: null } });
    const s = statsReport({ factoryHome: home, since: "7d", now: () => Date.parse("2026-10-29T00:00:00Z") });
    const c = s.current;
    expect(c.runs).toBe(4);
    expect(c.by_result).toEqual({ done: 1, needs_human: 1, locked: 1, running: 1 });
    expect(c.by_lane).toEqual({ fast: 1, standard: 3 });
    expect(c.by_type).toEqual({ feature: 1, bug: 1 });
    expect(c.done_rate).toBe(0.5);
    expect(c.rounds).toEqual({ median: 1, p90: 3 });
    expect(c.minutes).toEqual({ median: 4, p90: 30 });
    expect(c.gate_failures).toEqual({ unit: 1 });
    expect(c.flaky_checks).toEqual({ unit: 1 });
    expect(c.reasons).toEqual([{ result: "needs_human", reason: "stalemate: x", count: 1 }]);
    expect(c.providers.openai).toMatchObject({ calls: 2, errors: 2, fallbacks: 1, capacity_errors: 1, limit_errors: 1 });
    expect(c.providers["opencode-go"]).toMatchObject({ calls: 2, tokens_in: 101, cost_usd: 0, billing: "subscription" });
    expect(c.providers.anthropic).toMatchObject({ calls: 1, cost_usd: 0.02, billing: "metered" });
    expect(c.roles.implement).toEqual({ calls: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0 });
    expect(c.cost_usd).toBe(0.02);
    expect(c.subscription_tokens).toEqual({ tokens_in: 101, tokens_out: 11 });
    expect(c).toMatchObject({ lane_escalations: 1, watchdog_aborts: 1, merge_policy: { auto: 1, human_review: 1 }, auto_merged: 1, reverted: null });
    expect(s.previous).toMatchObject({ runs: 1, by_result: { failed: 1 }, done_rate: 0 });
    expect(s.delta).toEqual({ runs: 3, done_rate: 0.5, cost_usd: 0.02, subscription_tokens: 112, median_rounds: -1 });
  });

  it("--repo filters by resolved path", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    fakeRun(home, "20261028-100000-000001", { state: { repo }, result: { result: "done" } });
    fakeRun(home, "20261028-100000-000002", { state: { repo: "/elsewhere" }, result: { result: "done" } });
    const s = statsReport({ factoryHome: home, repo: `${repo}/.`, now: () => Date.parse("2026-10-29T00:00:00Z") });
    expect(s.repo).toBe(repo);
    expect(s.current.runs).toBe(1);
  });

  it("empty periods have null rates and quantiles", () => {
    expect(aggregate([], new Date(0), new Date(1))).toMatchObject({ runs: 0, done_rate: null, rounds: { median: null, p90: null } });
  });
});

describe("factory gc", () => {
  /** A done run whose branch the "factory" pushed to a real bare origin (FakeGitHub records pushes only). */
  async function pushedRun() {
    const r = await runScenario({ script: "clean.json", setup: (repo) => void addOrigin(repo) });
    const branch = r.result.branch!;
    git(r.repo, "push", "-q", "origin", branch);
    return { r, branch, wt: join(r.runDir, "worktree") };
  }
  const remoteHas = (repo: string, branch: string) => git(repo, "ls-remote", "--heads", "origin", branch).trim() !== "";
  const localHas = (repo: string, branch: string) => git(repo, "branch", "--list", branch).trim() !== "";

  it("skips open PRs; a merged PR loses worktree, local and remote branch; gc_at makes it idempotent", async () => {
    const { r, branch, wt } = await pushedRun();
    expect((await gc({ factoryHome: r.factoryHome, github: r.github })).skipped).toEqual([expect.objectContaining({ reason: "PR is open" })]);
    expect(existsSync(wt)).toBe(true);

    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    const dry = await gc({ factoryHome: r.factoryHome, github: r.github, dryRun: true });
    expect(dry.cleaned).toEqual([expect.objectContaining({ worktree_removed: true, branch_deleted: true, remote_branch_deleted: true })]);
    expect(existsSync(wt) && localHas(r.repo, branch) && remoteHas(r.repo, branch)).toBe(true);

    const res = await gc({ factoryHome: r.factoryHome, github: r.github });
    expect(res.cleaned).toEqual([expect.objectContaining({ run_id: r.runId, pr_state: "merged", worktree_removed: true, branch_deleted: true, remote_branch_deleted: true, notes: [] })]);
    expect(existsSync(wt)).toBe(false);
    expect(localHas(r.repo, branch)).toBe(false);
    expect(remoteHas(r.repo, branch)).toBe(false);
    expect(stateOf(r.runDir).gc_at).toEqual(expect.any(String));
    expect(git(r.repo, "branch", "--show-current").trim()).toBe("main");
    expect(await gc({ factoryHome: r.factoryHome, github: r.github })).toEqual({ dry_run: false, cleaned: [], skipped: [], stripped: [], evidence: [{ repo: r.repo, removed: [] }] });
    const s = await statusReport({ factoryHome: r.factoryHome, github: r.github });
    expect(s.prs).toEqual([]);
  });

  it("a remote branch moved by someone else is kept; a dirty worktree needs --force", async () => {
    const { r, branch, wt } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "closed", draft: false });
    // Someone pushes on top of the factory's branch.
    const other = join(mkdtempSync(join(tmpdir(), "factory-clone-")), "c");
    git(r.repo, "worktree", "add", "-q", other, `origin/${branch}`);
    commitFile(other, "human.txt", "x");
    git(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    git(r.repo, "worktree", "remove", other);
    writeFileSync(join(wt, "scratch.txt"), "uncommitted");

    expect((await gc({ factoryHome: r.factoryHome, github: r.github })).skipped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/uncommitted.*--force/) })]);
    const res = await gc({ factoryHome: r.factoryHome, github: r.github, force: true });
    expect(res.cleaned[0]).toMatchObject({ pr_state: "closed", worktree_removed: true, branch_deleted: true, remote_branch_deleted: false, notes: [expect.stringMatching(/remote branch moved/)] });
    expect(remoteHas(r.repo, branch)).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it("evidence retention: run folders older than 30 days leave factory-evidence with a plain commit", async () => {
    const { r } = await pushedRun();
    const dir = mkdtempSync(join(tmpdir(), "evidence-"));
    writeFileSync(join(dir, "r1-A1.png"), "png");
    const author = { name: "factory-bot", email: "factory-bot@users.noreply.github.com" };
    const pub = await publishEvidence(r.repo, { runId: r.runId, dir, files: ["r1-A1.png"], author });
    expect((await gc({ factoryHome: r.factoryHome, github: r.github })).evidence).toEqual([{ repo: r.repo, removed: [] }]);
    const later = () => Date.now() + 31 * 86_400_000;
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, now: later, dryRun: true })).evidence).toEqual([{ repo: r.repo, removed: [r.runId] }]);
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, now: later })).evidence).toEqual([{ repo: r.repo, removed: [r.runId] }]);
    expect(git(r.repo, "ls-remote", "origin", "refs/heads/factory-evidence").split(/\s/)[0]).not.toBe(pub.sha);
    expect(git(r.repo, "ls-tree", "-r", "refs/factory/evidence").trim()).not.toBe("");
    git(r.repo, "fetch", "-q", "origin", "+refs/heads/factory-evidence:refs/factory/evidence");
    expect(git(r.repo, "ls-tree", "-r", "refs/factory/evidence").trim()).toBe("");
    expect(git(r.repo, "rev-parse", "refs/factory/evidence^").trim()).toBe(pub.sha);
  });

  it("skips a repository whose lock is held; never deletes a branch outside factory/*", async () => {
    const { r, branch } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    const release = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), "20261029-000000-cccccc")!;
    expect((await gc({ factoryHome: r.factoryHome, github: r.github })).skipped[0]?.reason).toMatch(/locked/);
    release();

    const st = stateOf(r.runDir);
    git(r.repo, "branch", "-m", branch, "feature/human");
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify({ ...st, branch: "feature/human" }));
    const res = await gc({ factoryHome: r.factoryHome, github: r.github });
    expect(res.cleaned[0]).toMatchObject({ branch_deleted: false, remote_branch_deleted: false, notes: [expect.stringMatching(/not a factory/)] });
    expect(localHas(r.repo, "feature/human")).toBe(true);
  });
});

describe("factory gc: runs without PR, open PRs, automatic gc", () => {
  const DAY = 86_400_000;
  async function doneRun() {
    const r = await runScenario({ script: "clean.json", setup: (repo) => void addOrigin(repo) });
    return { r, wt: join(r.runDir, "worktree"), branch: r.result.branch! };
  }
  const rewrite = (runDir: string, patch: Record<string, unknown>) => writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...stateOf(runDir), ...patch }));

  it("a run without PR keeps its worktree inside the retention; afterwards only the worktree goes, the branch stays", async () => {
    const { r, wt, branch } = await doneRun();
    rewrite(r.runDir, { pr: null, result: "needs_human", step: "implement" });
    expect(await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false })).toEqual({ dry_run: false, cleaned: [], skipped: [], stripped: [], evidence: [] });
    expect(existsSync(wt)).toBe(true);

    const later = () => Date.now() + 8 * DAY;
    const dry = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, dryRun: true, evidence: false });
    expect(dry.cleaned).toEqual([expect.objectContaining({ run_id: r.runId, pr: null, pr_state: "none", worktree_removed: true, branch_deleted: false })]);
    expect(existsSync(wt)).toBe(true);
    // Custom retention: 10 days is not over yet.
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, now: later, retentionDays: 10, evidence: false })).cleaned).toEqual([]);

    writeFileSync(join(wt, "wip.txt"), "uncommitted");
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false })).skipped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/uncommitted/) })]);
    git(wt, "clean", "-fdq");

    const res = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false });
    expect(res.cleaned).toEqual([expect.objectContaining({ pr_state: "none", notes: [expect.stringMatching(/branch .* kept; resume is no longer possible/)] })]);
    expect(existsSync(wt)).toBe(false);
    expect(git(r.repo, "branch", "--list", branch).trim()).not.toBe("");
    expect(stateOf(r.runDir).gc_at).toEqual(expect.any(String));
    const { resumeFactory } = await import("../../src/pipeline/run.js");
    await expect(resumeFactory(r.runId, {}, { factoryHome: r.factoryHome } as never)).rejects.toThrow(/cleaned up by factory gc/);
  });

  it("a finished run with an open PR loses only node_modules/.venv/.nox after 12 h; a locked repo is left alone", async () => {
    const { r, wt } = await doneRun();
    for (const d of ["node_modules/pkg", ".venv/lib", "src-keep"]) mkdirSync(join(wt, d), { recursive: true });
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false })).stripped).toEqual([]);

    const later = () => Date.now() + 13 * 3_600_000;
    const release = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), "20261029-000000-dddddd")!;
    const locked = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false });
    release();
    expect(locked).toMatchObject({ stripped: [], skipped: [expect.objectContaining({ reason: expect.stringMatching(/locked/) })] });
    expect(existsSync(join(wt, "node_modules"))).toBe(true);

    const dry = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, dryRun: true, evidence: false });
    expect(dry.stripped).toEqual([{ run_id: r.runId, repo: r.repo, pr: r.result.pr, removed: ["node_modules", ".venv"] }]);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);

    const res = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false });
    expect(res).toMatchObject({ cleaned: [], skipped: [expect.objectContaining({ reason: "PR is open" })], stripped: [expect.objectContaining({ removed: ["node_modules", ".venv"] })] });
    expect(existsSync(join(wt, "node_modules")) || existsSync(join(wt, ".venv"))).toBe(false);
    expect(existsSync(join(wt, "src-keep"))).toBe(true);
    expect(stateOf(r.runDir).gc_at).toBeUndefined();
  });

  it("a run that is not finished (open PR, needs_human) keeps its dependency folders: resume needs them", async () => {
    const { r, wt } = await doneRun();
    rewrite(r.runDir, { result: "needs_human", step: "review" });
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    const res = await gc({ factoryHome: r.factoryHome, github: r.github, now: () => Date.now() + 30 * DAY, evidence: false });
    expect(res.stripped).toEqual([]);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);
  });

  it("autoGc never throws, logs what it cleaned, and gives up after its timeout", async () => {
    const { r } = await doneRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    const log: string[] = [];
    const rep = await autoGc({ factoryHome: r.factoryHome, github: r.github, log: (s) => void log.push(s) });
    expect(rep?.cleaned).toHaveLength(1);
    expect(rep?.evidence).toEqual([]);
    expect(log.join("")).toMatch(/gc cleaned 1 worktree/);

    // An unreadable runs folder (a file): the error is logged, the run goes on.
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    writeFileSync(join(home, "runs"), "not a directory");
    const failed: string[] = [];
    expect(await autoGc({ factoryHome: home, github: r.github, log: (s) => void failed.push(s) })).toBeUndefined();
    expect(failed.join("")).toMatch(/automatic gc failed \(the run continues\)/);

    const hanging = { prStatus: () => new Promise(() => {}) } as unknown as FakeGitHub;
    const { r: r2 } = await doneRun();
    const slow: string[] = [];
    expect(await autoGc({ factoryHome: r2.factoryHome, github: hanging, timeoutMs: 50, log: (s) => void slow.push(s) })).toBeUndefined();
    expect(slow.join("")).toMatch(/timed out/);
  });
});

describe("CLI wiring", () => {
  it("status, stats and gc print JSON from $FACTORY_HOME", async () => {
    const { main } = await import("../../src/cli.js");
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      for (const [args, key] of [[["status", "--json"], "running"], [["stats", "--json", "--since", "1d"], "current"], [["gc", "--json", "--dry-run"], "cleaned"]] as const) {
        let out = "";
        expect(await main([...args], { out: (s) => void (out += s), err: () => {} })).toBe(0);
        expect(JSON.parse(out)).toHaveProperty(key);
      }
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });
});
