import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redGreenProof } from "../../src/gates/redgreen.js";
import { createFixtureRepo, gitIn } from "../helpers/repo.js";

const REPRO = `import assert from "node:assert/strict";
import { test } from "node:test";
import { max } from "../src/math.js";
test("max returns the larger", () => assert.equal(max(1, 2), 2));
`;
const env = { PATH: process.env.PATH ?? "" };

function setup() {
  const dir = createFixtureRepo();
  const baseSha = gitIn(dir, "rev-parse", "HEAD").trim();
  return { dir, baseSha };
}

describe("red-green proof", () => {
  it("passes when the repro fails on base and passes on HEAD", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/max.test.js"), REPRO);
    writeFileSync(join(dir, "src/math.js"), "export const sum = (a, b) => a + b;\nexport const max = (a, b) => (a > b ? a : b);\n");
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/max.test.js"], testCommand: "node --test {files}", env });
    expect(r).toMatchObject({ ok: true, redOnBase: true, greenOnHead: true });
    expect(gitIn(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("rejects a repro that passes on base", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/sum2.test.js"), `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { sum } from "../src/math.js";\ntest("s", () => assert.equal(sum(2, 2), 4));\n`);
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/sum2.test.js"], testCommand: "node --test {files}", env });
    expect(r).toMatchObject({ ok: false, redOnBase: false, greenOnHead: true });
    expect(r.detail).toMatch(/does not reproduce/);
  });

  it("rejects a repro that still fails on HEAD", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/max.test.js"), REPRO);
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/max.test.js"], testCommand: "node --test {files}", env });
    expect(r).toMatchObject({ ok: false, redOnBase: true, greenOnHead: false });
  });

  it("rejects missing repro evidence or test command", async () => {
    const { dir, baseSha } = setup();
    expect((await redGreenProof({ worktree: dir, baseSha, files: [], testCommand: "x", env })).ok).toBe(false);
    expect((await redGreenProof({ worktree: dir, baseSha, files: ["a"], testCommand: undefined, env })).ok).toBe(false);
  });
});
