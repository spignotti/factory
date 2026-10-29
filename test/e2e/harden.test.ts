import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, type FakeStep } from "../../src/agents/fake-runner.js";
import { harden, hardenCommand } from "../../src/commands/harden.js";
import { FakeGitHub } from "../../src/gh.js";
import { canonicalRepoId, loadMemory, memoryDir } from "../../src/memory.js";
import { listProposals, proposalsDir, writeProposal } from "../../src/proposals.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { HardenReportSchema, MetricsSchema } from "../../src/schemas/proposal.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { ciRun, entry, PLAN, seedMemory, seedRun } from "../helpers/harden.js";
import { FIXTURES, gitIn } from "../helpers/repo.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const REPO_YAML = "checks:\n  - { name: lint, run: \"true\", tier: fast }\n  - { name: test, run: \"true\", tier: fast }\n";

function setup(files: Record<string, string> = {}) {
  const repo = makeRepo({ ".factory/repo.yaml": REPO_YAML, "src/a.ts": "export {};\n", ...files });
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  return { repo, factoryHome, repoId: canonicalRepoId("", repo) };
}

async function run(ctx: { repo: string; factoryHome: string }, steps: FakeStep[], gh = new FakeGitHub(), compact = true, max?: number) {
  const runner = new FakeRunner(steps);
  const deps = { runner, github: gh, profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() };
  const report = await harden({ repo: ctx.repo, compact, ...(max ? { max } : {}) }, deps);
  return { report, runner, gh, deps };
}

const item = (goal: string, resolves: string[], checklist: string[] = []) => ({ rationale: `Signals behind: ${goal}.`, checklist, plan: PLAN(goal, resolves) });
const selection = (...items: ReturnType<typeof item>[]) => ({ proposals: items });

describe("factory harden", () => {
  it("without signals: writes metrics, makes no LLM call and no ticket", async () => {
    const ctx = setup();
    const { report, runner } = await run(ctx, []);
    expect(runner.calls).toHaveLength(0);
    expect(report.ticket).toBeNull();
    expect(report.error).toBeNull();
    const lines = readFileSync(join(memoryDir(ctx.factoryHome, ctx.repoId), "metrics.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(MetricsSchema.parse(JSON.parse(lines[0]!))).toMatchObject({ deterministic_checks: 2, open_findings: 0 });
    expect(HardenReportSchema.safeParse(report).success).toBe(true);
  });

  it("compacts memory, writes ONE ticket with ranked proposals (after one rejected answer) and marks each one's findings", async () => {
    const ctx = setup({ ".factory/checklist.md": "- no console.log in src\n" });
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2, runs: ["r1"] }), entry("a2", { count: 1, runs: ["r2"] }), entry("b", { count: 2 })]);
    const gh = new FakeGitHub();
    gh.runs.push(ciRun("s1", "2026-10-20T00:00:00Z", [["check (lint)", "failure", 20]]), ciRun("s1", "2026-10-20T01:00:00Z", [["check (lint)", "success", 20]]));
    const { report, runner } = await run(
      ctx,
      [
        { role: "plan_medium", output: { merge: [{ keep: "a", drop: ["a2"] }] } },
        { role: "harden", output: selection(item("Lint rule for a", ["a"]), item("Test for b", ["zzz"])) },
        { role: "harden", output: selection(item("Lint rule for a", ["a"]), item("Test for b", ["b"]), item("No console.log check", [], ["no console.log in src"])) },
      ],
      gh,
    );
    expect(runner.remaining()).toEqual({});
    expect(report.error).toBeNull();
    expect(report.rejected).toEqual([]);
    expect(report.compaction).toEqual({ merged: 1, error: null });
    expect(runner.calls.at(-1)!.prompt).toContain("proposal 2: resolves_findings names zzz, which is not a signalled memory key");
    expect(runner.calls.at(-1)!.prompt).toContain("Up to 5 proposals, ranked");
    expect(report.signals.ci).toMatchObject({ flaky_rate: 1 });
    expect(report.signals.checklist).toEqual(["no console.log in src"]);
    const t = report.ticket!;
    expect(t).toMatchObject({ id: "2026-10-29", kind: "harden" });
    expect(t.proposals.map((p) => [p.id, p.rank, p.status, p.plan.goal, p.references])).toEqual([
      ["2026-10-29.1", 1, "open", "Lint rule for a", { findings: ["a"], checklist: [] }],
      ["2026-10-29.2", 2, "open", "Test for b", { findings: ["b"], checklist: [] }],
      ["2026-10-29.3", 3, "open", "No console.log check", { findings: [], checklist: ["no console.log in src"] }],
    ]);
    expect(report.path).toBe(join(proposalsDir(ctx.factoryHome, ctx.repoId), "2026-10-29.json"));
    for (const p of t.proposals) expect(JSON.parse(readFileSync(p.plan_path, "utf8")).goal).toBe(p.plan.goal);
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(1);
    const mem = loadMemory(ctx.factoryHome, ctx.repoId);
    expect(mem.entries.map((e) => [e.key, e.status, e.count, e.ref])).toEqual([["a", "proposed", 3, "2026-10-29.1"], ["b", "proposed", 2, "2026-10-29.2"]]);
    expect(HardenReportSchema.safeParse(report).success).toBe(true);
  });

  it("caps the list at max_proposals (repo.yaml, --max wins) and keeps the valid ones after the retry", async () => {
    const ctx = setup();
    writeFileSync(join(ctx.repo, ".factory/repo.yaml"), REPO_YAML + "harden:\n  max_proposals: 3\n");
    gitIn(ctx.repo, "commit", "-qam", "max 3");
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 }), entry("b", { count: 2 }), entry("c", { count: 2 })]);
    const answer = selection(item("A", ["a"]), item("A again", ["a"]), item("C", ["c"]), item("B", ["b"]));
    const { report, runner } = await run(ctx, [{ role: "harden", output: answer }, { role: "harden", output: answer }], new FakeGitHub(), false, 2);
    expect(runner.remaining()).toEqual({});
    expect(runner.calls[0]!.prompt).toContain("Up to 2 proposals");
    expect(report.ticket!.proposals.map((p) => p.plan.goal)).toEqual(["A"]);
    expect(report.rejected).toEqual([
      "4 proposals, at most 2 allowed: the ones after 2 were dropped",
      "proposal 2: resolves_findings names a, already resolved by an earlier proposal",
    ]);
    expect(report.error).toBeNull();
    const { runner: r3 } = await run(ctx, [{ role: "harden", output: selection(item("C", ["c"]), item("B", ["b"])) }], new FakeGitHub(), false);
    expect(r3.calls[0]!.prompt).toContain("Up to 3 proposals");
  });

  it("invalid selection twice: no ticket, error, exit 1; a bad compaction is reported, not applied", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 }), entry("b", { count: 2 })]);
    const steps: FakeStep[] = [
      { role: "plan_medium", output: { merge: [{ keep: "a", drop: ["nope"] }] } },
      { role: "harden", output: { rationale: "x" } },
      { role: "harden", output: selection({ rationale: "", checklist: [], plan: PLAN("x", ["a"]) }) },
    ];
    const out: string[] = [];
    const code = await hardenCommand(
      { repo: ctx.repo, compact: true, json: true },
      { runner: new FakeRunner(steps), github: new FakeGitHub(), profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
    );
    expect(code).toBe(1);
    const report = HardenReportSchema.parse(JSON.parse(out.join("\n")));
    expect(report.error).toContain("invalid after retry: proposal 1: rationale is missing");
    expect(report.compaction.error).toContain("nope is not an open memory entry");
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(0);
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries.map((e) => e.status)).toEqual(["open", "open"]);
  });

  it("lifecycle per proposal: merged PR resolves, closed PR drops (entries reopen), stale drops, siblings stay open", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [
      entry("m", { status: "proposed", ref: "t-old.1" }),
      entry("c", { status: "proposed", ref: "t-old.2", count: 2 }),
      entry("o", { status: "proposed", ref: "t-old.3" }),
      entry("s", { status: "proposed", ref: "t-stale.1" }),
      entry("y", { status: "proposed", ref: "t-young.1" }),
    ]);
    const mk = (id: string, created: string, items: [string, string[]][]) =>
      writeProposal(ctx.factoryHome, {
        version: 1, kind: "harden", id, repo: ctx.repoId, created_at: created, signals: {}, metrics: {},
        proposals: items.map(([goal, findings]) => ({ status: "open" as const, rationale: "r", plan: PLAN(goal, findings), references: { findings, checklist: [] }, resolution: null })),
      });
    const old = mk("t-old", "2026-10-20T00:00:00Z", [["merged goal", ["m"]], ["closed goal", ["c", "y"]], ["pending goal", ["o"]]]);
    mk("t-stale", "2026-09-01T00:00:00Z", [["stale goal", ["s"]]]);
    mk("t-young", "2026-10-28T00:00:00Z", [["young goal", ["y"]]]);
    const gh = new FakeGitHub();
    // Matched by its plan file (task ref), although its goal was rewritten by the run's plan step.
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-21T00:00:00Z"), { pr: "https://github.com/o/r/pull/1", plan: PLAN("rewritten", []), taskRef: old.proposals[0]!.plan_path });
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-21T01:00:00Z"), { pr: "https://github.com/o/r/pull/2", plan: PLAN("closed goal", ["c"]) });
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-21T02:00:00Z"), { pr: "https://github.com/o/r/pull/3", plan: PLAN("pending goal", ["o"]) });
    gh.prStates.set("https://github.com/o/r/pull/1", { state: "merged", draft: false });
    gh.prStates.set("https://github.com/o/r/pull/2", { state: "closed", draft: false });
    gh.prStates.set("https://github.com/o/r/pull/3", { state: "open", draft: false });

    const { report, runner } = await run(ctx, [{ role: "plan_medium", output: { merge: [] } }, { role: "harden", output: selection(item("retry c", ["c"])) }], gh);
    expect(runner.remaining()).toEqual({});
    expect(report.lifecycle.map((l) => [l.id, l.status]).sort()).toEqual([["t-old.1", "resolved"], ["t-old.2", "dropped"], ["t-stale.1", "dropped"]]);
    const byId = Object.fromEntries(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals.map((p) => [p.id, p])));
    expect(byId["t-old.1"]!.resolution).toMatchObject({ status: "resolved", pr: "https://github.com/o/r/pull/1" });
    expect(byId["t-old.3"]!.status).toBe("open");
    expect(byId["t-young.1"]!.status).toBe("open");
    const mem = Object.fromEntries(loadMemory(ctx.factoryHome, ctx.repoId).entries.map((e) => [e.key, [e.status, e.ref]]));
    expect(mem.m).toEqual(["resolved", "https://github.com/o/r/pull/1"]);
    // c was reopened by the drop and is proposed again by the new ticket; s is open again.
    expect(mem.c).toEqual(["proposed", "2026-10-29.1"]);
    expect(mem.s![0]).toBe("open");
    expect(mem.o).toEqual(["proposed", "t-old.3"]);
    // y belongs to the newer ticket now; dropping t-old.2 leaves it alone.
    expect(mem.y).toEqual(["proposed", "t-young.1"]);
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
