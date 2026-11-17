import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { commitFile } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const STANDARDS = ".factory/standards.md";
const LEGACY = ".factory/review-rules.md";
// Only a severity section: no unmarked rule, so no model standards reviewer joins.
const SEVERITY_ONLY = "# Standards\n\n## Severity\n\n- severity-token: repo-specific\n";
const WITH_RULE = `${SEVERITY_ONLY}\n## Rules\n\n- No TODO comments\n`;

type Plan = { packages: { files: string[] }[]; protected_changes?: unknown[] };

/** adopt's default: `.factory/**` is human-only. */
const protect = (c: Record<string, unknown>) => void (c.human_only_paths = [".github/**", ".factory/**"]);

const declare = (plan: Plan, file: string, change: string) => {
  plan.packages[0]!.files.push(file);
  plan.protected_changes = [...(plan.protected_changes ?? []), { file, change, reason: "the task asks for it" }];
};

describe("legacy rule files that standards.md makes dead", () => {
  it("a plan that edits review-rules.md next to standards.md is rejected; the planner retries with standards.md", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      patch: protect,
      setup: (repo) => commitFile(repo, STANDARDS, SEVERITY_ONLY),
      steps: (steps) => {
        const bad = structuredClone(steps[0]!);
        declare(bad.output as Plan, LEGACY, "add the review rules");
        const good = steps[0]!;
        declare(good.output as Plan, STANDARDS, "add the review rules under ## Rules");
        steps[1]!.writes = { ...steps[1]!.writes, [STANDARDS]: WITH_RULE };
        (steps[2]!.output as { findings: unknown[] }).findings = [];
        // The fix step and the second review round are not needed.
        return [bad, good, ...steps.slice(1, 4), steps[7]!];
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 1 });
    const rejected = r.events.find((e) => e.step === "plan" && (e.data.rejected as string[] | undefined)?.length);
    expect(JSON.stringify(rejected?.data.rejected)).toContain(`${LEGACY} is ignored because ${STANDARDS} exists`);
    expect(r.runner.remaining()).toEqual({});
  });

  it("backstop: a run that still writes review-rules.md next to standards.md gets a fix round that moves the rules", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      setup: (repo) => commitFile(repo, STANDARDS, SEVERITY_ONLY),
      steps: (steps) => {
        (steps[2]!.output as { findings: unknown[] }).findings = [];
        steps[1]!.writes = { ...steps[1]!.writes, [LEGACY]: "- No TODO comments\n" };
        steps[4]!.writes = { [STANDARDS]: WITH_RULE, [LEGACY]: null };
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

  it("the backstop also applies with review.checklist off", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      patch: (c) => void ((c.review as Record<string, unknown>).checklist = false),
      setup: (repo) => commitFile(repo, STANDARDS, SEVERITY_ONLY),
      steps: (steps) => {
        (steps[2]!.output as { findings: unknown[] }).findings = [];
        steps[1]!.writes = { ...steps[1]!.writes, [LEGACY]: "- No TODO comments\n" };
        steps[4]!.writes = { [LEGACY]: null };
        (steps[4]!.output as { responses: unknown[] }).responses = [{ finding_id: "R1-config-1", status: "fixed", response: "removed the dead file" }];
        (steps[5]!.output as { prior: unknown[] }).prior = [];
        return steps;
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 2 });
  });

  it("deleting a legacy rule file stays allowed, in the plan and in the diff", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      patch: protect,
      setup: (repo) => {
        commitFile(repo, STANDARDS, SEVERITY_ONLY);
        commitFile(repo, LEGACY, "- old rule\n");
      },
      steps: (steps) => {
        declare(steps[0]!.output as Plan, LEGACY, "delete the dead legacy file");
        steps[1]!.writes = { ...steps[1]!.writes, [LEGACY]: null };
        (steps[2]!.output as { findings: unknown[] }).findings = [];
        return steps.slice(0, 4).concat(steps[7]!) as FakeStep[];
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 1 });
    expect(r.runner.remaining()).toEqual({});
  });
});
