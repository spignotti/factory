import { describe, expect, it } from "vitest";
import { quoteOccursIn, validatePlan } from "../../src/schemas/plan.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const repo = parseRepoConfig(`
sensitive_paths: ["src/auth/**"]
verify:
  areas:
    - { name: tours, paths: ["src/tours/**"], guide: ".factory/verify/tours.md" }
`);

function plan(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: "feature",
    goal: "Add sum",
    packages: [{ id: "P1", title: "sum", files: ["src/math.js"], source_quote: "add a sum function" }],
    acceptance: [
      { id: "A1", package: "P1", text: "sum adds", verify: "test", kind: "behavior", source_quote: "sum(1, 2) returns 3" },
    ],
    ...overrides,
  };
}

const errorsOf = (raw: unknown, sourceText?: string) => {
  const r = validatePlan(raw, { repo, sourceText });
  return r.ok ? [] : r.errors;
};

describe("plan validation", () => {
  it("accepts a valid plan", () => {
    expect(errorsOf(plan())).toEqual([]);
  });

  it("rejects schema violations", () => {
    expect(errorsOf({ version: 1, type: "feature" }).length).toBeGreaterThan(0);
  });

  it("requires unique ids, known deps and at least one criterion per package", () => {
    const errs = errorsOf(
      plan({
        packages: [
          { id: "P1", title: "a" },
          { id: "P1", title: "b" },
          { id: "P2", title: "c", depends_on: ["P9"] },
        ],
      }),
    );
    expect(errs).toContain("duplicate package id P1");
    expect(errs).toContain("P2: depends_on unknown P9");
    expect(errs).toContain("P2: no acceptance criterion");
  });

  it("rejects cycles", () => {
    const errs = errorsOf(
      plan({
        packages: [
          { id: "P1", title: "a", depends_on: ["P2"] },
          { id: "P2", title: "b", depends_on: ["P1"] },
        ],
        acceptance: [
          { id: "A1", package: "P1", text: "x", verify: "review" },
          { id: "A2", package: "P2", text: "y", verify: "review" },
        ],
      }),
    );
    expect(errs.some((e) => e.startsWith("dependency cycle"))).toBe(true);
  });

  it("limits packages and files", () => {
    const pkgs = Array.from({ length: 9 }, (_, i) => ({ id: `P${i}`, title: "t" }));
    const acc = pkgs.map((p, i) => ({ id: `A${i}`, package: p.id, text: "x", verify: "review" }));
    expect(errorsOf(plan({ packages: pkgs, acceptance: acc }))).toContain("more than 8 packages");
    const files = Array.from({ length: 9 }, (_, i) => `f${i}`);
    expect(errorsOf(plan({ packages: [{ id: "P1", title: "t", files }] }))).toContain("P1: more than 8 files");
  });

  it("allows verify:evaluator only with ui", () => {
    const errs = errorsOf(plan({ acceptance: [{ id: "A1", package: "P1", text: "x", verify: "evaluator" }] }));
    expect(errs).toContain("A1: verify:evaluator requires ui in repo.yaml");
  });

  describe("bug requires repro", () => {
    it("rejects a bug plan without repro criterion in the first package", () => {
      expect(errorsOf(plan({ type: "bug" }))).toContain(
        "type bug: first package needs a kind:repro, verify:test criterion",
      );
    });
    it("rejects a repro that is not verify:test", () => {
      const acc = [{ id: "A1", package: "P1", text: "x", verify: "review", kind: "repro" }];
      expect(errorsOf(plan({ type: "bug", acceptance: acc })).length).toBe(1);
    });
    it("rejects a repro only in a later package", () => {
      const errs = errorsOf(
        plan({
          type: "bug",
          packages: [
            { id: "P1", title: "a" },
            { id: "P2", title: "b", depends_on: ["P1"] },
          ],
          acceptance: [
            { id: "A1", package: "P1", text: "x", verify: "test" },
            { id: "A2", package: "P2", text: "y", verify: "test", kind: "repro" },
          ],
        }),
      );
      expect(errs).toContain("type bug: first package needs a kind:repro, verify:test criterion");
    });
    it("accepts a bug plan with repro in the first package", () => {
      const acc = [{ id: "A1", package: "P1", text: "x", verify: "test", kind: "repro" }];
      expect(errorsOf(plan({ type: "bug", acceptance: acc }))).toEqual([]);
    });
  });

  describe("risk rule", () => {
    const sensitive = [{ id: "P1", title: "auth", files: ["src/auth/login.js"] }];
    it("rejects sensitive packages without risk edge-case test", () => {
      expect(errorsOf(plan({ packages: sensitive }))).toContain(
        "P1: touches sensitive_paths, needs a kind:edge_case, verify:test, risk:true criterion",
      );
    });
    it("accepts sensitive packages with risk edge-case test", () => {
      const acc = [{ id: "A1", package: "P1", text: "x", verify: "test", kind: "edge_case", risk: true }];
      expect(errorsOf(plan({ packages: sensitive, acceptance: acc }))).toEqual([]);
    });
    it("does not count an edge case without risk:true", () => {
      const acc = [{ id: "A1", package: "P1", text: "x", verify: "test", kind: "edge_case" }];
      expect(errorsOf(plan({ packages: sensitive, acceptance: acc })).length).toBe(1);
    });
  });

  describe("changes_flows", () => {
    it("accepts known verify areas", () => {
      expect(errorsOf(plan({ packages: [{ id: "P1", title: "t", changes_flows: ["tours"] }] }))).toEqual([]);
    });
    it("rejects unknown verify areas", () => {
      expect(errorsOf(plan({ packages: [{ id: "P1", title: "t", changes_flows: ["billing"] }] }))).toContain(
        "P1: changes_flows names unknown verify area billing",
      );
    });
  });

  describe("source_quote fidelity", () => {
    const text = "Please add a sum function.\nExample: sum(1, 2)\n returns 3.";
    it("accepts verbatim quotes (whitespace-tolerant)", () => {
      expect(errorsOf(plan(), text)).toEqual([]);
    });
    it("rejects quotes not in the task text", () => {
      const p = plan({
        acceptance: [{ id: "A1", package: "P1", text: "x", verify: "test", source_quote: "and also a product function" }],
      });
      expect(errorsOf(p, text)).toEqual(["A1: source_quote not found in task text"]);
    });
    it("rejects missing quotes when fidelity is required", () => {
      const p = plan({ packages: [{ id: "P1", title: "t" }] });
      expect(errorsOf(p, text)).toEqual(["P1: source_quote missing"]);
    });
    it("does not check quotes for plan-step output", () => {
      expect(errorsOf(plan({ packages: [{ id: "P1", title: "t" }] }))).toEqual([]);
    });
    it("quoteOccursIn ignores empty quotes", () => {
      expect(quoteOccursIn("  ", "abc")).toBe(false);
    });
  });
});
