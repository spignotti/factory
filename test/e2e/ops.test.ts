import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { FakeGitHub } from "../../src/gh.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { listRuns, runStartedAt } from "../../src/runs.js";
import { runScenario } from "../helpers/scenario.js";


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

describe("CLI wiring", () => {
  it("status prints JSON from $FACTORY_HOME", async () => {
    const { main } = await import("../../src/cli.js");
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      for (const [args, key] of [[["status", "--json"], "running"]] as const) {
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
