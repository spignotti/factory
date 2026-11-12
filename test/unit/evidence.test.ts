import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchTestEvidence, parseTestReport, runCitedTests } from "../../src/gates/evidence.js";
import { testPresence, type EvidenceInputs } from "../../src/gates/builtin.js";
import { rolePrompt } from "../../src/prompts.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { PlanSchema } from "../../src/schemas/plan.js";
import { sh } from "../../src/exec.js";

const env = { PATH: process.env.PATH ?? "" };

describe("executed test evidence", () => {
  it("parses a real node run: a passing test counts and a skipped test does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-evidence-"));
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test/sum.test.js"),
      "import { test } from \"node:test\";\ntest(\"sum adds\", () => {});\ntest(\"later\", { skip: true }, () => {});\n",
    );
    const ran = await sh("node --test test/sum.test.js", { cwd: dir, env });
    expect(ran.code).toBe(0);
    const parsed = parseTestReport("test/sum.test.js", ran.output, ran.code);
    expect(parsed).toEqual([
      { file: "test/sum.test.js", name: "sum adds", result: "pass" },
      { file: "test/sum.test.js", name: "later", result: "skip" },
    ]);
    expect(matchTestEvidence("test/sum.test.js::sum adds", parsed, true)).toEqual({ ok: true, reason: "" });
    expect(matchTestEvidence("test/sum.test.js::later", parsed, true).reason).toMatch(/skipped test/);
    expect(matchTestEvidence("test/sum.test.js::nope", parsed, true).reason).toMatch(/invented reference/);
    expect(matchTestEvidence("test/missing.test.js::sum adds", parsed, false).reason).toMatch(/file not in the tree/);
  });

  it("cites a SQL file that the command ran, without a second test that reads its source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sql-"));
    mkdirSync(join(dir, "supabase/tests"), { recursive: true });
    writeFileSync(join(dir, "supabase/tests/rls.sql"), "select 1;\n");
    const executed = await runCitedTests({
      cwd: dir,
      files: ["supabase/tests/rls.sql"],
      testCommand: "test -s {files}",
      env,
    });
    expect(executed).toEqual([{ file: "supabase/tests/rls.sql", name: "", result: "pass" }]);
    const plan = PlanSchema.parse({
      version: 1, type: "feature", goal: "rls",
      packages: [{ id: "P1", title: "rls", files: ["supabase/tests/rls.sql"] }],
      acceptance: [{ id: "A1", package: "P1", text: "tenant isolation holds", verify: "test" }],
    });
    const handoff = HandoffSchema.parse({
      package: "P1",
      evidence: [{ acceptance_id: "A1", kind: "test", ref: "supabase/tests/rls.sql" }],
    });
    const evidence: EvidenceInputs = {
      files: ["supabase/tests/rls.sql"],
      executed,
      knownChecks: [],
      ranChecks: [],
    };
    expect(testPresence(plan, ["P1"], [handoff], evidence).ok).toBe(true);
    expect(handoff.evidence).toHaveLength(1);
  });

  it("treats a pytest skip-only summary as a skip, not a pass", () => {
    const parsed = parseTestReport("test_foo.py", "=== 2 skipped in 0.01s ===\n", 0);
    expect(parsed).toEqual([{ file: "test_foo.py", name: "", result: "skip" }]);
    expect(matchTestEvidence("test_foo.py", parsed, true).reason).toMatch(/skipped test/);
  });

  it("fails a pytest summary that reports a failure", () => {
    expect(parseTestReport("test_foo.py", "=== 1 failed, 1 skipped in 0.01s ===\n", 0)).toEqual([
      { file: "test_foo.py", name: "", result: "fail" },
    ]);
  });

  it("accepts a pytest summary with passes as a file-level pass", () => {
    expect(parseTestReport("test_foo.py", "=== 2 passed, 1 skipped in 0.01s ===\n", 0)).toEqual([
      { file: "test_foo.py", name: "", result: "pass" },
    ]);
  });

  it("treats a lowercase TAP skip directive as a skip", () => {
    const output = "TAP version 13\nok 1 - name # skip reason\n";
    expect(parseTestReport("test/a.test.js", output, 0)).toEqual([
      { file: "test/a.test.js", name: "name", result: "skip" },
    ]);
  });

  it("treats a quiet pytest skip footer as a skip", () => {
    const parsed = parseTestReport("test_foo.py", "2 skipped in 0.01s\n", 0);
    expect(parsed).toEqual([{ file: "test_foo.py", name: "", result: "skip" }]);
    expect(matchTestEvidence("test_foo.py", parsed, true).reason).toMatch(/skipped test/);
  });

  it("treats an xfailed-only footer as a skip, not a pass", () => {
    expect(parseTestReport("test_foo.py", "1 xfailed in 0.01s\n", 0)).toEqual([
      { file: "test_foo.py", name: "", result: "skip" },
    ]);
    expect(parseTestReport("test_foo.py", "=== 1 xpassed in 0.01s ===\n", 0)).toEqual([
      { file: "test_foo.py", name: "", result: "skip" },
    ]);
  });

  it("fails a pytest footer when the command exits non-zero", () => {
    expect(parseTestReport("test_foo.py", "=== 2 passed in 0.01s ===\n", 1)).toEqual([
      { file: "test_foo.py", name: "", result: "fail" },
    ]);
    expect(parseTestReport("test_foo.py", "1 error in 0.01s\n", 0)).toEqual([
      { file: "test_foo.py", name: "", result: "fail" },
    ]);
  });

  it("treats a TAP # skipped directive as a skip", () => {
    const output = "TAP version 13\nok 1 - name # skipped reason\n";
    expect(parseTestReport("test/a.test.js", output, 0)).toEqual([
      { file: "test/a.test.js", name: "name", result: "skip" },
    ]);
  });

  it("treats a TAP skip without a dash description as a skip", () => {
    const output = "TAP version 13\nok 1 # skip reason\n";
    const parsed = parseTestReport("test/a.test.js", output, 0);
    expect(parsed).toEqual([{ file: "test/a.test.js", name: "", result: "skip" }]);
    expect(matchTestEvidence("test/a.test.js", parsed, true).reason).toMatch(/skipped test/);
  });

  it("does not record a cited file a command without {files} merely mentions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["a/b.py", "c.py"],
      testCommand: "printf '%s\\n' 'a/b.py' '=== 1 passed in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([]);
    expect(matchTestEvidence("a/b.py", executed, true).reason).toMatch(/not executed/);
  });

  it("does not attribute a path that is only a substring of a pytest result path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-sub-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["a/b.py", "b.py"],
      testCommand: "printf '%s\\n' 'PASSED a/b.py::test_one' '=== 1 passed in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([{ file: "a/b.py", name: "test_one", result: "pass" }]);
    expect(matchTestEvidence("b.py", executed, true).reason).toMatch(/not executed/);
  });

  it("does not let a suite pass footer override a SKIPPED pytest line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-skip-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["c.py"],
      testCommand: "printf '%s\\n' 'SKIPPED c.py::test_skip' '=== 1 passed, 1 skipped in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([{ file: "c.py", name: "test_skip", result: "skip" }]);
    expect(matchTestEvidence("c.py", executed, true).reason).toMatch(/skipped test/);
  });
});

describe("evidence prompts", () => {
  it("planner, implementer and reviewer do not demand a wrapper or a wording test", () => {
    const plan = rolePrompt("plan");
    const implement = rolePrompt("implement");
    const review = `${rolePrompt("review-plan")}\n${rolePrompt("review-common")}`;
    expect(plan).toMatch(/Documentation wording and organizational non-goals are verify:review, not verify:test/);
    expect(plan).toMatch(/do not add a test whose only job is to read another test's source/);
    expect(plan).not.toMatch(/prefer verify:test or verify:check over review/);
    expect(implement).toMatch(/do not add a wrapper/);
    expect(implement).not.toMatch(/write a test for each verify:test criterion/);
    expect(review).toMatch(/does not need a new test file or a wrapper/);
    expect(review).toMatch(/do not need sentence, screenshot, or test-name tests/);
  });

  it("review-checklist resolves to the standards prompt", () => {
    expect(rolePrompt("review-checklist")).toBe(rolePrompt("review-standards"));
    expect(rolePrompt("review-standards")).toMatch(/standards_items/);
  });
});
