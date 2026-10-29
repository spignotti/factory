import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { runScenario } from "../helpers/scenario.js";

const REPO_YAML = ".factory/repo.yaml";

/** clean.json, with the plan declaring `file` a protected change and the implementer writing `content` there. */
function protectedRun(file: string, content: () => string, declare = true) {
  return (steps: FakeStep[]): FakeStep[] =>
    steps.map((s) => {
      if (s.role === "plan_high") {
        const plan = s.output as { packages: { files: string[] }[]; protected_changes?: unknown[] };
        plan.packages[0]!.files.push(file);
        if (declare) plan.protected_changes = [{ file, change: "add a red check", reason: "the task asks for it" }];
      }
      if (s.role === "implement") s.writes = { ...s.writes, [file]: content() };
      return s;
    });
}

/** The fixture's repo.yaml plus a check that always fails. */
function withRedCheck(repo: string): string {
  const cfg = parse(readFileSync(join(repo, REPO_YAML), "utf8")) as { checks: unknown[] };
  cfg.checks.push({ name: "red", run: "false", tier: "fast" });
  return stringify(cfg);
}

describe("protected config changes (human_only_paths)", () => {
  it("declared repo.yaml change: done, high risk, human review even with auto-merge on, label + diff in the PR, gates use the base config", async () => {
    let repoDir = "";
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.merge = { auto_merge_max_risk: "medium" }),
      before: (repo) => void (repoDir = repo),
      steps: protectedRun(REPO_YAML, () => withRedCheck(repoDir)),
    });
    // The branch adds a check that always fails; it must not judge its own run.
    expect(r.result).toMatchObject({ result: "done", risk: "high", merge_policy: "human_review" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.labels).toEqual([{ pr: r.github.prs[0]!.url, label: "factory:protected-config" }]);
    const body = r.github.prs[0]!.body;
    expect(body).toContain("## ⚠️ Changes protected config (CI / factory)");
    expect(body).toContain("`.factory/repo.yaml`: add a red check (why: the task asks for it)");
    expect(body).toMatch(/```diff\n[\s\S]*\+\s+- name: red[\s\S]*```/);
    expect(body).toMatch(/changes protected config \(CI \/ factory\): human approval required/);
    const gates = JSON.parse(r.file("gates-1.json")) as { checks: { name: string; status: string }[] };
    expect(gates.checks.map((c) => c.name)).not.toContain("red");
    expect(gates.checks.find((c) => c.name === "protected_paths")).toMatchObject({ status: "pass" });
  });

  it("undeclared protected file in the plan: the plan is rejected", async () => {
    const undeclared = protectedRun(".github/workflows/ci.yml", () => "on: push\n", false);
    // The planner gets one retry with the errors; both attempts leave the file undeclared.
    const r = await runScenario({ script: "clean.json", steps: (steps) => undeclared([steps[0]!, structuredClone(steps[0]!), ...steps.slice(1)]) });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/\.github\/workflows\/ci\.yml is under human_only_paths; declare it in protected_changes/);
  });

  it("repo.yaml loosening fails config_guard even when declared", async () => {
    let repoDir = "";
    const r = await runScenario({
      script: "clean.json",
      before: (repo) => void (repoDir = repo),
      steps: protectedRun(REPO_YAML, () => {
        const cfg = parse(readFileSync(join(repoDir, REPO_YAML), "utf8")) as { checks: { name: string }[] };
        cfg.checks = cfg.checks.filter((c) => c.name !== "unit");
        return stringify(cfg);
      }),
    });
    const gates = JSON.parse(r.file("gates-1.json")) as { checks: { name: string; status: string; output_tail: string }[] };
    const guard = gates.checks.find((c) => c.name === "config_guard")!;
    expect(guard.status).toBe("fail");
    expect(guard.output_tail).toMatch(/check unit removed \(loosens the factory's own checks/);
    expect(r.result.result).not.toBe("done");
  });

  it("an uncommitted repo.yaml edit in the checkout is ignored: the base commit's config runs", async () => {
    const r = await runScenario({
      script: "clean.json",
      before: (repo) => writeFileSync(join(repo, REPO_YAML), withRedCheck(repo)),
    });
    expect(r.result).toMatchObject({ result: "done" });
    expect(r.eventsText).toContain("checkout differs from base");
  });
});
