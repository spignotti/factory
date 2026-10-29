import { describe, expect, it } from "vitest";
import { selectChecks } from "../../src/gates/select.js";
import type { Check } from "../../src/schemas/repo.js";

const checks: Check[] = [
  { name: "lint", run: "x", tier: "fast" },
  { name: "unit", run: "x", tier: "fast", paths: ["src/**", "tests/unit/**"] },
  { name: "db", run: "x", tier: "full", paths: ["supabase/**"] },
  { name: "secrets", run: "x", tier: "full" },
  { name: "cloud", run: "x", tier: "manual" },
  { name: "dotfiles", run: "x", tier: "fast", paths: [".github/**"] },
];
const names = (cs: Check[]) => cs.map((c) => c.name);

describe("check selection", () => {
  it("fast tier: fast checks without paths or with matching paths", () => {
    expect(names(selectChecks(checks, "fast", ["src/a.py"]))).toEqual(["lint", "unit"]);
    expect(names(selectChecks(checks, "fast", ["README.md"]))).toEqual(["lint"]);
  });

  it("full tier adds full checks by paths", () => {
    expect(names(selectChecks(checks, "full", ["supabase/migrations/1.sql"]))).toEqual(["lint", "db", "secrets"]);
    expect(names(selectChecks(checks, "full", ["src/x.py", "supabase/a"]))).toEqual(["lint", "unit", "db", "secrets"]);
  });

  it("never selects manual checks for fast/full", () => {
    expect(names(selectChecks(checks, "full", ["anything"]))).not.toContain("cloud");
  });

  it("manual tier selects only manual checks", () => {
    expect(names(selectChecks(checks, "manual", []))).toEqual(["cloud"]);
  });

  it("matches dotfiles", () => {
    expect(names(selectChecks(checks, "fast", [".github/workflows/x.yml"]))).toEqual(["lint", "dotfiles"]);
  });

  it("no changed files: only path-less checks", () => {
    expect(names(selectChecks(checks, "full", []))).toEqual(["lint", "secrets"]);
  });
});
