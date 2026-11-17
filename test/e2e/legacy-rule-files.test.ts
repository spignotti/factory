import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { commitFile } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const STANDARDS = ".factory/standards.md";
const LEGACY = ".factory/review-rules.md";
// Only a severity section: no unmarked rule, so no model standards reviewer joins.
const SEVERITY_ONLY = "# Standards\n\n## Severity\n\n- severity-token: repo-specific\n";

const protect = (c: Record<string, unknown>) => void (c.human_only_paths = [".github/**", ".factory/**"]);

type Plan = { packages: { files: string[] }[]; protected_changes?: unknown[] };

/** wontfix.json with both rule files declared as protected changes; the findings come from the factory, not a model. */
function declared(steps: FakeStep[]): FakeStep[] {
  const plan = steps[0]!.output as Plan;
  plan.packages[0]!.files.push(STANDARDS, LEGACY);
  plan.protected_changes = [STANDARDS, LEGACY].map((file) => ({ file, change: "add the review rules", reason: "the task asks for them" }));
  (steps[2]!.output as { findings: unknown[] }).findings = [];
  return steps;
}

describe("legacy rule files that standards.md makes dead", () => {
  it("a run that adds .factory/review-rules.md next to standards.md gets a fix round that moves the rules", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      patch: protect,
      setup: (repo) => commitFile(repo, STANDARDS, SEVERITY_ONLY),
      steps: (steps) => {
        declared(steps);
        steps[1]!.writes = { ...steps[1]!.writes, [LEGACY]: "- No TODO comments\n" };
        steps[4]!.writes = { [STANDARDS]: `${SEVERITY_ONLY}\n## Rules\n\n- No TODO comments\n`, [LEGACY]: null };
        (steps[4]!.output as { responses: unknown[] }).responses = [{ finding_id: "R1-config-1", status: "fixed", response: "moved the rules into standards.md" }];
        (steps[5]!.output as { prior: unknown[] }).prior = [];
        return steps;
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 2 });
    const round1 = r.events.find((e) => e.event === "round_finished" && e.data.round === 1)!;
    expect(round1.data).toMatchObject({ open_bugs: 1, decision: { action: "fix" } });
    const fix = r.runner.calls.filter((c) => c.role === "implement")[1]!.prompt;
    expect(fix).toContain(".factory/review-rules.md is ignored because .factory/standards.md exists");
    expect(fix).toContain("## Severity");
    expect(fix).toContain("## Rules");
    expect(r.runner.remaining()).toEqual({});
  });

  it("deleting a legacy rule file stays allowed", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      patch: protect,
      setup: (repo) => {
        commitFile(repo, STANDARDS, SEVERITY_ONLY);
        commitFile(repo, LEGACY, "- old rule\n");
      },
      steps: (steps) => {
        declared(steps);
        steps[1]!.writes = { ...steps[1]!.writes, [LEGACY]: null };
        return steps.slice(0, 4).concat(steps[7]!);
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 1 });
    expect(r.runner.remaining()).toEqual({});
  });
});
