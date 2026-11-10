import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { abandonRun } from "../../src/commands/abandon.js";
import { autoGc, gc } from "../../src/commands/gc.js";
import { publishEvidence } from "../../src/evaluate/evidence.js";
import { aggregate, parseSince, statsCommand, statsReport } from "../../src/commands/stats.js";
import { renderStatus, statusCommand, statusReport } from "../../src/commands/status.js";
import { StatusReportSchema } from "../../src/schemas/reports.js";
import { FakeGitHub } from "../../src/gh.js";
import { repoLockId, tryRepoGitOps } from "../../src/git.js";
import { acquireRepoLock, repoLockPath } from "../../src/pipeline/lock.js";
import { resumeFactory } from "../../src/pipeline/run.js";
import { addWorkingDays } from "../../src/working-days.js";
import { listRuns, runStartedAt } from "../../src/runs.js";
import { addOrigin, commitFile } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const gcExtras = {
  home_removed: [],
  metadata_moved: [],
  archive_purged: [],
  worktree_pruned: [],
} as const;

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

  it("--since summarizes finished runs from result.json (text and json), not events.jsonl", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const gh = new FakeGitHub();
    const now = Date.parse("2026-10-29T12:00:00Z");
    const inside = "2026-10-29T08:00:00Z";
    const outside = "2026-10-28T18:00:00Z";
    const touch = (id: string, iso: string) => {
      const t = new Date(iso);
      utimesSync(join(home, "runs", id, "result.json"), t, t);
    };
    const open = (pr: string, extra: { draft?: boolean; ci?: "green" | "red" | "pending" | "none"; behind?: boolean; conflicting?: boolean } = {}) =>
      gh.prStates.set(pr, { state: "open", draft: false, ci: "green", behind: false, conflicting: false, ...extra });

    // Started before the window, finished inside it: mtime counts, not the run id and not events.
    fakeRun(home, "20261028-220000-0000b1", {
      result: { result: "done", merge_policy: "auto", risk: "low", pr: "https://pr/merged", reason: "FROM_RESULT" },
      events: [{ event: "run_finished", data: { reason: "FROM_EVENTS" } }],
    });
    gh.prStates.set("https://pr/merged", { state: "merged", draft: false });
    fakeRun(home, "20261029-080000-0000b2", { result: { result: "done", pr: "https://pr/closed", reason: "closed without merge" } });
    gh.prStates.set("https://pr/closed", { state: "closed", draft: false });

    // Pipeline shape: review-exit `reason` is not why the PR was held. Causes live in `risk_reasons`.
    fakeRun(home, "20261029-080000-0000c3", { result: { result: "done", merge_policy: "human_review", risk: "medium", reason: "no open findings", risk_reasons: ["sensitive_paths: src/auth.ts"], pr: "https://pr/risk" } });
    open("https://pr/risk");
    fakeRun(home, "20261029-080000-0000c2", { result: { result: "done", merge_policy: "human_review", risk: "medium", reason: "no open findings", risk_reasons: ["diff 400 lines > 300"], pr: "https://pr/diff" } });
    open("https://pr/diff");
    fakeRun(home, "20261029-080000-0000c1", {
      result: {
        result: "done",
        merge_policy: "human_review",
        risk: "high",
        reason: "max rounds reached, no open bug",
        risk_reasons: ["human_only_paths: .github/workflows/ci.yml", "changes protected config (CI / factory)"],
        pr: "https://pr/prot",
      },
    });
    open("https://pr/prot");

    fakeRun(home, "20261029-080000-0000d5", { result: { result: "done", merge_policy: "human_review", risk: "low", reason: "", pr: "https://pr/draft" } });
    open("https://pr/draft", { draft: true });
    fakeRun(home, "20261029-080000-0000d4", { result: { result: "done", merge_policy: "auto", risk: "low", reason: "", pr: "https://pr/red" } });
    open("https://pr/red", { ci: "red" });
    fakeRun(home, "20261029-080000-0000d3", { result: { result: "done", merge_policy: "auto", risk: "low", reason: "", pr: "https://pr/behind" } });
    open("https://pr/behind", { behind: true });
    fakeRun(home, "20261029-080000-0000d2", { result: { result: "done", merge_policy: "auto", risk: "low", reason: "", pr: "https://pr/conflict" } });
    open("https://pr/conflict", { conflicting: true });
    fakeRun(home, "20261029-080000-0000d1", {
      state: { result: "needs_human", reason: "FROM_RESULT", pr: "https://pr/human" },
      result: { result: "needs_human", merge_policy: "human_review", risk: "low", reason: "FROM_RESULT", pr: "https://pr/human" },
      events: [{ event: "run_finished", data: { reason: "FROM_EVENTS" } }],
    });
    open("https://pr/human");

    fakeRun(home, "20261029-080000-0000e1", { result: { result: "failed", reason: "implement crashed", pr: null } });
    fakeRun(home, "20261029-080000-0000e2", { result: { result: "base_red", reason: "CI on main is red", pr: null } });
    fakeRun(home, "20261029-080000-0000e3", { result: { result: "needs_input", reason: "plan needs input", questions: ["which file?"], pr: null } });

    // Still open and green, but auto: already in the live PR list, not in the since buckets.
    fakeRun(home, "20261029-080000-0000a9", {
      state: { result: "done", pr: "https://pr/auto" },
      result: { result: "done", merge_policy: "auto", risk: "low", reason: "", pr: "https://pr/auto" },
    });
    open("https://pr/auto");

    // Finished before the window, even though the run id is newer.
    fakeRun(home, "20261029-110000-0000f1", { result: { result: "failed", reason: "too old", pr: null } });

    for (const id of ["20261028-220000-0000b1", "20261029-080000-0000b2", "20261029-080000-0000c3", "20261029-080000-0000c2", "20261029-080000-0000c1", "20261029-080000-0000d5", "20261029-080000-0000d4", "20261029-080000-0000d3", "20261029-080000-0000d2", "20261029-080000-0000d1", "20261029-080000-0000e1", "20261029-080000-0000e2", "20261029-080000-0000e3", "20261029-080000-0000a9"]) {
      touch(id, inside);
    }
    touch("20261029-110000-0000f1", outside);

    const s = await statusReport({ factoryHome: home, github: gh, since: "12h", now: () => now });
    expect(s.since?.from).toBe("2026-10-29T00:00:00.000Z");
    expect(s.since?.merged.map((r) => [r.run_id, r.pr_state, r.pr])).toEqual([
      ["20261029-080000-0000b2", "closed", "https://pr/closed"],
      ["20261028-220000-0000b1", "merged", "https://pr/merged"],
    ]);
    expect(s.since?.human_review.map((r) => [r.run_id, r.review_reasons, r.risk])).toEqual([
      ["20261029-080000-0000c3", ["risk", "sensitive_paths: src/auth.ts"], "medium"],
      ["20261029-080000-0000c2", ["diff size", "diff 400 lines > 300"], "medium"],
      ["20261029-080000-0000c1", ["protected paths", "human_only_paths: .github/workflows/ci.yml", "changes protected config (CI / factory)"], "high"],
    ]);
    expect(s.since?.blocked.map((r) => [r.run_id, r.blockers, r.reason])).toEqual([
      ["20261029-080000-0000d5", ["draft"], ""],
      ["20261029-080000-0000d4", ["CI red"], ""],
      ["20261029-080000-0000d3", ["behind"], ""],
      ["20261029-080000-0000d2", ["conflicting"], ""],
      ["20261029-080000-0000d1", ["needs_human"], "FROM_RESULT"],
    ]);
    expect(s.since?.failed.map((r) => r.run_id)).toEqual(["20261029-080000-0000e1"]);
    expect(s.since?.base_red.map((r) => r.reason)).toEqual(["CI on main is red"]);
    expect(s.since?.needs_input).toEqual([
      expect.objectContaining({ run_id: "20261029-080000-0000e3", reason: "plan needs input", questions: ["which file?"] }),
    ]);
    expect(JSON.stringify(s.since)).not.toContain("0000f1");
    expect(JSON.stringify(s.since)).not.toContain("FROM_EVENTS");
    expect(JSON.stringify(s.since)).not.toContain("https://pr/auto");
    expect(s.prs.map((p) => p.pr)).toEqual(["https://pr/auto", "https://pr/human"]);

    const text: string[] = [];
    const io = { out: (line: string) => text.push(line), err: () => {} };
    expect(await statusCommand({ factoryHome: home, github: gh, since: "12h", json: false, now: () => now }, io)).toBe(0);
    const rendered = text.join("");
    expect(rendered).toContain("since 12h:");
    expect(rendered).toContain("merged (2):");
    expect(rendered).toContain("20261028-220000-0000b1 text:20261028-220000-0000b1.md — merged https://pr/merged");
    expect(rendered).toContain("20261029-080000-0000b2 text:20261029-080000-0000b2.md — closed https://pr/closed");
    expect(rendered).toContain("open, green, human_review (3):");
    expect(rendered).toContain("20261029-080000-0000c3 text:20261029-080000-0000c3.md — risk medium, sensitive_paths: src/auth.ts https://pr/risk");
    expect(rendered).toContain("20261029-080000-0000c2 text:20261029-080000-0000c2.md — diff size, diff 400 lines > 300 https://pr/diff");
    expect(rendered).toContain("20261029-080000-0000c1 text:20261029-080000-0000c1.md — protected paths, human_only_paths: .github/workflows/ci.yml, changes protected config (CI / factory) https://pr/prot");
    expect(rendered).not.toContain("no open findings");
    expect(rendered).not.toContain("max rounds reached, no open bug");
    expect(rendered).toContain("open, blocked (5):");
    expect(rendered).toContain("20261029-080000-0000d5 text:20261029-080000-0000d5.md — draft https://pr/draft");
    expect(rendered).toContain("20261029-080000-0000d4 text:20261029-080000-0000d4.md — CI red https://pr/red");
    expect(rendered).toContain("20261029-080000-0000d3 text:20261029-080000-0000d3.md — behind https://pr/behind");
    expect(rendered).toContain("20261029-080000-0000d2 text:20261029-080000-0000d2.md — conflicting https://pr/conflict");
    expect(rendered).toContain("20261029-080000-0000d1 text:20261029-080000-0000d1.md — needs_human: FROM_RESULT https://pr/human");
    expect(rendered).toContain("failed (1):");
    expect(rendered).toContain("base_red (1):");
    expect(rendered).toContain("needs_input (1):");
    expect(rendered).toContain("which file?");
    expect(rendered).not.toContain("FROM_EVENTS");
    expect(rendered).not.toContain("0000f1");

    text.length = 0;
    expect(await statusCommand({ factoryHome: home, github: gh, since: "12h", json: true, now: () => now }, io)).toBe(0);
    const json = JSON.parse(text.join("")) as { since: unknown };
    expect(StatusReportSchema.parse(json).since).toEqual(s.since);

    const off = await statusReport({ factoryHome: home, github: gh, now: () => now });
    expect(off.since).toBeNull();
    expect(renderStatus(off)).not.toContain("since 12h:");
  });

  it("--since does not treat none, missing CI, or a thrown prStatus as an open green PR", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const gh = new FakeGitHub();
    const now = Date.parse("2026-10-29T12:00:00Z");
    const touch = (id: string) => {
      const t = new Date("2026-10-29T08:00:00Z");
      utimesSync(join(home, "runs", id, "result.json"), t, t);
    };
    // Review-exit text must not become the hold reason when risk_reasons is empty.
    fakeRun(home, "20261029-080000-0000aa", {
      state: { result: "done", pr: "https://pr/low" },
      result: { result: "done", merge_policy: "human_review", risk: "low", reason: "no open findings", risk_reasons: [], pr: "https://pr/low" },
    });
    gh.prStates.set("https://pr/low", { state: "open", draft: false, ci: "green" });
    fakeRun(home, "20261029-080000-0000ab", { result: { result: "done", merge_policy: "human_review", risk: "low", reason: "", pr: "https://pr/none" } });
    gh.prStates.set("https://pr/none", { state: "open", draft: false, ci: "none" });
    fakeRun(home, "20261029-080000-0000ac", { result: { result: "done", merge_policy: "human_review", risk: "low", reason: "", pr: "https://pr/noci" } });
    gh.prStates.set("https://pr/noci", { state: "open", draft: false });
    fakeRun(home, "20261029-080000-0000ad", {
      state: { result: "done", pr: "https://pr/missing" },
      result: { result: "done", merge_policy: "human_review", risk: "low", reason: "no open findings", pr: "https://pr/missing" },
    });
    for (const id of ["20261029-080000-0000aa", "20261029-080000-0000ab", "20261029-080000-0000ac", "20261029-080000-0000ad"]) touch(id);

    const s = await statusReport({ factoryHome: home, github: gh, since: "12h", now: () => now });
    expect(s.since?.human_review.map((r) => [r.pr, r.review_reasons])).toEqual([["https://pr/low", ["human_review"]]]);
    expect(s.since?.merged.map((r) => r.pr)).not.toContain("https://pr/missing");
    expect(s.since?.blocked.map((r) => [r.pr, r.blockers, r.error])).toEqual([
      ["https://pr/missing", ["pr status unknown"], "PR https://pr/missing not found"],
      ["https://pr/noci", ["CI missing"], undefined],
      ["https://pr/none", ["CI none"], undefined],
    ]);
    expect(s.prs).toEqual([
      expect.objectContaining({ pr: "https://pr/low", state: "open" }),
      expect.objectContaining({ pr: "https://pr/missing", state: "unknown", error: "PR https://pr/missing not found" }),
    ]);

    const text: string[] = [];
    await statusCommand({ factoryHome: home, github: gh, since: "12h", json: false, now: () => now }, { out: (line) => text.push(line), err: () => {} });
    const rendered = text.join("");
    expect(rendered).toContain("20261029-080000-0000aa text:20261029-080000-0000aa.md — human_review https://pr/low");
    expect(rendered).not.toContain("no open findings");
    expect(rendered).toContain("open, blocked (2):");
    expect(rendered).toContain("20261029-080000-0000ab text:20261029-080000-0000ab.md — CI none https://pr/none");
    expect(rendered).toContain("20261029-080000-0000ac text:20261029-080000-0000ac.md — CI missing https://pr/noci");
    expect(rendered).toContain("pr status unknown (1):");
    expect(rendered).toContain("20261029-080000-0000ad text:20261029-080000-0000ad.md — PR https://pr/missing not found https://pr/missing");
    const openBlocked = rendered.slice(rendered.indexOf("open, blocked"), rendered.indexOf("pr status unknown"));
    expect(openBlocked).not.toContain("0000ad");
    expect(openBlocked).not.toContain("https://pr/missing");
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
    const lines: string[] = [];
    statsCommand({ factoryHome: home, since: "7d", json: false, now: () => Date.parse("2026-10-29T00:00:00Z") }, { out: (line) => lines.push(line), err: () => {} });
    const text = lines.join("");
    expect(text).toContain("gate failures: unit 1");
    expect(text).toContain("reasons: needs_human (1) stalemate: x");
    const empty: string[] = [];
    statsCommand({ factoryHome: mkdtempSync(join(tmpdir(), "factory-home-")), since: "7d", json: false }, { out: (line) => empty.push(line), err: () => {} });
    expect(empty.join("")).toContain("gate failures: –");
    expect(empty.join("")).toContain("reasons: –");
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
    expect(await gc({ factoryHome: r.factoryHome, github: r.github })).toEqual({
      dry_run: false,
      cleaned: [],
      skipped: [],
      stripped: [],
      evidence: [{ repo: r.repo, removed: [] }],
      abandoned: [],
      ...gcExtras,
      log_path: expect.any(String),
    });
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
    expect(() => git(r.repo, "rev-parse", "--verify", "refs/factory/evidence")).toThrow();
    git(r.repo, "fetch", "-q", "origin", "+refs/heads/factory-evidence:refs/factory/evidence");
    expect(git(r.repo, "ls-tree", "-r", "refs/factory/evidence").trim()).toBe("");
    expect(git(r.repo, "rev-parse", "refs/factory/evidence^").trim()).toBe(pub.sha);
  });

  it("never deletes a branch outside factory/*", async () => {
    const { r, branch } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    const st = stateOf(r.runDir);
    git(r.repo, "branch", "-m", branch, "feature/human");
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify({ ...st, branch: "feature/human" }));
    const res = await gc({ factoryHome: r.factoryHome, github: r.github });
    expect(res.cleaned[0]).toMatchObject({ branch_deleted: false, remote_branch_deleted: false, notes: [expect.stringMatching(/not a factory/)] });
    expect(localHas(r.repo, "feature/human")).toBe(true);
  });

  it("cleans a merged worktree and a terminal home while another run holds the only repo slot", async () => {
    const { GcRetentionSchema } = await import("../../src/gc/retention-config.js");
    const { r, branch, wt } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    mkdirSync(join(r.runDir, "home"), { recursive: true });
    writeFileSync(join(r.runDir, "home", "cache"), "x");
    const retention = GcRetentionSchema.parse({ dry_run: false, home_hours: 0 });
    const release = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), "20261029-000000-eeeeee")!;
    try {
      const res = await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, retention });
      expect(res.skipped.filter((s) => /live|busy|locked/.test(s.reason))).toEqual([]);
      expect(res.home_removed.map((h) => h.run_id)).toEqual([r.runId]);
      expect(existsSync(join(r.runDir, "home"))).toBe(false);
      expect(res.cleaned).toEqual([expect.objectContaining({ run_id: r.runId, worktree_removed: true, branch_deleted: true, remote_branch_deleted: true })]);
      expect(existsSync(wt)).toBe(false);
      expect(localHas(r.repo, branch)).toBe(false);
    } finally {
      release();
    }
  });

  it("does not remove the home or worktree of a live run", async () => {
    const { GcRetentionSchema } = await import("../../src/gc/retention-config.js");
    const { r, wt } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    mkdirSync(join(r.runDir, "home"), { recursive: true });
    writeFileSync(join(r.runDir, "home", "cache"), "x");
    const retention = GcRetentionSchema.parse({ dry_run: false, home_hours: 0 });
    const release = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), r.runId)!;
    try {
      const res = await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, retention });
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(join(r.runDir, "home"))).toBe(true);
      expect(res.cleaned).toEqual([]);
      expect(res.home_removed).toEqual([]);
      expect(res.skipped.some((s) => s.run_id === r.runId && /live/.test(s.reason))).toBe(true);
    } finally {
      release();
    }
  });

  it("keeps a merged worktree when git operations are busy and still removes home/", async () => {
    const { GcRetentionSchema } = await import("../../src/gc/retention-config.js");
    const { r, branch, wt } = await pushedRun();
    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    mkdirSync(join(r.runDir, "home"), { recursive: true });
    writeFileSync(join(r.runDir, "home", "cache"), "x");
    const retention = GcRetentionSchema.parse({ dry_run: false, home_hours: 0 });
    const held = await tryRepoGitOps(
      r.repo,
      async () => {
        const res = await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, retention, gitOpsWaitMs: 0 });
        expect(res.cleaned).toEqual([]);
        expect(res.skipped.some((s) => /git worktree operations are busy/.test(s.reason))).toBe(true);
        expect(existsSync(wt)).toBe(true);
        expect(localHas(r.repo, branch)).toBe(true);
        expect(res.home_removed.map((h) => h.run_id)).toEqual([r.runId]);
        expect(existsSync(join(r.runDir, "home"))).toBe(false);
      },
      { waitMs: 0 },
    );
    expect(held.ok).toBe(true);
  });
});

describe("factory gc: runs without PR, open PRs, automatic gc", () => {
  const DAY = 86_400_000;
  async function doneRun() {
    const r = await runScenario({ script: "clean.json", setup: (repo) => void addOrigin(repo) });
    git(r.repo, "push", "-q", "origin", r.result.branch!);
    return { r, wt: join(r.runDir, "worktree"), branch: r.result.branch! };
  }
  const rewrite = (runDir: string, patch: Record<string, unknown>) => writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...stateOf(runDir), ...patch }));

  it("a run without PR keeps its worktree inside the retention; afterwards only the worktree goes, the branch stays", async () => {
    const { r, wt, branch } = await doneRun();
    rewrite(r.runDir, { pr: null, result: "failed", step: "implement" });
    expect(await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false })).toEqual({
      dry_run: false,
      cleaned: [],
      skipped: [],
      stripped: [],
      evidence: [],
      abandoned: [],
      ...gcExtras,
      log_path: expect.any(String),
    });
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

  it("a finished run with an open PR loses only node_modules/.venv/.nox after 12 h; a live run is left alone", async () => {
    const { r, wt } = await doneRun();
    for (const d of ["node_modules/pkg", ".venv/lib", "src-keep"]) mkdirSync(join(wt, d), { recursive: true });
    expect((await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false })).stripped).toEqual([]);

    const later = () => Date.now() + 13 * 3_600_000;
    const live = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), r.runId)!;
    const locked = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false });
    live();
    expect(locked).toMatchObject({ stripped: [], skipped: [expect.objectContaining({ reason: expect.stringMatching(/live/) })] });
    expect(existsSync(join(wt, "node_modules"))).toBe(true);

    const dry = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, dryRun: true, evidence: false });
    expect(dry.stripped).toEqual([{ run_id: r.runId, repo: r.repo, pr: r.result.pr, removed: ["node_modules", ".venv"] }]);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);

    const other = acquireRepoLock(r.factoryHome, git(r.repo, "remote", "get-url", "origin").trim(), "20261029-000000-dddddd")!;
    const res = await gc({ factoryHome: r.factoryHome, github: r.github, now: later, evidence: false });
    other();
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

describe("needs_input timeout and archive retention", () => {
  const DAY = 86_400_000;
  const hook = () => {
    const sent: { body: Record<string, unknown> }[] = [];
    return {
      sent,
      setup: (repo: string) => void git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"),
      before: (_repo: string, home: string) => {
        writeFileSync(join(home, "notify.yaml"), "repos:\n  acme/widgets:\n    url: https://hooks.example.test/h\n    key: crsr_needs-input-key-0123456789\n", { mode: 0o600 });
      },
      notifyFetch: async (_url: string, init: { body: string }) => {
        sent.push({ body: JSON.parse(init.body) as Record<string, unknown> });
        return { status: 200 };
      },
    };
  };
  const stamp = (runDir: string, at: string) => writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...stateOf(runDir), updated_at: at }));

  it("abandons an unanswered needs_input after 2 Berlin working days and notifies the owner", async () => {
    const h = hook();
    const r = await runScenario({ script: "needs-input.json", setup: h.setup, before: h.before });
    expect(r.result.result).toBe("needs_input");
    const stopped = new Date("2026-11-06T09:00:00.000Z"); // Friday 10:00 Europe/Berlin
    stamp(r.runDir, stopped.toISOString());
    const monday = Date.parse("2026-11-09T09:00:00.000Z"); // Monday 10:00, one working day
    const opts = { factoryHome: r.factoryHome, github: r.github, evidence: false, notifyFetch: h.notifyFetch, notifyBackoffMs: [0] };
    expect((await gc({ ...opts, now: () => monday })).abandoned).toEqual([]);
    expect(stateOf(r.runDir).result).toBe("needs_input");

    const due = addWorkingDays(stopped, 2).getTime();
    const dry = await gc({ ...opts, now: () => due, dryRun: true });
    expect(dry.abandoned).toEqual([expect.objectContaining({ run_id: r.runId, notified: false, reason: expect.stringMatching(/2 working days/) })]);
    expect(stateOf(r.runDir).result).toBe("needs_input");

    const res = await gc({ ...opts, now: () => due });
    expect(res.abandoned).toEqual([expect.objectContaining({ run_id: r.runId, notified: true })]);
    expect(stateOf(r.runDir).result).toBe("abandoned");
    expect(h.sent.map((s) => s.body.result)).toEqual(["abandoned"]);
    expect(readFileSync(join(r.runDir, "events.jsonl"), "utf8")).toMatch(/"event":"notify"/);
    expect(JSON.parse(readFileSync(join(r.runDir, "result.json"), "utf8")).questions).toEqual(r.result.questions);
    await expect(resumeFactory(r.runId, {}, { factoryHome: r.factoryHome } as never)).rejects.toThrow(/was abandoned/);
  });

  it("a live lock is not abandoned", async () => {
    const r = await runScenario({ script: "needs-input.json" });
    const stopped = new Date("2026-11-02T09:00:00.000Z");
    stamp(r.runDir, stopped.toISOString());
    const release = acquireRepoLock(r.factoryHome, await repoLockId(r.repo), r.runId)!;
    try {
      const due = addWorkingDays(stopped, 2).getTime();
      expect((await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, now: () => due })).abandoned).toEqual([]);
      expect(stateOf(r.runDir).result).toBe("needs_input");
    } finally {
      release();
    }
  });

  it("tarballs run metadata after retention and still deletes the branch when the PR merges first", async () => {
    const { GcRetentionSchema } = await import("../../src/gc/retention-config.js");
    const r = await runScenario({ script: "clean.json", setup: (repo) => void addOrigin(repo) });
    git(r.repo, "push", "-q", "origin", r.result.branch!);
    const wt = join(r.runDir, "worktree");
    writeFileSync(join(wt, "scratch.txt"), "dirty");
    mkdirSync(join(r.runDir, "services"), { recursive: true });
    writeFileSync(join(r.runDir, "services", "svc.log"), "kept");
    writeFileSync(join(r.runDir, "notes.txt"), "drop");
    const branch = r.result.branch!;
    stamp(r.runDir, new Date(Date.now() - 15 * DAY).toISOString());

    const early = await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, now: () => Date.now(), archiveDays: 30 });
    expect(early.metadata_moved).toEqual([]);
    expect(existsSync(join(r.runDir, "plan.json"))).toBe(true);
    expect(existsSync(wt)).toBe(true);

    r.github.prStates.set(r.result.pr!, { state: "merged", draft: false });
    git(wt, "clean", "-fdq");
    const cleaned = await gc({ factoryHome: r.factoryHome, github: r.github, evidence: false, now: () => Date.now() });
    expect(cleaned.cleaned[0]).toMatchObject({ branch_deleted: true });
    expect(git(r.repo, "branch", "--list", branch).trim()).toBe("");

    const retention = GcRetentionSchema.parse({ metadata_days: 0, metadata_min_per_repo: 0 });
    const res = await gc({
      factoryHome: r.factoryHome,
      github: r.github,
      evidence: false,
      now: () => Date.now(),
      retention,
      archiveDays: 0,
    });
    expect(res.metadata_moved[0]).toMatchObject({ run_id: r.runId });
    expect(existsSync(r.runDir)).toBe(false);
    expect(existsSync(join(r.factoryHome, "archive", "runs", `${r.runId}.tar.gz`))).toBe(true);
  });

  it("does not archive needs_human, a GitHub-CI base_red inside its window, or a live run", async () => {
    const human = await runScenario({ script: "clean.json" });
    const rewrite = (runDir: string, patch: Record<string, unknown>) => writeFileSync(join(runDir, "state.json"), JSON.stringify({ ...stateOf(runDir), ...patch }));
    rewrite(human.runDir, { result: "needs_human", updated_at: new Date(Date.now() - 30 * DAY).toISOString() });
    const red = await runScenario({ script: "clean.json", github: (gh) => void (gh.status = "red") });
    expect((await gc({ factoryHome: human.factoryHome, github: human.github, evidence: false, now: () => Date.now(), archiveDays: 0 })).metadata_moved).toEqual([]);
    expect(existsSync(join(human.runDir, "plan.json"))).toBe(true);
    expect((await gc({ factoryHome: red.factoryHome, github: red.github, evidence: false, now: () => Date.now(), archiveDays: 0 })).metadata_moved).toEqual([]);
    expect(existsSync(join(red.runDir, "plan.json"))).toBe(true);

    const live = await runScenario({ script: "clean.json" });
    rewrite(live.runDir, { updated_at: new Date(Date.now() - 30 * DAY).toISOString() });
    const release = acquireRepoLock(live.factoryHome, await repoLockId(live.repo), live.runId)!;
    try {
      expect((await gc({ factoryHome: live.factoryHome, github: live.github, evidence: false, now: () => Date.now(), archiveDays: 0 })).metadata_moved).toEqual([]);
      expect(existsSync(join(live.runDir, "worktree"))).toBe(true);
    } finally {
      release();
    }
  });
});

describe("factory abandon", () => {
  it("drops the worktree and a stale lock, keeps the branch, result and logs", async () => {
    const r = await runScenario({ script: "clean.json" });
    const wt = join(r.runDir, "worktree");
    const id = await repoLockId(r.repo);
    mkdirSync(join(r.factoryHome, "locks"), { recursive: true });
    writeFileSync(repoLockPath(r.factoryHome, id), `2147483647\n${r.runId}\n`);
    const outcome = await abandonRun({ factoryHome: r.factoryHome, runId: r.runId, reason: "abandoned with factory abandon" });
    expect(outcome.ok).toBe(true);
    expect(outcome.worktree_removed).toBe(true);
    expect(outcome.message).toMatch(/released stale lock/);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(repoLockPath(r.factoryHome, id))).toBe(false);
    expect(git(r.repo, "branch", "--list", r.result.branch!).trim()).not.toBe("");
    expect(JSON.parse(readFileSync(join(r.runDir, "result.json"), "utf8")).result).toBe("abandoned");
    const events = readFileSync(join(r.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"result":"abandoned"');
    expect(events).toContain("no notify.yaml");
    expect((await abandonRun({ factoryHome: r.factoryHome, runId: r.runId, reason: "again" })).message).toMatch(/already abandoned/);
    await expect(resumeFactory(r.runId, {}, { factoryHome: r.factoryHome } as never)).rejects.toThrow(/was abandoned/);
  });

  it("refuses a run whose process still holds the lock", async () => {
    const r = await runScenario({ script: "clean.json" });
    const release = acquireRepoLock(r.factoryHome, await repoLockId(r.repo), r.runId)!;
    try {
      const outcome = await abandonRun({ factoryHome: r.factoryHome, runId: r.runId, reason: "abandoned with factory abandon" });
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/still running/);
      expect(existsSync(join(r.runDir, "worktree"))).toBe(true);
      expect(stateOf(r.runDir).result).toBe("done");
    } finally {
      release();
    }
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

  it("abandon is in --help and abandons the run in $FACTORY_HOME", async () => {
    const { main } = await import("../../src/cli.js");
    let err = "";
    expect(await main(["--help"], { out: () => {}, err: (s) => void (err += s) })).toBe(0);
    expect(err).toContain("factory abandon <run-id>");

    const r = await runScenario({ script: "clean.json" });
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = r.factoryHome;
    try {
      let out = "";
      expect(await main(["abandon", r.runId], { out: (s) => void (out += s), err: () => {} })).toBe(0);
      expect(out).toMatch(/abandoned/);
      expect(existsSync(join(r.runDir, "worktree"))).toBe(false);
      expect(await main(["abandon", "no-such-run"], { out: () => {}, err: () => {} })).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });
});
