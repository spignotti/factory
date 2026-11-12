import { describe, expect, it } from "vitest";
import { settlePlanDispute } from "../../src/pipeline/plan-authority.js";
import { invalidateAffected, reviewCoversHead } from "../../src/pipeline/review-bind.js";
import { correctInventedRestrictions, dropStalePlanPaths, type Plan } from "../../src/schemas/plan.js";
import { ReviewOutputSchema } from "../../src/schemas/review.js";

function plan(over: Partial<Plan> = {}): Plan {
  return {
    version: 1,
    type: "feature",
    goal: "Add a multiply function",
    context: "",
    packages: [{ id: "P1", title: "multiply", description: "Add multiply to src/math.js", files: ["src/math.js", "src/old-math.js"], depends_on: [], changes_flows: [] }],
    acceptance: [{ id: "A1", package: "P1", text: "only test/multiply.test.js", verify: "test", kind: "behavior", risk: false }],
    out_of_scope: ["only src/legacy.js"],
    resolves_findings: [],
    protected_changes: [],
    ...over,
  };
}

const bug = (id: string, claim: string, reviewer = "plan") => ({ id, reviewer, severity: "bug", status: "open", claim });

describe("plan authority", () => {
  const task = "Add a multiply function to src/math.js.\nmultiply(2, 3) returns 6.";

  it("V11: an invented only-path restriction is removed and the goal stays", () => {
    const edited = correctInventedRestrictions(plan(), task);
    expect(edited.notes.join("\n")).toMatch(/only test\/multiply.test.js/);
    expect(edited.notes.join("\n")).toMatch(/only src\/legacy.js/);
    expect(edited.plan.acceptance[0]!.text).toBe("Add a multiply function");
    expect(edited.plan.out_of_scope).toEqual([]);
    expect(edited.plan.goal).toBe("Add a multiply function");
    expect(correctInventedRestrictions(edited.plan, task).notes).toEqual([]);
  });

  it("drops a stale path the task does not name and keeps a real file", () => {
    const edited = dropStalePlanPaths(plan(), task, (file) => file === "src/math.js", "src/old-math.js is not in the tree");
    expect(edited.plan.packages[0]!.files).toEqual(["src/math.js"]);
    expect(edited.notes).toEqual(["dropped stale path src/old-math.js from P1"]);
  });

  it("does not empty the package or drop a path the task names", () => {
    const only = plan({ packages: [{ id: "P1", title: "multiply", description: "", files: ["src/old-math.js"], depends_on: [], changes_flows: [] }] });
    expect(dropStalePlanPaths(only, task, () => false, "src/old-math.js is not in the tree").notes).toEqual([]);
    const named = plan();
    expect(dropStalePlanPaths(named, `${task}\nsrc/old-math.js`, () => false, "src/old-math.js is not in the tree").notes).toEqual([]);
  });

  it("V11: a reviewer dispute corrects the plan once; a scope expansion is a decision", () => {
    const restriction = settlePlanDispute(plan(), task, [bug("R1-plan-1", "the plan is stricter than the task: only test/multiply.test.js")], () => true);
    expect(restriction.decision).toBeUndefined();
    expect(restriction.resolvedIds).toEqual(["R1-plan-1"]);
    expect(restriction.plan.acceptance[0]!.text).toBe("Add a multiply function");
    expect(settlePlanDispute(restriction.plan, task, [bug("R2-plan-1", "the plan is stricter than the task: only test/multiply.test.js")], () => true).decision).toMatch(/unchanged plan dispute/);

    const expansion = settlePlanDispute(plan(), task, [bug("R1-plan-1", "scope expansion: also add divide()")], () => true);
    expect(expansion.decision).toMatch(/scope expansion needs a decision/);
    expect(expansion.plan.acceptance[0]!.text).toBe("only test/multiply.test.js");
    expect(expansion.resolvedIds).toEqual([]);
  });

  it("a stale-path dispute drops the missing file and leaves an ordinary bug open", () => {
    const settled = settlePlanDispute(
      plan(),
      task,
      [bug("R1-plan-1", "src/old-math.js is not in the tree"), bug("R1-simplicity-1", "rename the helper", "simplicity")],
      (file) => file === "src/math.js",
    );
    expect(settled.resolvedIds).toEqual(["R1-plan-1"]);
    expect(settled.plan.packages[0]!.files).toEqual(["src/math.js"]);
    expect(settled.decision).toBeUndefined();
  });
});

describe("review binding", () => {
  it("V12: an unchanged clean commit is not reviewed again, and an open bug on it still blocks", () => {
    expect(reviewCoversHead(undefined, "aaa", 0)).toBe("review");
    expect(reviewCoversHead("aaa", "bbb", 0)).toBe("review");
    expect(reviewCoversHead("aaa", "aaa", 0)).toBe("skip_clean");
    expect(reviewCoversHead("aaa", "aaa", 1)).toBe("block_bug");
  });

  it("V12: a moved file reopens its review; an untouched file keeps its verdict", () => {
    const findings = [
      { file: "src/math.js", status: "resolved" },
      { file: "test/multiply.test.js", status: "resolved" },
      { file: "", status: "accepted_wontfix" },
      { file: "src/math.js", status: "open" },
    ];
    expect(invalidateAffected(findings, ["src/math.js"])).toEqual([
      { file: "src/math.js", status: "open" },
      { file: "test/multiply.test.js", status: "resolved" },
      { file: "", status: "open" },
      { file: "src/math.js", status: "open" },
    ]);
    expect(invalidateAffected(findings, [])).toEqual(findings);
  });

  it("a reviewer cannot widen merge permission by naming a policy", () => {
    const parsed = ReviewOutputSchema.parse({
      reviewer: "plan",
      prior: [],
      findings: [],
      merge_policy: "auto",
    });
    expect(parsed).not.toHaveProperty("merge_policy");
    expect(parsed.reviewer).toBe("plan");
  });
});
