import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { readState } from "../../src/pipeline/state.js";
import { resumeScenario, runScenario, SECRET } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const roles = (...keep: string[]) => (steps: FakeStep[]) => steps.filter((step) => keep.includes(step.role));
const MULTIPLY = "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
const MULTIPLY_TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n';

describe("stored outcomes", () => {
  it("a done run records an unmerged delivery and provenance without secrets or check commands", async () => {
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 7 },
      github: (gh) => {
        gh.issues.set(7, {
          number: 7,
          title: "Add a multiply function",
          body: "Add a multiply function to src/math.js.\nmultiply(2, 3) returns 6.\n",
          labels: [],
        });
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.result.pr).toMatch(/^https:/);
    expect(r.resultFile.outcome).toEqual({
      ticket: 7,
      attempts: 1,
      delivered_pr: r.result.pr,
      merged: "no",
      ended_without_merge: true,
      open_decision: false,
    });
    const state = readState(r.runDir);
    expect(state.attempts).toBe(1);
    expect(state.plan_effort).toBe("high");
    const provenance = r.resultFile.provenance;
    expect(provenance?.factory_version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
    expect(provenance?.factory_commit).toBe(git(process.cwd(), "rev-parse", "HEAD"));
    expect(provenance?.prompt_revision).toMatch(/^[0-9a-f]{16}$/);
    expect(provenance?.effort).toBe("high");
    expect(provenance?.config_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(provenance?.base).toBe(state.base_sha);
    expect(provenance?.head).toBe(git(state.worktree!, "rev-parse", "HEAD"));
    const implement = [...r.events].reverse().find((event) => event.event === "agent_finished" && event.role === "implement");
    expect(implement?.model).toBeTruthy();
    expect(provenance?.model).toBe(implement?.model);
    const syntax = provenance?.checks.find((check) => check.name === "syntax");
    expect(syntax?.version).toMatch(/^[0-9a-f]{16}$/);
    const text = r.file("result.json");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("node --check src/math.js");
    expect(text).not.toContain("You implement the given package");
  });

  it("resume writes a recovery note, increments a known attempt, and does not start a new plan", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.result.result).toBe("needs_human");
    expect(r.resultFile.outcome).toMatchObject({ ticket: null, attempts: 1, merged: "no", open_decision: true });
    const wt = join(r.runDir, "worktree");
    writeFileSync(join(wt, "src/math.js"), MULTIPLY);
    writeFileSync(join(wt, "test/multiply.test.js"), MULTIPLY_TEST);

    const resumed = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(resumed.result.result).toBe("done");
    expect(resumed.runner.calls.some((call) => call.role.startsWith("plan"))).toBe(false);
    expect(JSON.parse(resumed.file("recovery.json"))).toMatchObject({
      previous_result: "needs_human",
      attempts: 2,
      checkpoint: "implement",
      plan_kept: true,
      note: "Resumed the same run from the checkpoint plan. A coding result is not a confirmed merge.",
    });
    expect(resumed.events.some((event) => event.event === "progress" && event.data.recovery && (event.data.recovery as { plan_kept?: boolean }).plan_kept === true)).toBe(true);
    expect(readState(r.runDir).attempts).toBe(2);
    expect(resumed.resultFile.outcome).toMatchObject({ attempts: 2, merged: "no", delivered_pr: resumed.result.pr });
    expect(resumed.file("result.json")).not.toContain(SECRET);
    expect(resumed.file("recovery.json")).not.toContain(SECRET);
  });

  it("V24: resume does not invent an attempt count the checkpoint never stored", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.result.result).toBe("needs_human");
    const saved = JSON.parse(r.file("state.json")) as { attempts?: number };
    delete saved.attempts;
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(saved));
    const wt = join(r.runDir, "worktree");
    writeFileSync(join(wt, "src/math.js"), MULTIPLY);
    writeFileSync(join(wt, "test/multiply.test.js"), MULTIPLY_TEST);

    const resumed = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(resumed.result.result).toBe("done");
    expect(JSON.parse(resumed.file("recovery.json")).attempts).toBeNull();
    expect(readState(r.runDir).attempts).toBeUndefined();
    expect(resumed.resultFile.outcome?.attempts).toBeNull();
    expect(resumed.resultFile.outcome?.merged).toBe("no");
    expect(resumed.runner.calls.some((call) => call.role.startsWith("plan"))).toBe(false);
  });
});
