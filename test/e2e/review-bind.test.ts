import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { readState } from "../../src/pipeline/state.js";
import { commitFile } from "../helpers/repo.js";
import { resumeScenario, runScenario } from "../helpers/scenario.js";

const emptyReview = (role: "review_plan" | "review_simplicity" | "review_security"): FakeStep => ({
  role,
  output: { reviewer: role.replace("review_", ""), prior: [], findings: [] },
});

describe("F04 review binding", () => {
  it("V11: an invented plan restriction is corrected once and does not start a dispute round", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => {
        const plan = steps[0]!.output as { acceptance: { text: string }[] };
        plan.acceptance[0]!.text = "only test/multiply.test.js";
        const review = steps.find((s) => s.role === "review_plan")!;
        review.output = {
          reviewer: "plan",
          prior: [],
          findings: [{ severity: "bug", file: "src/math.js", line: 1, claim: "the plan is stricter than the task: only test/multiply.test.js", evidence: "plan", fix: "drop the restriction" }],
        };
        return steps;
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.filter((c) => c.role === "review_plan")).toHaveLength(1);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    const saved = JSON.parse(r.file("plan.json")) as { acceptance: { text: string }[] };
    expect(saved.acceptance[0]!.text).toBe("Add a multiply function");
    expect(saved.acceptance[0]!.text).not.toContain("only test/multiply.test.js");
    expect(r.events.some((e) => Array.isArray(e.data.plan_corrected))).toBe(true);
  });

  it("V11: a scope expansion stays a decision and does not change the plan", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => {
        const review = steps.find((s) => s.role === "review_plan")!;
        review.output = {
          reviewer: "plan",
          prior: [],
          findings: [{ severity: "bug", file: "", line: 0, claim: "scope expansion: also add divide()", evidence: "task", fix: "implement divide" }],
        };
        return steps;
      },
    });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/scope expansion needs a decision/);
    expect(r.runner.calls.filter((c) => c.role === "review_plan")).toHaveLength(1);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    const saved = JSON.parse(r.file("plan.json")) as { acceptance: { text: string }[]; packages: { files: string[] }[] };
    expect(JSON.stringify(saved)).not.toContain("divide");
  });

  it("V12: an open bug on the delta after a base merge blocks the merge", async () => {
    let moved = false;
    const r = await runScenario({
      script: "clean.json",
      onCall: (req, repo) => {
        if (moved || !req.role.startsWith("review_")) return;
        moved = true;
        commitFile(repo, "src/other.js", "export const other = 1;\n", "main moved");
      },
      steps: (steps) => {
        const at = steps.findIndex((s) => s.role === "pr_writer");
        const bug: FakeStep = {
          role: "review_plan",
          output: {
            reviewer: "plan",
            prior: [],
            findings: [{ severity: "bug", file: "src/other.js", line: 1, claim: "other.js exports a constant the task does not ask for", evidence: "diff", fix: "drop it" }],
          },
        };
        return [...steps.slice(0, at), bug, emptyReview("review_simplicity"), ...steps.slice(at)];
      },
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/open bug on the final tree/);
    expect(r.github.autoMerged).toEqual([]);
  });

  it("V12: resume of an unchanged commit with an open bug does not review it again", async () => {
    const r = await runScenario({ script: "bug-max-rounds.json" });
    expect(r.result.result).toBe("needs_human");
    const before = readState(r.runDir).reviewed_sha;
    expect(before).toBeTruthy();
    const r2 = await resumeScenario(r, { script: "clean.json", steps: (steps) => steps.filter((s) => s.role === "pr_writer") });
    expect(r2.runner.calls.map((c) => c.role)).toEqual(["pr_writer"]);
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/open bug on the reviewed commit/);
    expect(readState(r.runDir).reviewed_sha).toBe(before);
    expect(readFileSync(join(r.runDir, "worktree", "src/math.js"), "utf8")).toContain("multiply");
  });

  it("a review that names merge_policy auto does not widen a human_review run", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.status = "green";
      },
      steps: (steps) =>
        steps.map((s) =>
          s.role === "review_plan" || s.role === "review_simplicity"
            ? { ...s, output: { ...(s.output as object), merge_policy: "auto" } }
            : s,
        ),
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "human_review" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.file("review-1-plan.json")).not.toContain("merge_policy");
  });
});
