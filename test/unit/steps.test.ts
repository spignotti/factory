import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { acquireTaskLock } from "../../src/pipeline/lock.js";
import { validateResponses } from "../../src/pipeline/loop.js";
import type { TrackedFinding } from "../../src/pipeline/merge.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { parseHandoff } from "../../src/steps/implement.js";
import { extractPlanBlock, readTask, resolvePlanEffort } from "../../src/steps/intake.js";

describe("intake helpers", () => {
  it("plan effort: flag, then issue label, then high", () => {
    expect(resolvePlanEffort("none", ["factory:plan-medium"])).toBe("none");
    expect(resolvePlanEffort(undefined, ["bug", "factory:plan-medium"])).toBe("medium");
    expect(resolvePlanEffort(undefined, [])).toBe("high");
  });

  it("extracts a fenced factory-plan block", () => {
    expect(extractPlanBlock("text\n```factory-plan\n{\"version\":1}\n```\n")).toEqual({ version: 1 });
    expect(extractPlanBlock("```json\n{}\n```")).toBeUndefined();
    expect(extractPlanBlock("```factory-plan\n{bad\n```")).toBeUndefined();
  });

  it("reads tasks from issues and files", async () => {
    const gh = new FakeGitHub();
    gh.issues.set(12, { number: 12, title: "Fix max", body: "max is wrong", labels: ["factory:plan-none"] });
    expect(await readTask({ issue: 12 }, "/repo", gh)).toMatchObject({ ref: "#12", issue: 12, title: "Fix max", labels: ["factory:plan-none"] });
    const file = join(mkdtempSync(join(tmpdir(), "t-")), "task.md");
    writeFileSync(file, "\n# Do it\nbody");
    expect(await readTask({ textFile: file }, "/repo", gh)).toMatchObject({ ref: "task.md", title: "Do it", text: "\n# Do it\nbody" });
  });
});

describe("handoff validation", () => {
  it("requires valid JSON for the expected package", () => {
    expect(parseHandoff("no json", "P1")).toMatchObject({ ok: false, errors: ["no JSON object in output"] });
    expect(parseHandoff('```json\n{"package":"P2"}\n```', "P1")).toMatchObject({ ok: false, errors: ["package must be P1"] });
    expect(parseHandoff('```json\n{"package":"P1","evidence":"x"}\n```', "P1").ok).toBe(false);
    expect(parseHandoff('```json\n{"package":"P1"}\n```', "P1").ok).toBe(true);
  });

  it("requires an answer per open finding and a reason for wontfix", () => {
    const open = [{ id: "R1-plan-1" }, { id: "R1-plan-2" }] as TrackedFinding[];
    const h = (responses: unknown[]) => HandoffSchema.parse({ package: "fix", responses });
    expect(validateResponses(h([]), open)).toEqual(["no response for R1-plan-1", "no response for R1-plan-2"]);
    expect(validateResponses(h([
      { finding_id: "R1-plan-1", status: "fixed" },
      { finding_id: "R1-plan-2", status: "wontfix", response: " " },
    ]), open)).toEqual(["wontfix for R1-plan-2 needs a reason"]);
    expect(validateResponses(h([
      { finding_id: "R1-plan-1", status: "fixed" },
      { finding_id: "R1-plan-2", status: "wontfix", response: "by design" },
    ]), open)).toEqual([]);
  });
});

describe("task lock", () => {
  it("is exclusive, released, and taken over when stale", () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const release = acquireTaskLock(home, "git@github.com:o/r.git", "#12");
    expect(release).toBeTypeOf("function");
    expect(acquireTaskLock(home, "git@github.com:o/r.git", "#12")).toBeUndefined();
    release!();
    const again = acquireTaskLock(home, "git@github.com:o/r.git", "#12");
    expect(again).toBeTypeOf("function");
    again!();
    writeFileSync(join(home, "locks", "git_github.com_o_r.git-_12.lock"), "999999999");
    expect(acquireTaskLock(home, "git@github.com:o/r.git", "#12")).toBeTypeOf("function");
  });
});
