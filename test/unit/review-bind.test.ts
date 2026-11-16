import { describe, expect, it } from "vitest";
import { invalidateAffected, reviewCoversHead } from "../../src/pipeline/review-bind.js";
import { ReviewOutputSchema } from "../../src/schemas/review.js";

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
