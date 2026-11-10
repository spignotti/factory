import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyReproExit, redGreenProof } from "../../src/gates/redgreen.js";
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
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/max.test.js"], testCommand: "node --test {files}", gateTimeoutMinutes: 20, env });
    expect(r).toMatchObject({ ok: true, redOnBase: true, greenOnHead: true });
    expect(gitIn(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("rejects a repro that passes on base", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/sum2.test.js"), `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { sum } from "../src/math.js";\ntest("s", () => assert.equal(sum(2, 2), 4));\n`);
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/sum2.test.js"], testCommand: "node --test {files}", gateTimeoutMinutes: 20, env });
    expect(r).toMatchObject({ ok: false, redOnBase: false, greenOnHead: true });
    expect(r.detail).toMatch(/does not reproduce/);
  });

  it("rejects a repro that still fails on HEAD", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/max.test.js"), REPRO);
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/max.test.js"], testCommand: "node --test {files}", gateTimeoutMinutes: 20, env });
    expect(r).toMatchObject({ ok: false, redOnBase: true, greenOnHead: false });
  });

  it("rejects missing repro evidence or test command", async () => {
    const { dir, baseSha } = setup();
    expect(await redGreenProof({ worktree: dir, baseSha, files: [], testCommand: "x", gateTimeoutMinutes: 20, env })).toMatchObject({ ok: false, inconclusive: true });
    expect((await redGreenProof({ worktree: dir, baseSha, files: ["a"], testCommand: undefined, gateTimeoutMinutes: 20, env })).ok).toBe(false);
  });

  it("a command-not-found, syntax error or other non-test exit on base is inconclusive, not red", async () => {
    const missing = setup();
    writeFileSync(join(missing.dir, "test/max.test.js"), REPRO);
    const notFound = await redGreenProof({
      worktree: missing.dir,
      baseSha: missing.baseSha,
      files: ["test/max.test.js"],
      testCommand: "factory-no-such-runner {files}",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(notFound).toMatchObject({ ok: false, inconclusive: true, redOnBase: false, greenOnHead: false });
    expect(notFound.detail).toMatch(/not a failing test/);
    expect(notFound.detail).not.toMatch(/repro fails on base/);

    const syntax = setup();
    writeFileSync(join(syntax.dir, "test/bad.test.js"), "import { test } from \"node:test\";\ntest(\"x\", () => {\n");
    const broken = await redGreenProof({
      worktree: syntax.dir,
      baseSha: syntax.baseSha,
      files: ["test/bad.test.js"],
      testCommand: "node --test {files}",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(broken).toMatchObject({ ok: false, inconclusive: true, redOnBase: false, greenOnHead: false });
    expect(broken.detail).toMatch(/not a failing test/);

    const other = setup();
    writeFileSync(join(other.dir, "test/max.test.js"), REPRO);
    const exit2 = await redGreenProof({
      worktree: other.dir,
      baseSha: other.baseSha,
      files: ["test/max.test.js"],
      testCommand: "exit 2",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(exit2).toMatchObject({ ok: false, inconclusive: true, redOnBase: false });
    expect(exit2.detail).toMatch(/exit 2/);
  });
});

describe("repro exit classification", () => {
  it("treats a failing assertion as red and any other non-zero exit as not a test failure", () => {
    expect(classifyReproExit(0, "ok")).toBe("pass");
    expect(classifyReproExit(1, "AssertionError: 1 !== 2")).toBe("fail");
    expect(classifyReproExit(1, "")).toBe("fail");
    expect(classifyReproExit(101, "test result: FAILED")).toBe("fail");
    expect(classifyReproExit(127, "sh: nope: command not found")).toBe("other");
    expect(classifyReproExit(2, "")).toBe("other");
    expect(classifyReproExit(1, "SyntaxError: Unexpected end of input")).toBe("other");
    expect(classifyReproExit(1, "Could not find 'missing.test.js'")).toBe("other");
  });
});

describe("red-green proof environment", () => {
  it("a hanging repro on base is a timeout and inconclusive, not red", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/max.test.js"), REPRO);
    const seen: string[] = [];
    const started = Date.now();
    const r = await redGreenProof({
      worktree: dir,
      baseSha,
      files: ["test/max.test.js"],
      testCommand: "sleep 30",
      gateTimeoutMinutes: 10,
      timeoutS: 0.2,
      heartbeatMs: 40,
      env,
      onCheck: (e) => seen.push(`${e.event}:${e.where}`),
    });
    expect(r).toMatchObject({ ok: false, inconclusive: true, timedOut: true, redOnBase: false, greenOnHead: false });
    expect(r.detail).toMatch(/timed out on base/);
    expect(r.detail).not.toMatch(/repro fails on base/);
    expect(seen).toContain("progress:base");
    expect(seen).toContain("heartbeat:base");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("runs setup in the base worktree; a failing setup is inconclusive, not a red base", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/max.test.js"), REPRO);
    const r = await redGreenProof({ worktree: dir, baseSha, files: ["test/max.test.js"], testCommand: "node --test {files}", setup: "exit 3", gateTimeoutMinutes: 20, env });
    expect(r).toMatchObject({ ok: false, inconclusive: true, redOnBase: false });
    expect(r.detail).toMatch(/setup failed/);
  });
});
