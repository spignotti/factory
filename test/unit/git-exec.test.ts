import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sh } from "../../src/exec.js";
import { changedFiles, discardChanges, stageAll } from "../../src/git.js";
import { createFixtureRepo, gitIn } from "../helpers/repo.js";

describe("git helpers", () => {
  it("discardChanges removes staged edits and new files", async () => {
    const dir = createFixtureRepo();
    writeFileSync(join(dir, "src/math.js"), "broken");
    writeFileSync(join(dir, "src/new.js"), "x");
    await stageAll(dir);
    await discardChanges(dir);
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "src/new.js"))).toBe(false);
  });

  it("changedFiles reports both sides of a rename", async () => {
    const dir = createFixtureRepo();
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "mv", "AGENTS.md", "docs-agents.md");
    expect(await changedFiles(dir, base)).toEqual(["AGENTS.md", "docs-agents.md"]);
  });
});

describe("sh", () => {
  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const r = await sh("sleep 30 & sleep 30; echo never", { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
