import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { acquireRepoLock, repoLockHolder, waitForRepoLock } from "../../src/pipeline/lock.js";
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
    expect(await readTask({ textFile: file }, "/repo", gh)).toMatchObject({ ref: file, title: "Do it", text: "\n# Do it\nbody" });
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

describe("repo lock", () => {
  const REPO = "git@github.com:o/r.git";
  const file = (home: string) => join(home, "locks", "git_github.com_o_r.git.lock");

  it("is exclusive per repo (any task), released, and taken over when stale", () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const release = acquireRepoLock(home, REPO, "run-a");
    expect(release).toBeTypeOf("function");
    expect(readFileSync(file(home), "utf8")).toBe(`${process.pid}\nrun-a`);
    expect(acquireRepoLock(home, REPO, "run-b")).toBeUndefined();
    expect(repoLockHolder(home, REPO)).toEqual({ pid: process.pid, runId: "run-a" });
    expect(acquireRepoLock(home, "git@github.com:o/other.git", "run-c")).toBeTypeOf("function");
    release!();
    expect(repoLockHolder(home, REPO)).toBeUndefined();
    const again = acquireRepoLock(home, REPO, "run-b");
    expect(again).toBeTypeOf("function");
    again!();
    writeFileSync(file(home), "999999999\nrun-dead");
    expect(repoLockHolder(home, REPO)).toBeUndefined();
    const taken = acquireRepoLock(home, REPO, "run-d");
    expect(taken).toBeTypeOf("function");
    expect(acquireRepoLock(home, REPO, "run-e")).toBeUndefined();
    taken!();
    // a takeover in progress (guard held by a live process) blocks a second taker
    writeFileSync(file(home), "999999999");
    writeFileSync(`${file(home)}.takeover`, String(process.pid));
    expect(acquireRepoLock(home, REPO, "run-f")).toBeUndefined();
  });

  it("is held by another live process until it exits", async () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(file(home), `${child.pid}\nrun-other`);
    expect(acquireRepoLock(home, REPO, "me")).toBeUndefined();
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    const release = acquireRepoLock(home, REPO, "me");
    expect(release).toBeTypeOf("function");
    release!();
  });

  it("waitForRepoLock queues until released and stops on abort", async () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const held = acquireRepoLock(home, REPO, "run-a")!;
    setTimeout(held, 80);
    const release = await waitForRepoLock(home, REPO, "run-b", { pollMs: 10 });
    expect(repoLockHolder(home, REPO)?.runId).toBe("run-b");
    const controller = new AbortController();
    const waiting = waitForRepoLock(home, REPO, "run-c", { pollMs: 10, signal: controller.signal });
    controller.abort(new Error("interrupted by SIGINT"));
    await expect(waiting).rejects.toThrow("interrupted by SIGINT");
    release();
  });
});
