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
  it("a scope-expansion claim is an ordinary finding: the fix round answers it and the run goes on", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => {
        const at = steps.findIndex((s) => s.role === "pr_writer");
        const review = steps.find((s) => s.role === "review_plan")!;
        review.output = {
          reviewer: "plan",
          prior: [],
          findings: [{ severity: "bug", file: "", line: 0, claim: "scope expansion: also add divide()", evidence: "task", fix: "implement divide" }],
        };
        const fix: FakeStep = {
          role: "implement",
          output: { package: "fix", done: ["fix round"], responses: [{ finding_id: "R1-plan-1", status: "wontfix", response: "the task asks only for multiply" }] },
        };
        const accept: FakeStep = { role: "review_plan", output: { reviewer: "plan", prior: [{ finding_id: "R1-plan-1", verdict: "accept_wontfix" }], findings: [] } };
        return [...steps.slice(0, at), fix, accept, emptyReview("review_simplicity"), ...steps.slice(at)];
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.resultFile.stop).toBeUndefined();
    expect(r.result.reason).not.toMatch(/scope expansion needs a decision/);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(2);
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
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/^open bug on the final tree.*; resolver: /s);
    expect(r.github.autoMerged).toEqual([]);
  });

  it("V12: resume of an unchanged commit with an open bug does not review it again", async () => {
    const r = await runScenario({ script: "bug-max-rounds.json" });
    expect(r.result.result).toBe("failed");
    const before = readState(r.runDir).reviewed_sha;
    expect(before).toBeTruthy();
    const r2 = await resumeScenario(r, { script: "clean.json", steps: (steps) => steps.filter((s) => s.role === "pr_writer") });
    // The reviewers are not asked again; the open bug goes to the resolver, whose turns are spent.
    expect(r2.runner.calls.map((c) => c.role)).toEqual([]);
    expect(r2.result.result).toBe("failed");
    expect(r2.result.reason).toMatch(/^open bug on the reviewed commit.*; resolver: no resolver turn left \(2\/2\)$/s);
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
