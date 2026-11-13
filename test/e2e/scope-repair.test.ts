import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { readState } from "../../src/pipeline/state.js";
import { FIXTURES } from "../helpers/repo.js";
import { resumeScenario, runScenario } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const roles = (...keep: string[]) => (steps: FakeStep[]) => steps.filter((s) => keep.includes(s.role));

const MATH = readFileSync(join(FIXTURES, "repo", "src", "math.js"), "utf8");
const MATH_TEST = readFileSync(join(FIXTURES, "repo", "test", "math.test.js"), "utf8");

/** The authorized change plus out-of-scope deviations: a fake image artifact, a new unplanned file, an unrelated test edit. */
const MULTIPLY_WITH_HELP = {
  "src/math.js": `${MATH}\nexport function multiply(a, b) {\n  return a * b;\n}\n`,
  "test/multiply.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n',
  "assets/logo.png": "\u0000\u0001\u0002 not a real png",
  "docs/scratch.md": "scratch notes unrelated to the task\n",
  "test/math.test.js": `${MATH_TEST}\ntest("unrelated scratch assertion", () => {\n  assert.ok(true);\n});\n`,
};

/** Finalize-time scope repair commits the removal, then a delta review re-runs the reviewers. */
const scopeSteps = (steps: FakeStep[]): FakeStep[] => [
  ...steps.map((s) => (s.role === "implement" && s.writes ? { ...s, writes: MULTIPLY_WITH_HELP } : s)),
  { role: "review_plan", output: { reviewer: "plan", prior: [], findings: [] } },
  { role: "review_simplicity", output: { reviewer: "simplicity", prior: [], findings: [] } },
];

describe("scope repair (#180)", () => {
  it("removes removable run-owned out-of-scope changes and continues in the same PR", async () => {
    const r = await runScenario({ script: "clean.json", steps: scopeSteps });
    expect(r.result.result).toBe("done");
    const wt = join(r.runDir, "worktree");
    // the unauthorized additions are gone; the unrelated test edit is back at base
    expect(existsSync(join(wt, "assets/logo.png"))).toBe(false);
    expect(existsSync(join(wt, "docs/scratch.md"))).toBe(false);
    expect(readFileSync(join(wt, "test/math.test.js"), "utf8")).toBe(MATH_TEST);
    // the authorized task boundary stays untouched
    expect(readFileSync(join(wt, "src/math.js"), "utf8")).toContain("multiply");
    expect(readFileSync(join(wt, "test/multiply.test.js"), "utf8")).toContain("multiply");
    // same branch, one PR, a scope-removal commit, and the review covers the resulting head
    expect(git(wt, "log", "--format=%s", "main..HEAD")).toContain("fix: remove out-of-scope changes");
    expect(r.github.prs).toHaveLength(1);
    expect(r.eventsText).toContain("scope_repair");
    const st = readState(r.runDir);
    expect(st.reviewed_sha).toBe(git(wt, "rev-parse", "HEAD").trim());
    // the repair spent a shared, persisted budget attempt, not a silent fresh start
    expect(st.repair?.scope_repairs).toBe(1);
  });

  it("foreign out-of-scope changes are never discarded: the run stops for a decision", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.result.result).toBe("needs_human");
    // a person commits their own change on the run branch before the resume
    const wt = join(r.runDir, "worktree");
    writeForeign(wt, "notes/human-review.md", "a note a person added to this branch\n");

    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.resultFile.stop?.cause).toBe("explicit_decision");
    expect(r2.result.reason).toContain("notes/human-review.md");
    // actionable evidence: the finding names the file and its hunk
    expect(r2.eventsText).toContain("scope_finding");
    // the foreign change is untouched — scope cleanup never discards it
    expect(readFileSync(join(wt, "notes/human-review.md"), "utf8")).toBe("a note a person added to this branch\n");
    expect(git(wt, "log", "--format=%s", "main..HEAD")).not.toContain("remove out-of-scope");
  });

  it("extra scope that is genuinely necessary stops with a specific explanation and question", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) =>
        steps.map((s) =>
          s.role === "implement" && s.writes
            ? {
                ...s,
                writes: {
                  "src/math.js": `import { twice } from "./helper.js";\n\n${MATH}\nexport function multiply(a, b) {\n  return a * b;\n}\nexport function timesTwo(a) {\n  return twice(a) + a - a;\n}\n`,
                  "src/helper.js": "export function twice(a) {\n  return a + a;\n}\n",
                  "test/multiply.test.js": MULTIPLY_WITH_HELP["test/multiply.test.js"],
                },
                output: {
                  ...(s.output as object),
                },
              }
            : s,
        ),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.resultFile.stop?.cause).toBe("explicit_decision");
    // removal breaks the authorized change → the deviation was necessary: explain and ask
    expect(r.result.reason).toContain("src/helper.js");
    expect(r.result.reason).toMatch(/necessary|decide|question|resume/i);
    // nothing was kept discarded and the task was not quietly amended
    expect(existsSync(join(r.runDir, "worktree", "src", "helper.js"))).toBe(true);
    expect(r.file("plan.json")).not.toContain("src/helper.js");
    expect(git(join(r.runDir, "worktree"), "log", "--format=%s", "main..HEAD")).not.toContain("remove out-of-scope");
  });

  // The bounded repair budget and the unchanged-failure fingerprint (same deviation set stops instead
  // of looping) are unit-tested in test/unit/scope-repair.test.ts against planScopeRepair.
});

function writeForeign(wt: string, file: string, content: string): void {
  execFileSync("sh", ["-c", `mkdir -p "$(dirname ${file})" && cat > ${file}`], { cwd: wt, input: content });
  execFileSync("git", ["-c", "user.name=human", "-c", "user.email=human@test", "add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.name=human", "-c", "user.email=human@test", "commit", "-q", "-m", "note from a person"], { cwd: wt });
}
