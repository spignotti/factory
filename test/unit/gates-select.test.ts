import { describe, expect, it } from "vitest";
import { dedupeChecks, omitRepeatedNames, selectChecks } from "../../src/gates/select.js";
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

  it("all: an empty diff still selects every check of the tier (tag and workflow_dispatch)", () => {
    expect(names(selectChecks(checks, "full", [], { all: true }))).toEqual(["lint", "unit", "db", "secrets", "dotfiles"]);
    expect(names(selectChecks(checks, "fast", [], { all: true }))).toEqual(["lint", "unit", "dotfiles"]);
    expect(names(selectChecks(checks, "manual", [], { all: true }))).toEqual(["cloud"]);
  });

  it("a dependency, shared config, fixture or package entrypoint widens the tier", () => {
    const widened = ["lint", "unit", "dotfiles"];
    expect(names(selectChecks(checks, "fast", ["package.json"]))).toEqual(widened);
    expect(names(selectChecks(checks, "fast", ["src/index.ts"]))).toEqual(widened);
    expect(names(selectChecks(checks, "fast", ["tests/fixtures/a.json"]))).toEqual(widened);
    expect(names(selectChecks(checks, "fast", [".factory/repo.yaml"]))).toEqual(widened);
    expect(names(selectChecks(checks, "full", ["pyproject.toml"]))).toEqual(["lint", "unit", "db", "secrets", "dotfiles"]);
    expect(names(selectChecks(checks, "fast", ["README.md"]))).toEqual(["lint"]);
    expect(names(selectChecks(checks, "manual", ["package.json"]))).toEqual(["cloud"]);
    expect(names(selectChecks(checks, "fast", ["src/a.py"]))).toEqual(["lint", "unit"]);
  });
});

describe("one command per phase", () => {
  it("keeps the first check and names later checks with the same run", () => {
    const picked = dedupeChecks([
      { name: "unit", run: "node --test", tier: "fast" },
      { name: "suite", run: " node --test ", tier: "full" },
      { name: "lint", run: "eslint", tier: "fast" },
    ]);
    expect(names(picked.checks)).toEqual(["unit", "lint"]);
    expect(picked.sameCommand).toEqual([{ name: "suite", sameAs: "unit" }]);
  });

  it("drops a baseline gate whose name already ran", () => {
    expect(omitRepeatedNames([{ name: "shellcheck" }, { name: "ruff" }], ["shellcheck"]).map((item) => item.name)).toEqual(["ruff"]);
  });
});
