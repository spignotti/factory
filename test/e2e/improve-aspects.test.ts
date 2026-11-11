import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { improve } from "../../src/commands/improve.js";
import { FakeGitHub } from "../../src/gh.js";
import { canonicalRepoId } from "../../src/memory.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { entry, PLAN, seedMemory } from "../helpers/harden.js";
import { FIXTURES } from "../helpers/repo.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");

function home() {
  return mkdtempSync(join(tmpdir(), "factory-home-"));
}

function deps(factoryHome: string, role: string, output: unknown, gh: FakeGitHub) {
  return {
    runner: new FakeRunner([{ role, output }]),
    github: gh,
    profile: loadProfile(join(FIXTURES, "profile.yaml")),
    factoryHome,
    parentEnv: process.env,
    now: () => NOW.getTime(),
  };
}

const protectedPlan = (goal: string, file: string, resolves: string[] = []) => ({
  ...PLAN(goal, resolves),
  packages: [{ id: "P1", title: "change", description: "declared workflow edit", files: [file], depends_on: [], changes_flows: [] }],
  protected_changes: [{ file, change: "add path filters", reason: "the job is slow and has no path filter" }],
});

describe("improve ci and tests", () => {
  it("opens a ci issue from workflow signals, and only as protected_changes", async () => {
    const repo = makeRepo({
      ".factory/repo.yaml": "human_only_paths: [\".github/workflows/**\"]\nimprove:\n  aspects: [ci]\n",
      ".github/workflows/ci.yml": "name: CI\non: [pull_request, push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n",
    });
    const gh = new FakeGitHub();
    gh.runs = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      sha: `s${i}`,
      workflow: "CI",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-10-20T00:00:00Z",
      head_branch: "feature",
      jobs: [{ name: "build", conclusion: "success", seconds: 180 }],
    }));
    const plan = protectedPlan("Add path filters to CI", ".github/workflows/ci.yml");
    const d = deps(home(), "audit_performance", { proposals: [{ rationale: "build never failed and has no path filter.", plan }] }, gh);
    const report = await improve({ repo, aspects: ["ci"] }, d);
    expect(report.error).toBeNull();
    expect(d.runner.calls.map((c) => c.role)).toEqual(["audit_performance"]);
    expect(d.runner.calls[0]!.system).toContain("protected_changes");
    expect(d.runner.calls[0]!.prompt).toContain("slow_without_paths");
    expect(d.runner.calls[0]!.prompt).toContain("never_failed");
    expect(report.results[0]!.issues).toEqual([{ proposal_id: "2026-10-29-improve-ci.1", number: 1, action: "created" }]);
    const issue = gh.issues.get(1)!;
    expect(issue.labels).toEqual(expect.arrayContaining(["factory-proposal", "improve:ci"]));
    expect(issue.body).toContain("<!-- factory-proposal: ci:");
    const block = JSON.parse(/```factory-plan\n([\s\S]*?)```/.exec(issue.body)?.[1] ?? "");
    expect(block.protected_changes).toEqual([{ file: ".github/workflows/ci.yml", change: "add path filters", reason: "the job is slow and has no path filter" }]);
    expect(gh.ciQueries.some((q) => q.limit === 100)).toBe(true);
  });

  it("opens a tests issue from flaky memory and a never-failed test job", async () => {
    const repo = makeRepo({ ".factory/repo.yaml": "improve:\n  aspects: [tests]\n" });
    const factoryHome = home();
    seedMemory(factoryHome, canonicalRepoId("", repo), [entry("flaky:unit", { count: 2 })]);
    const gh = new FakeGitHub();
    gh.runs = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      sha: `s${i}`,
      workflow: "CI",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-10-20T00:00:00Z",
      jobs: [{ name: "unit", conclusion: "success", seconds: 12 }],
    }));
    const plan = PLAN("Stop the flaky unit check", ["flaky:unit"]);
    const d = deps(factoryHome, "harden", { proposals: [{ rationale: "unit is flaky in memory and never failed in CI.", plan }] }, gh);
    const report = await improve({ repo, aspects: ["tests"] }, d);
    expect(report.error).toBeNull();
    expect(d.runner.calls.map((c) => c.role)).toEqual(["harden"]);
    expect(d.runner.calls[0]!.system).toContain("Never lower");
    expect(d.runner.calls[0]!.prompt).toContain("flaky:unit");
    expect(d.runner.calls[0]!.prompt).toContain('"name": "unit"');
    expect(report.results[0]!.issues[0]).toMatchObject({ number: 1, action: "created" });
    expect(gh.issues.get(1)!.labels).toContain("improve:tests");
    expect(gh.issues.get(1)!.body).toContain("<!-- factory-proposal: tests:flaky:unit -->");
  });
});
