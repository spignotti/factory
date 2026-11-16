import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { FIXTURES } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const MATH = readFileSync(join(FIXTURES, "repo", "src", "math.js"), "utf8");

/** The planned change plus files the plan does not name: a new note and an unplanned asset. */
const MULTIPLY_WITH_EXTRA = {
  "src/math.js": `${MATH}\nexport function multiply(a, b) {\n  return a * b;\n}\n`,
  "test/multiply.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n',
  "docs/scratch.md": "scratch notes unrelated to the task\n",
  "assets/logo.png": "\u0000\u0001\u0002 not a real png",
};

const extraSteps = (steps: FakeStep[]): FakeStep[] =>
  steps.map((s) => (s.role === "implement" && s.writes ? { ...s, writes: MULTIPLY_WITH_EXTRA } : s));

describe("files outside the plan", () => {
  it("are listed in the PR body; nothing is removed and the run does not stop", async () => {
    const r = await runScenario({ script: "clean.json", steps: extraSteps });
    expect(r.result.result).toBe("done");
    expect(r.resultFile.stop).toBeUndefined();
    const wt = join(r.runDir, "worktree");
    expect(readFileSync(join(wt, "docs/scratch.md"), "utf8")).toBe("scratch notes unrelated to the task\n");
    expect(git(wt, "log", "--format=%s", "main..HEAD")).not.toContain("out-of-scope");
    expect(r.github.prs).toHaveLength(1);
    const body = r.github.prs[0]?.body ?? "";
    const section = body.slice(body.indexOf("## Files outside the plan"), body.indexOf("## Gate results"));
    expect(section).toContain("## Files outside the plan");
    expect(section).toContain("`docs/scratch.md`");
    expect(section).toContain("`assets/logo.png`");
    expect(section).not.toContain("src/math.js");
  });

  it("a run that stays inside the plan has no such section", async () => {
    const r = await runScenario({ script: "clean.json" });
    expect(r.result.result).toBe("done");
    expect(r.github.prs[0]?.body ?? "").not.toContain("## Files outside the plan");
  });
});
