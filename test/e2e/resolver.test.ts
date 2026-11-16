import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import type { FakeGitHub } from "../../src/gh.js";
import { readState } from "../../src/pipeline/state.js";
import { commitFile, FIXTURES, gitIn as git } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");
const GOOD_MATH = "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
const TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n';

function withIssue(gh: FakeGitHub): void {
  gh.issues.set(7, { number: 7, title: "Multiply", body, labels: ["factory-ready"] });
}

function resolve(writes?: Record<string, string>, outcome: "fixed" | "approach_wrong" = "fixed", reason = ""): FakeStep {
  return { role: "resolve", ...(writes ? { writes } : {}), output: { outcome, summary: "resolved the stop", reason } };
}

/** Repeats each reviewer and pr_writer step `times` times (one per review pass). */
function repeatReviews(steps: FakeStep[], times: number): FakeStep[] {
  return steps.flatMap((s) => (["review_plan", "review_simplicity", "pr_writer"].includes(s.role) ? Array.from({ length: times }, () => s) : [s]));
}

describe("resolver on a technical stop", () => {
  it("a spent gate repair budget is resolved by one resolver turn and the run ends done", async () => {
    const r = await runScenario({
      script: "gate-fail-fix.json",
      steps: (steps) => {
        const broken = steps.filter((s) => s.role === "implement")[0]!;
        const rest = steps.filter((s) => s.role !== "implement");
        return [...rest.slice(0, 1), broken, broken, broken, resolve({ "src/math.js": GOOD_MATH, "test/multiply.test.js": TEST }), ...rest.slice(1)];
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.remaining()).toEqual({});
    const turn = r.runner.calls.find((c) => c.role === "resolve")!;
    expect(turn.tools).toBe("coding");
    expect(turn.cwd).toBe(join(r.runDir, "worktree"));
    expect(turn.prompt).toContain("packages not done: P1 failed");
    expect(turn.prompt).toContain("Packages not done: P1");
    expect(turn.prompt).toContain("<gate_failures>");
    expect(turn.prompt).toContain("<diff_since_base>");
    expect(readState(r.runDir).resolver_turns).toBe(1);
    expect(readState(r.runDir).packages).toEqual({ P1: "done" });
    expect(r.github.prs).toHaveLength(1);
  });

  it("a review stalemate goes to the resolver, then finalize reviews its commit as a delta", async () => {
    const r = await runScenario({
      script: "stalemate.json",
      steps: (steps) => {
        const out: FakeStep[] = [];
        for (const s of steps) {
          if (s.role === "pr_writer") out.push(resolve({ "src/math.js": `${GOOD_MATH}// negative zero is fine for this task\n` }));
          out.push(s);
        }
        const resolved = { role: "review_plan", output: { reviewer: "plan", prior: [{ finding_id: "R1-plan-1", verdict: "resolved" }], findings: [] } };
        const simple = { role: "review_simplicity", output: { reviewer: "simplicity", prior: [], findings: [] } };
        return [...out, resolved, simple];
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.remaining()).toEqual({});
    const turn = r.runner.calls.find((c) => c.role === "resolve")!;
    expect(turn.prompt).toMatch(/stalemate/);
    expect(turn.prompt).toContain("R1-plan-1");
    expect(r.runner.calls.map((c) => c.role).slice(-4)).toEqual(["resolve", "review_plan", "review_simplicity", "pr_writer"]);
    // The delta review sees the resolver's account next to the finding it answered.
    expect(r.runner.calls.filter((c) => c.role === "review_plan").at(-1)!.prompt).toContain("resolver: resolved the stop");
  });

  it("a resolver turn that changes nothing does not clear open findings: the run fails instead of skipping review", async () => {
    const r = await runScenario({
      script: "stalemate.json",
      github: (gh) => {
        gh.settings.required_checks = ["done"];
        gh.status = "green";
      },
      patch: (c) => void (c.merge = { auto_merge_max_risk: "medium", policy: { low: "bot_review", medium: "bot_review" } }),
      steps: (steps) => [...steps.filter((s) => s.role !== "pr_writer"), resolve(), resolve()],
    });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/^stalemate.*; resolver: the resolver changed nothing, so the open review findings still stand$/s);
    const turns = r.runner.calls.filter((c) => c.role === "resolve");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("<previous_resolver_turn>");
    expect(r.runner.calls.at(-1)!.role).toBe("resolve");
    expect(r.github.prs).toEqual([]);
    expect(r.github.autoMerged).toEqual([]);
  });

  it("red CI after ready goes to the resolver with the logs; two turns that do not fix it end failed and reported", async () => {
    let checks = 0;
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 7 },
      patch: (cfg) => void (cfg.merge = { auto_merge_max_risk: "low" }),
      github: (gh) => {
        withIssue(gh);
        gh.baseStatus = async () => (checks++ === 0 ? "none" : "red");
        gh.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
      },
      steps: (steps) => [
        ...repeatReviews(steps, 3),
        resolve({ "src/math.js": `${GOOD_MATH}// first try\n` }),
        resolve({ "src/math.js": `${GOOD_MATH}// second try\n` }),
      ],
    });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/^CI on the PR head \([0-9a-f]{8}\) is red; resolver: no resolver turn left \(2\/2\)/);
    expect(r.resultFile.stop).toBeUndefined();
    expect(r.runner.remaining()).toEqual({});
    const turns = r.runner.calls.filter((c) => c.role === "resolve");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toContain("<ci_failures>");
    expect(turns[0]!.prompt).toContain("CI-only boundary is wrong");
    expect(r.github.autoMerged).toEqual([]);
    // Reported on the issue: comment once, labels swapped, the run's own PR closed.
    const pr = r.github.prs[0]!.url;
    expect(r.github.prs).toHaveLength(1);
    expect(r.github.closed).toEqual([pr]);
    expect(r.resultFile.failure_reported).toBe(true);
    expect(r.github.issues.get(7)!.labels).toEqual(["factory-failed"]);
    const comments = r.github.comments.get(7)!;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("The factory gave up on this issue");
    expect(comments[0]!.body).toMatch(/\*\*Why:\*\* CI on the PR head \([0-9a-f]{8}\) is red \(resolver: no resolver turn left \(2\/2\)\)/);
    expect(comments[0]!.body).toContain("<details><summary>Full reason");
    expect(comments[0]!.body).toContain(`Its pull request ${pr} is closed.`);
    expect(comments[0]!.body).toContain("rewrite the ticket");
    expect(comments[0]!.body).toContain(`<!-- factory:failed run=${r.runId} -->`);
  });

  it("a base merge conflict: the factory starts the merge, the resolver resolves the markers, the factory commits it", async () => {
    let moved = false;
    const divide = "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function divide(a, b) {\n  return a / b;\n}\n";
    const both = `${divide}\nexport function multiply(a, b) {\n  return a * b;\n}\n`;
    const r = await runScenario({
      script: "clean.json",
      onCall: (req, repo) => {
        if (moved || !req.role.startsWith("review_")) return;
        moved = true;
        commitFile(repo, "src/math.js", divide, "main moved");
      },
      steps: (steps) => [...repeatReviews(steps, 2), resolve({ "src/math.js": both })],
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.remaining()).toEqual({});
    const turn = r.runner.calls.find((c) => c.role === "resolve")!;
    expect(turn.prompt).toContain("These files have conflict markers; resolve every one: src/math.js");
    const wt = join(r.runDir, "worktree");
    expect(git(wt, "log", "--format=%s", "-3")).toContain("chore: merge main into");
    expect(git(wt, "merge-base", "--is-ancestor", "main", "HEAD")).toBe("");
    expect(readFileSync(join(wt, "src/math.js"), "utf8")).toBe(both);
    expect(r.github.prs[0]!.draft).toBe(true);
    expect(r.github.readied).toEqual([r.github.prs[0]!.url]);
  });

  it("the resolver may declare the approach wrong; the run fails at once with that reason", async () => {
    const r = await runScenario({
      script: "stalemate.json",
      options: { issue: 7 },
      github: withIssue,
      steps: (steps) => [...steps.filter((s) => s.role !== "pr_writer"), resolve(undefined, "approach_wrong", "the task needs a bigint multiply, not a number one")],
    });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/stalemate.*; resolver: the approach is wrong: the task needs a bigint multiply/s);
    expect(readState(r.runDir).resolver_turns).toBe(1);
    expect(r.github.comments.get(7)![0]!.body).toContain("bigint multiply");
    expect(r.github.prs).toEqual([]);
  });

  it("a hard-list run still ends done with a ready PR that waits for a human and reports nothing", async () => {
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 7 },
      github: (gh) => {
        withIssue(gh);
        gh.settings.required_checks = ["done"];
        gh.status = "green";
      },
      patch: (c) => void (c.merge = { auto_merge_max_risk: "medium", policy: { low: "bot_review", medium: "bot_review" } }),
      steps: (steps) => {
        const plan = steps[0]!.output as { packages: { files: string[] }[] };
        plan.packages[0]!.files.push("db/migrations/001_add_table.sql");
        const impl = steps.find((s) => s.role === "implement")!;
        impl.writes = { ...impl.writes, "db/migrations/001_add_table.sql": "create table t (id int);\n" };
        return steps;
      },
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "human_review" });
    expect(r.github.prStates.get(r.github.prs[0]!.url)).toMatchObject({ state: "open", draft: false });
    expect(r.resultFile).not.toHaveProperty("failure_reported");
    expect(r.github.closed).toEqual([]);
    expect(r.github.comments.get(7)).toBeUndefined();
    expect(r.github.issues.get(7)!.labels).toEqual(["factory-ready"]);
  });

  it("a --no-pr run that fails writes nothing to GitHub", async () => {
    const r = await runScenario({
      script: "stalemate.json",
      options: { issue: 7, noPr: true },
      github: withIssue,
      steps: (steps) => [...steps.filter((s) => s.role !== "pr_writer"), resolve(undefined, "approach_wrong", "no")],
    });
    expect(r.result.result).toBe("failed");
    expect(r.resultFile).not.toHaveProperty("failure_reported");
    expect(r.github.comments.get(7)).toBeUndefined();
  });
});
