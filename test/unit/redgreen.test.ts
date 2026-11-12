import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseProbeFiles, classifyReproRun, redGreenProof } from "../../src/gates/redgreen.js";
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

  it("a command-not-found or signal death is inconclusive; a non-zero exit is a failing test even if the text looks like a load error", async () => {
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
    expect(notFound.detail).toMatch(/exit 127/);
    expect(notFound.detail).not.toMatch(/repro fails on base/);

    const killed = setup();
    writeFileSync(join(killed.dir, "test/max.test.js"), REPRO);
    const signal = await redGreenProof({
      worktree: killed.dir,
      baseSha: killed.baseSha,
      files: ["test/max.test.js"],
      testCommand: "kill -KILL $$",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(signal).toMatchObject({ ok: false, inconclusive: true, redOnBase: false, greenOnHead: false });
    expect(signal.detail).toMatch(/killed by SIGKILL/);
    expect(signal.detail).not.toMatch(/repro fails on base/);

    // A file that fails to parse never ran a test. That is not a proven reproduction.
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
    expect(broken.detail).toMatch(/not a proven reproduction/);
    expect(broken.detail).toMatch(/import/);
    expect(broken.detail).not.toMatch(/repro fails on base/);
  });

  it("an assertion whose message mentions SyntaxError is still a failing test", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(
      join(dir, "test/msg.test.js"),
      "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\ntest(\"msg\", () => { assert.equal(1, 2, \"SyntaxError: No such file\"); });\n",
    );
    const r = await redGreenProof({
      worktree: dir,
      baseSha,
      files: ["test/msg.test.js"],
      testCommand: "node --test {files}",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(r).toMatchObject({ ok: false, inconclusive: false, redOnBase: true, greenOnHead: false });
    expect(r.detail).toMatch(/repro fails on base \(test: msg\)/);
    expect(r.detail).not.toMatch(/not a proven reproduction/);
  });

  it("an import error on base is not a proven reproduction even when HEAD is green", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "src/added.js"), "export const added = 1;\n");
    writeFileSync(
      join(dir, "test/added.test.js"),
      "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { added } from \"../src/added.js\";\ntest(\"loads\", () => { assert.equal(added, 1); });\n",
    );
    const r = await redGreenProof({
      worktree: dir,
      baseSha,
      files: ["test/added.test.js"],
      testCommand: "node --test {files}",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(r).toMatchObject({ ok: false, inconclusive: true, redOnBase: false, greenOnHead: false });
    expect(r.detail).toMatch(/import/);
    expect(r.detail).toMatch(/not a proven reproduction/);
    expect(r.detail).not.toMatch(/repro fails on base/);
  });

  it("copies a new test helper onto the base probe and does not copy the product file", async () => {
    const { dir, baseSha } = setup();
    writeFileSync(join(dir, "test/helper.js"), "export const extra = 1;\n");
    writeFileSync(
      join(dir, "test/with-helper.test.js"),
      "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { extra } from \"./helper.js\";\nimport { max } from \"../src/math.js\";\ntest(\"max returns the larger\", () => { assert.equal(extra, 1); assert.equal(max(1, 2), 2); });\n",
    );
    writeFileSync(join(dir, "src/math.js"), "export const sum = (a, b) => a + b;\nexport const max = (a, b) => (a > b ? a : b);\n");
    const r = await redGreenProof({
      worktree: dir,
      baseSha,
      files: ["test/with-helper.test.js"],
      supportFiles: ["test/helper.js"],
      testCommand: "node --test {files}",
      gateTimeoutMinutes: 20,
      env,
    });
    expect(r).toMatchObject({ ok: true, redOnBase: true, greenOnHead: true, inconclusive: false });
    expect(r.detail).toMatch(/base probe support: test\/helper\.js/);
    expect(baseProbeFiles(["test/with-helper.test.js"], ["src/math.js", "test/helper.js", "test/with-helper.test.js"], ["test/**"])).toEqual({
      tests: ["test/with-helper.test.js"],
      support: ["test/helper.js"],
    });
  });
});

describe("repro classification", () => {
  it("does not treat a bare non-zero exit as an assertion, and does not treat import or collection as one", () => {
    expect(classifyReproRun(0, "")).toBe("pass");
    expect(classifyReproRun(1, "")).toBe("unclear");
    expect(classifyReproRun(2, "")).toBe("unclear");
    expect(classifyReproRun(101, "")).toBe("unclear");
    expect(classifyReproRun(126, "")).toBe("command");
    expect(classifyReproRun(127, "")).toBe("command");
    expect(classifyReproRun(137, "")).toBe("command");
    expect(classifyReproRun(1, "", "SIGKILL")).toBe("command");
    expect(classifyReproRun(1, "✖ msg (1ms)\nAssertionError [ERR_ASSERTION]: SyntaxError: No such file\n")).toBe("assertion");
    expect(classifyReproRun(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './nope.js'\n✖ /tmp/t.test.js (1ms)\n")).toBe("import");
    expect(classifyReproRun(2, "ERROR collecting test_a.py\nE   ModuleNotFoundError: No module named 'a'\ncollected 0 items\n")).toBe("collection");
    expect(classifyReproRun(0, "ℹ pass 0\nℹ fail 0\nℹ skipped 1\n")).toBe("unclear");
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
