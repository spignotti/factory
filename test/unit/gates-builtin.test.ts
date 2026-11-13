import { describe, expect, it } from "vitest";
import { diffSize, evidenceCheck, forbiddenPaths, guideUpdate, reproFiles, scopeReport, testPresence, type EvidenceInputs } from "../../src/gates/builtin.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { PlanSchema } from "../../src/schemas/plan.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

/** The tested code checkpoint the executed records and the gate agree on. */
const AT = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

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

  it("test presence accepts an executed test that is not in the diff and rejects a skip or an invented name", () => {
    const evidence: EvidenceInputs = {
      files: ["src/a.js", "test/a.test.js"],
      executed: [
        { file: "test/a.test.js", name: "repro", result: "pass", checkpoint: AT },
        { file: "test/a.test.js", name: "later", result: "skip", checkpoint: AT },
      ],
      checkpoint: AT,
      knownChecks: ["unit"],
      ranChecks: [{ name: "unit", status: "pass" }],
    };
    expect(testPresence(plan, ["P1"], [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::repro" }])], evidence).ok).toBe(true);
    expect(testPresence(plan, ["P1"], [h([])], evidence).ok).toBe(false);
    expect(testPresence(plan, ["P1"], [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::later" }])], evidence).detail).toMatch(/skipped test/);
    expect(testPresence(plan, ["P1"], [h([{ acceptance_id: "A1", kind: "test", ref: "test/missing.test.js::repro" }])], evidence).detail).toMatch(/invented reference/);
    expect(testPresence(plan, ["P2"], [], evidence).ok).toBe(true);
  });

  it("evidence refs must be a passing executed test or a selected passing check", () => {
    const handoffs = [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js" }, { acceptance_id: "A2", kind: "check", ref: "unit" }])];
    const base: EvidenceInputs = {
      files: ["test/a.test.js"],
      executed: [{ file: "test/a.test.js", name: "", result: "pass", checkpoint: AT }],
      checkpoint: AT,
      knownChecks: ["unit"],
      ranChecks: [{ name: "unit", status: "pass" }],
    };
    expect(evidenceCheck(handoffs, base).ok).toBe(true);
    expect(evidenceCheck(handoffs, { ...base, files: [], executed: [] }).detail).toMatch(/invented reference/);
    expect(evidenceCheck(handoffs, { ...base, knownChecks: [], ranChecks: [] }).detail).toMatch(/unknown check/);
    expect(evidenceCheck(handoffs, { ...base, ranChecks: [] }).detail).toMatch(/check was not executed/);
  });

  it("evidence recorded at another checkpoint is stale, not a pass", () => {
    const handoffs = [h([{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::one" }])];
    const stale: EvidenceInputs = {
      files: ["test/a.test.js"],
      executed: [{ file: "test/a.test.js", name: "one", result: "pass", checkpoint: AT }],
      checkpoint: OTHER,
      knownChecks: [],
      ranChecks: [],
    };
    expect(evidenceCheck(handoffs, stale).detail).toMatch(/stale evidence/);
    expect(testPresence(plan, ["P1"], handoffs, stale).detail).toMatch(/stale evidence/);
  });

  it("names eligible executed evidence when a ref is rejected", () => {
    const handoffs = [h([{ acceptance_id: "A1", kind: "test", ref: "test/missing.test.js::nope" }])];
    const evidence: EvidenceInputs = {
      files: ["test/a.test.js"],
      executed: [
        { file: "test/a.test.js", name: "one", result: "pass", checkpoint: AT },
        { file: "test/a.test.js", name: "later", result: "skip", checkpoint: AT },
        { file: "test/a.test.js", name: "old", result: "pass", checkpoint: OTHER },
        { file: "test/b.test.js", name: "", result: "unparsed", checkpoint: AT },
      ],
      checkpoint: AT,
      knownChecks: [],
      ranChecks: [],
    };
    const detail = evidenceCheck(handoffs, evidence).detail;
    expect(detail).toMatch(/invented reference/);
    expect(detail).toMatch(/eligible executed evidence: test\/a\.test\.js::one$/);
    expect(detail).not.toMatch(/later|\bold\b|test\/b\.test\.js/);
    expect(testPresence(plan, ["P1"], handoffs, evidence).detail).toMatch(/eligible executed evidence: test\/a\.test\.js::one/);
    expect(evidenceCheck(handoffs, { ...evidence, executed: [] }).detail).toMatch(/eligible executed evidence: \(none\)/);
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
