import { describe, expect, it } from "vitest";
import { normalizeRetryNote, planFieldSchema, planReviewNotes, quoteOccursIn, RED_GREEN_NA_LABEL, redGreenDecision, scopeNarrowingWarnings, validatePlan } from "../../src/schemas/plan.js";
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

describe("repo config: review", () => {
  it("has no per-package review option (review runs once over the whole diff)", () => {
    expect(parseRepoConfig("").review).toEqual({ max_rounds: 2, checklist: true, skip_paths: [], max_nits: 5 });
    expect(parseRepoConfig("").concurrency).toEqual({ max_runs: 1, exclusive_paths: [] });
    expect(parseRepoConfig("").pr).toBeUndefined();
    expect(parseRepoConfig('pr: { host_steps_section: "Mac install steps" }\n').pr).toEqual({ host_steps_section: "Mac install steps" });
    // An old repo.yaml that still sets it parses; the key is dropped.
    expect(parseRepoConfig("review:\n  per_package: true\n").review).not.toHaveProperty("per_package");
  });
});

describe("out_of_scope items", () => {
  const scope = (items: unknown[]) => {
    const r = validatePlan(plan({ out_of_scope: items }), { repo });
    return r.ok ? r.plan.out_of_scope : r.errors;
  };

  it("keeps strings and folds {file, change, reason} objects into one string", () => {
    expect(scope(["plain", { file: ".github/workflows/ci.yml", change: "drop the lint job" }, { file: ".factory/repo.yaml", change: "add gitleaks", reason: "human-only" }, { change: "no file" }])).toEqual([
      "plain",
      ".github/workflows/ci.yml: drop the lint job",
      ".factory/repo.yaml: add gitleaks (human-only)",
      "no file",
    ]);
  });

  it("still rejects objects without a change text and other types", () => {
    const errors = scope([{ file: "x" }, 3]) as string[];
    expect(errors.join("; ")).toMatch(/out_of_scope\.0/);
    expect(errors.join("; ")).toMatch(/out_of_scope\.1/);
  });
});

describe("scope narrowing warnings", () => {
  const narrowed = () => {
    const r = validatePlan(
      plan({
        acceptance: [{ id: "A6", package: "P1", text: "only tests/test_web.py", verify: "test" }],
        out_of_scope: ["touch only src/app.py"],
      }),
      { repo },
    );
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.plan;
  };

  it("flags only-path restrictions the task does not state, and does not fail the plan", () => {
    const p = narrowed();
    expect(scopeNarrowingWarnings(p, "The issue allows tests/test_web.py and a minimal production seam.")).toEqual([
      "A6: restricts to only tests/test_web.py, which the task text does not say",
      "out_of_scope[0]: restricts to only src/app.py, which the task text does not say",
    ]);
    expect(errorsOf(plan({ acceptance: [{ id: "A6", package: "P1", text: "only tests/test_web.py", verify: "test" }] }))).toEqual([]);
  });

  it("stays quiet when the task states the same restriction, and ignores only-when", () => {
    expect(scopeNarrowingWarnings(narrowed(), "Change only tests/test_web.py. Also touch only src/app.py.")).toEqual([]);
    const r = validatePlan(plan({ acceptance: [{ id: "A1", package: "P1", text: "only when the input is empty", verify: "test" }] }), { repo });
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(scopeNarrowingWarnings(r.plan, "no paths here")).toEqual([]);
  });

  it("tells the plan reviewer about the warning and a red-green loosening", () => {
    const r = validatePlan(
      plan({
        type: "bug",
        acceptance: [{ id: "A6", package: "P1", text: "only tests/test_web.py", verify: "test", kind: "repro" }],
        red_green: "not_applicable",
        red_green_reason: "the assertion cannot fail on base without a production seam",
      }),
      { repo },
    );
    if (!r.ok) throw new Error(r.errors.join("; "));
    const notes = planReviewNotes(r.plan, "A minimal production seam is allowed.");
    expect(notes).toContain("A6: restricts to only tests/test_web.py");
    expect(notes).toContain("red_green loosening: not_applicable");
    expect(notes).toContain("the assertion cannot fail on base");
  });
});

describe("plan_normalize retry note", () => {
  it("shows the zod path and the JSON schema of a string acceptance item, which the first prompt never had", () => {
    const raw = {
      version: 1,
      type: "feature",
      goal: "Add sum",
      packages: [{ title: "sum" }],
      acceptance: ["sum(1, 2) returns 3"],
    };
    const errors = errorsOf(raw);
    const note = normalizeRetryNote(errors);
    expect(note).toContain("Return only one ```json block and no other text.");
    expect(note).toMatch(/acceptance\.0:.*expected object, received string/);
    expect(note).toContain("JSON schema for the failing fields:");
    expect(note).toContain("acceptance[]:");
    const acceptance = planFieldSchema("acceptance.0") as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(acceptance.type).toBe("object");
    expect(acceptance.required).toEqual(expect.arrayContaining(["id", "package", "text", "verify"]));
    expect(JSON.stringify(acceptance.properties?.verify)).toContain("test");
    expect(note).toContain(JSON.stringify(acceptance));
    expect(note).toMatch(/packages\.0\.id:/);
    expect(note).toContain("packages[].id:");
    expect(normalizeRetryNote(["A2: source_quote not found in task text"])).not.toContain("JSON schema for the failing fields:");
  });
});

describe("red_green exemption", () => {
  const bug = () => plan({ type: "bug", acceptance: [{ id: "A1", package: "P1", text: "x", verify: "test", kind: "repro" }] });

  it("is opt-in: default and explicit required keep the proof", () => {
    expect(redGreenDecision({})).toEqual({ kind: "required" });
    expect(redGreenDecision({ red_green: "required" }, [RED_GREEN_NA_LABEL])).toEqual({ kind: "required" });
    expect(errorsOf(bug())).toEqual([]);
  });

  it("needs a stated reason for the plan field or the issue label", () => {
    expect(errorsOf({ ...bug(), red_green: "not_applicable" })).toContain(
      "red_green exemption is a loosening and needs red_green_reason",
    );
    const labeled = validatePlan(bug(), { repo, labels: [RED_GREEN_NA_LABEL] });
    expect(labeled.ok).toBe(false);
    if (!labeled.ok) expect(labeled.errors).toContain("red_green exemption is a loosening and needs red_green_reason");
    const ok = validatePlan({ ...bug(), red_green: "not_applicable", red_green_reason: "stabilizing a flaky test" }, { repo });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(redGreenDecision(ok.plan)).toEqual({ kind: "exempt", reason: "stabilizing a flaky test" });
    const byLabel = validatePlan({ ...bug(), red_green_reason: "labeled test stabilization" }, { repo, labels: [RED_GREEN_NA_LABEL] });
    expect(byLabel.ok).toBe(true);
    if (byLabel.ok) expect(redGreenDecision(byLabel.plan, [RED_GREEN_NA_LABEL]).kind).toBe("exempt");
  });
});
