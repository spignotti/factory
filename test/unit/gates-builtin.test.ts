import { describe, expect, it } from "vitest";
import { diffSize, evidenceCheck, forbiddenPaths, guideUpdate, reproFiles, scopeReport, testPresence } from "../../src/gates/builtin.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { PlanSchema } from "../../src/schemas/plan.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const plan = PlanSchema.parse({
  version: 1, type: "bug", goal: "g",
  packages: [
    { id: "P1", title: "t", files: ["src/a.js", "test/a.test.js"], changes_flows: ["tours"] },
    { id: "P2", title: "u", files: ["src/b/**"], depends_on: ["P1"] },
  ],
  acceptance: [
    { id: "A1", package: "P1", text: "x", verify: "test", kind: "repro" },
    { id: "A2", package: "P2", text: "y", verify: "check" },
  ],
});
const repo = parseRepoConfig(`verify: { areas: [{ name: tours, guide: .factory/verify/tours.md, flows: [test/e2e/tours.js] }] }`);
const h = (evidence: unknown[]) => HandoffSchema.parse({ package: "P1", evidence });

describe("built-in gates", () => {
  it("forbidden paths", () => {
    expect(forbiddenPaths(["src/a.js"], [".env*"]).ok).toBe(true);
    expect(forbiddenPaths([".env.local", "k.pem"], [".env*", "**/*.pem"])).toMatchObject({ ok: false });
  });

  it("diff size", () => {
    expect(diffSize(new Map([["a", { lines: 10 }], ["b", { lines: 5 }]]), 15).ok).toBe(true);
    expect(diffSize(new Map([["a", { lines: 16 }]]), 15).ok).toBe(false);
  });

  it("test presence requires a changed test file as evidence per verify:test criterion", () => {
    const changed = ["src/a.js", "test/a.test.js"];
    expect(testPresence(plan, ["P1"], [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::repro" }])], changed, ["test/**"]).ok).toBe(true);
    expect(testPresence(plan, ["P1"], [h([])], changed, ["test/**"]).ok).toBe(false);
    expect(testPresence(plan, ["P1"], [h([{ acceptance_id: "A1", kind: "test", ref: "src/a.js" }])], changed, ["test/**"]).ok).toBe(false);
    expect(testPresence(plan, ["P2"], [], changed, ["test/**"]).ok).toBe(true);
  });

  it("evidence refs must exist", () => {
    const handoffs = [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js" }, { acceptance_id: "A2", kind: "check", ref: "unit" }])];
    expect(evidenceCheck(handoffs, ["test/a.test.js"], ["unit"]).ok).toBe(true);
    expect(evidenceCheck(handoffs, [], ["unit"]).ok).toBe(false);
    expect(evidenceCheck(handoffs, ["test/a.test.js"], []).ok).toBe(false);
  });

  it("guide update check", () => {
    expect(guideUpdate(plan, ["P1"], ["src/a.js"], repo).ok).toBe(false);
    expect(guideUpdate(plan, ["P1"], [".factory/verify/tours.md"], repo).ok).toBe(true);
    expect(guideUpdate(plan, ["P1"], ["test/e2e/tours.js"], repo).ok).toBe(true);
    expect(guideUpdate(plan, ["P2"], [], repo).ok).toBe(true);
  });

  it("scope report lists files outside the plan (globs allowed)", () => {
    expect(scopeReport(plan, ["src/a.js", "src/b/c.js", "README.md"])).toEqual(["README.md"]);
  });

  it("repro files come from repro evidence", () => {
    expect(reproFiles(plan, [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::x" }, { acceptance_id: "A2", kind: "check", ref: "unit" }])])).toEqual(["test/a.test.js"]);
  });
});
