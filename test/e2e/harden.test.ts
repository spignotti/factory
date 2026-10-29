import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, type FakeStep } from "../../src/agents/fake-runner.js";
import { harden, hardenCommand } from "../../src/commands/harden.js";
import { FakeGitHub } from "../../src/gh.js";
import { canonicalRepoId, loadMemory, memoryDir } from "../../src/memory.js";
import { listProposals, writeProposal } from "../../src/proposals.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { HardenReportSchema, MetricsSchema } from "../../src/schemas/proposal.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { ciRun, entry, PLAN, seedMemory, seedRun } from "../helpers/harden.js";
import { FIXTURES } from "../helpers/repo.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const REPO_YAML = "checks:\n  - { name: lint, run: \"true\", tier: fast }\n  - { name: test, run: \"true\", tier: fast }\n";

function setup(files: Record<string, string> = {}) {
  const repo = makeRepo({ ".factory/repo.yaml": REPO_YAML, "src/a.ts": "export {};\n", ...files });
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  return { repo, factoryHome, repoId: canonicalRepoId("", repo) };
}

async function run(ctx: { repo: string; factoryHome: string }, steps: FakeStep[], gh = new FakeGitHub(), compact = true) {
  const runner = new FakeRunner(steps);
  const deps = { runner, github: gh, profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() };
  const report = await harden({ repo: ctx.repo, compact }, deps);
  return { report, runner, gh, deps };
}

const selection = (resolves: string[], checklist: string[] = []) => ({ rationale: "Finding a recurs in 3 runs; a lint rule catches it.", checklist, plan: PLAN("Add a lint rule for a", resolves) });

describe("factory harden", () => {
  it("without signals: writes metrics, makes no LLM call and no proposal", async () => {
    const ctx = setup();
    const { report, runner } = await run(ctx, []);
    expect(runner.calls).toHaveLength(0);
    expect(report.proposal).toBeNull();
    expect(report.error).toBeNull();
    const lines = readFileSync(join(memoryDir(ctx.factoryHome, ctx.repoId), "metrics.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(MetricsSchema.parse(JSON.parse(lines[0]!))).toMatchObject({ deterministic_checks: 2, open_findings: 0 });
    expect(HardenReportSchema.safeParse(report).success).toBe(true);
  });

  it("compacts memory, selects exactly one proposal (after one rejected answer) and marks its findings proposed", async () => {
    const ctx = setup({ ".factory/checklist.md": "- no console.log in src\n" });
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2, runs: ["r1"] }), entry("a2", { count: 1, runs: ["r2"] }), entry("b", { count: 2 })]);
    const gh = new FakeGitHub();
    gh.runs.push(ciRun("s1", "2026-10-20T00:00:00Z", [["check (lint)", "failure", 20]]), ciRun("s1", "2026-10-20T01:00:00Z", [["check (lint)", "success", 20]]));
    const { report, runner } = await run(
      ctx,
      [
        { role: "plan_medium", output: { merge: [{ keep: "a", drop: ["a2"] }] } },
        { role: "harden", output: selection(["zzz"]) },
        { role: "harden", output: selection(["a"]) },
      ],
      gh,
    );
    expect(runner.remaining()).toEqual({});
    expect(report.error).toBeNull();
    expect(report.compaction).toEqual({ merged: 1, error: null });
    expect(runner.calls.at(-1)!.prompt).toContain("zzz, which is not a signalled memory key");
    expect(report.signals.ci).toMatchObject({ flaky_rate: 1 });
    expect(report.signals.checklist).toEqual(["no console.log in src"]);
    expect(report.proposal).toMatchObject({ id: "2026-10-29", kind: "harden", status: "open", references: { findings: ["a"] } });
    expect(existsSync(report.path!)).toBe(true);
    expect(existsSync(report.path!.replace(/\.json$/, ".plan.json"))).toBe(true);
    const mem = loadMemory(ctx.factoryHome, ctx.repoId);
    expect(mem.entries.map((e) => [e.key, e.status, e.count, e.ref])).toEqual([["a", "proposed", 3, "2026-10-29"], ["b", "open", 2, null]]);
    expect(HardenReportSchema.safeParse(report).success).toBe(true);
  });

  it("invalid selection twice: no proposal, error, exit 1; a bad compaction is reported, not applied", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 }), entry("b", { count: 2 })]);
    const steps: FakeStep[] = [
      { role: "plan_medium", output: { merge: [{ keep: "a", drop: ["nope"] }] } },
      { role: "harden", output: { rationale: "x" } },
      { role: "harden", output: { rationale: "x" } },
    ];
    const out: string[] = [];
    const code = await hardenCommand(
      { repo: ctx.repo, compact: true, json: true },
      { runner: new FakeRunner(steps), github: new FakeGitHub(), profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
    );
    expect(code).toBe(1);
    const report = HardenReportSchema.parse(JSON.parse(out.join("\n")));
    expect(report.error).toContain("invalid after retry");
    expect(report.compaction.error).toContain("nope is not an open memory entry");
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(0);
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries.map((e) => e.status)).toEqual(["open", "open"]);
  });

  it("lifecycle: merged factory PR resolves, closed PR drops (entries reopen), stale proposal drops", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [
      entry("m", { status: "proposed", ref: "p-merged" }),
      entry("c", { status: "proposed", ref: "p-closed", count: 2 }),
      entry("s", { status: "proposed", ref: "p-stale" }),
      entry("y", { status: "proposed", ref: "p-young" }),
    ]);
    const mk = (id: string, created: string, goal: string, findings: string[]) =>
      writeProposal(ctx.factoryHome, { version: 1, kind: "harden", id, repo: ctx.repoId, created_at: created, status: "open", rationale: "r", plan: PLAN(goal, findings), references: { findings, checklist: [] }, signals: {}, metrics: {}, resolution: null });
    mk("p-merged", "2026-10-20T00:00:00Z", "merged goal", ["m"]);
    mk("p-closed", "2026-10-20T00:00:00Z", "closed goal", ["c", "y"]);
    mk("p-stale", "2026-09-01T00:00:00Z", "stale goal", ["s"]);
    mk("p-young", "2026-10-28T00:00:00Z", "young goal", []);
    const gh = new FakeGitHub();
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-21T00:00:00Z"), { pr: "https://github.com/o/r/pull/1", plan: PLAN("merged goal", ["m"]) });
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-21T01:00:00Z"), { pr: "https://github.com/o/r/pull/2", plan: PLAN("closed goal", ["c"]) });
    gh.prStates.set("https://github.com/o/r/pull/1", { state: "merged", draft: false });
    gh.prStates.set("https://github.com/o/r/pull/2", { state: "closed", draft: false });

    const { report, runner } = await run(ctx, [{ role: "plan_medium", output: { merge: [] } }, { role: "harden", output: selection(["c"]) }], gh);
    expect(runner.remaining()).toEqual({});
    expect(report.lifecycle.map((l) => [l.id, l.status]).sort()).toEqual([["p-closed", "dropped"], ["p-merged", "resolved"], ["p-stale", "dropped"]]);
    const byId = Object.fromEntries(listProposals(ctx.factoryHome, ctx.repoId).map((p) => [p.id, p]));
    expect(byId["p-merged"]!.resolution).toMatchObject({ status: "resolved", pr: "https://github.com/o/r/pull/1" });
    expect(byId["p-young"]!.status).toBe("open");
    const mem = Object.fromEntries(loadMemory(ctx.factoryHome, ctx.repoId).entries.map((e) => [e.key, [e.status, e.ref]]));
    expect(mem.m).toEqual(["resolved", "https://github.com/o/r/pull/1"]);
    // c was reopened by the drop and is proposed again by the new proposal; s is open again.
    expect(mem.c).toEqual(["proposed", "2026-10-29"]);
    expect(mem.s![0]).toBe("open");
    // y belongs to the newer proposal now; dropping p-closed leaves it alone.
    expect(mem.y).toEqual(["proposed", "p-young"]);
  });

  it("an unavailable CI audit is a signal error, not a failure", async () => {
    const ctx = setup();
    const gh = new FakeGitHub();
    gh.ciRuns = async () => {
      throw new Error("gh: not logged in\nmore");
    };
    const { report } = await run(ctx, [], gh);
    expect(report.signals.ci).toEqual({ error: "gh: not logged in" });
    expect(report.error).toBeNull();
  });
});
