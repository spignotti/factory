import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  citedTestFiles,
  evidenceProvesFullCommand,
  executedFromOutput,
  fileScopedCommand,
  matchTestEvidence,
  parseTestReport,
  pytestResultLines,
  reportingTestCommand,
  runCitedTests,
} from "../../src/gates/evidence.js";
import { testPresence, type EvidenceInputs } from "../../src/gates/builtin.js";
import { rolePrompt } from "../../src/prompts.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { PlanSchema } from "../../src/schemas/plan.js";
import { sh } from "../../src/exec.js";

const env = { PATH: process.env.PATH ?? "" };
/** The staged tree a record is bound to in these fixtures. */
const AT = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/** A repo with one passing and one skipped node test; the command is the terse dot reporter. */
function nodeFixture(body = ""): { cwd: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-terse-"));
  mkdirSync(join(dir, "test"));
  const file = "test/sum.test.js";
  writeFileSync(join(dir, file), `import { test } from "node:test";\ntest("sum adds", () => {});\ntest("later", { skip: true }, () => {});\n${body}`);
  return { cwd: dir, file };
}

/** A command that runs once per cited file and records how often it ran. */
function countingCommand(cwd: string, script: string, output: string): string {
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  writeFileSync(join(cwd, "scripts", script), `#!/bin/sh\necho run >> "${cwd}/runs.log"\nprintf '${output}'\nexit 0\n`);
  return `sh scripts/${script} {files}`;
}
const runsOf = (cwd: string) => (readFileSync(join(cwd, "runs.log"), "utf8").match(/run/g) ?? []).length;

describe("evidence execution artifacts", () => {
  it("binds a passing record to the tested checkpoint", async () => {
    const { cwd, file } = nodeFixture();
    const ran = await sh(`node --test ${file}`, { cwd, env });
    expect(parseTestReport(file, ran.output, ran.code, AT)).toEqual([
      { file, name: "sum adds", result: "pass", checkpoint: AT },
      { file, name: "later", result: "skip", checkpoint: AT },
    ]);
    expect(pytestResultLines("a/test_x.py", "a/test_x.py::one PASSED", AT)).toEqual([
      { file: "a/test_x.py", name: "one", result: "pass", checkpoint: AT },
    ]);
  });

  it("rejects evidence collected at another checkpoint or a stale run", () => {
    const fresh = [{ file: "test/a.test.js", name: "one", result: "pass" as const, checkpoint: AT }];
    expect(matchTestEvidence("test/a.test.js::one", fresh, true, AT).ok).toBe(true);
    expect(matchTestEvidence("test/a.test.js::one", fresh, true, OTHER).reason).toMatch(/stale evidence \(tested at another checkpoint\)/);
    // A checkpoint with no artifact at all stays "not executed": it is not reported as stale.
    expect(matchTestEvidence("test/a.test.js::one", [], true, AT).reason).toMatch(/not executed/);
  });

  it("collects named evidence from a runner whose terse output hides test names", async () => {
    const { cwd, file } = nodeFixture();
    const executed = await runCitedTests({
      cwd,
      files: [file],
      named: [file],
      checkpoint: AT,
      env,
      testCommand: `node --test --test-reporter=dot {files}`,
    });
    expect(executed.some((r) => r.name === "sum adds" && r.result === "pass" && r.checkpoint === AT)).toBe(true);
    expect(matchTestEvidence(`${file}::sum adds`, executed, true, AT)).toEqual({ ok: true, reason: "" });
  });

  it("does not turn a skip or an absent test into evidence through the name-collection run", async () => {
    const { cwd, file } = nodeFixture();
    const executed = await runCitedTests({
      cwd,
      files: [file],
      named: [file],
      checkpoint: AT,
      env,
      testCommand: `node --test --test-reporter=dot {files}`,
    });
    expect(matchTestEvidence(`${file}::later`, executed, true, AT).reason).toMatch(/skipped test/);
    expect(matchTestEvidence(`${file}::never`, executed, true, AT).reason).toMatch(/invented reference/);
  });

  it("never lets collected names hide a failure of the same invocation", async () => {
    const { cwd, file } = nodeFixture(`test("breaks", () => { throw new Error("red"); });\n`);
    const executed = await runCitedTests({
      cwd,
      files: [file],
      named: [file],
      checkpoint: AT,
      env,
      testCommand: `node --test --test-reporter=dot {files}`,
    });
    expect(matchTestEvidence(`${file}::sum adds`, executed, true, AT).reason).toMatch(/test invocation failed/);
  });

  it("selects only the cited file when a suite command is rerun for names", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "factory-suite-"));
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "test/a.test.js"), 'import { test } from "node:test";\ntest("a one", () => {});\n');
    writeFileSync(join(cwd, "test/b.test.js"), 'import { test } from "node:test";\ntest("b one", () => { throw new Error("red"); });\n');
    const executed = await runCitedTests({
      cwd,
      files: ["test/a.test.js"],
      named: ["test/a.test.js"],
      checkpoint: AT,
      env,
      // No {files}: the configured command runs the whole suite, where names cannot be attributed.
      testCommand: `node --test --test-reporter=dot 'test/**/*.test.js'`,
    });
    expect(executed.some((r) => r.name === "a one" && r.result === "pass")).toBe(true);
    expect(executed.some((r) => r.name === "b one")).toBe(false);
    expect(matchTestEvidence("test/a.test.js::a one", executed, true, AT)).toEqual({ ok: true, reason: "" });
  });

  it("does not rerun a runner with no name-collection rule and says what it cannot check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-unsupported-"));
    const command = countingCommand(dir, "run.sh", "done\\n");
    const executed = await runCitedTests({
      cwd: dir,
      files: ["test/a.test.js"],
      named: ["test/a.test.js"],
      checkpoint: AT,
      env,
      testCommand: command,
    });
    expect(runsOf(dir)).toBe(1);
    expect(executed).toEqual([{ file: "test/a.test.js", name: "", result: "unparsed", checkpoint: AT, command: "sh scripts/run.sh 'test/a.test.js'" }]);
    expect(matchTestEvidence("test/a.test.js::sum adds", executed, true, AT).reason).toMatch(/unparseable/);
    expect(matchTestEvidence("test/a.test.js", executed, true, AT).ok).toBe(false);
  });

  it("reruns only runners with an explicit name-collection rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-filescope-"));
    const command = countingCommand(dir, "run.sh", "done\\n");
    await runCitedTests({ cwd: dir, files: ["test/a.test.js"], named: ["test/a.test.js"], checkpoint: AT, env, testCommand: command });
    expect(runsOf(dir)).toBe(1);
    expect(fileScopedCommand("node --test --test-reporter=dot 'test/**/*.test.js'")).toBe("node --test --test-reporter=spec");
    expect(fileScopedCommand("bash scripts/test-pytest.sh {files}")).toBeUndefined();
    expect(fileScopedCommand("pytest -q --maxfail=1 tests")).toBe("pytest -v --maxfail=1");
    expect(fileScopedCommand("uv run --locked pytest {files}")).toBe("uv run --locked pytest -v");
    expect(fileScopedCommand("python3 -m pytest -q")).toBe("python3 -m pytest -v");
  });

  it("does not let a named rerun of one file stand in for the configured full tests.run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "factory-full-command-"));
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "test/a.test.js"), 'import { test } from "node:test";\ntest("a one", () => {});\n');
    writeFileSync(join(cwd, "test/b.test.js"), 'import { test } from "node:test";\ntest("b one", () => { throw new Error("red"); });\n');
    const full = "node --test test/a.test.js test/b.test.js";
    const executed = await runCitedTests({
      cwd,
      files: ["test/a.test.js"],
      named: ["test/a.test.js"],
      checkpoint: AT,
      env,
      testCommand: full,
    });
    expect(matchTestEvidence("test/a.test.js::a one", executed, true, AT)).toEqual({ ok: true, reason: "" });
    expect(executed.every((r) => r.command === "node --test 'test/a.test.js'")).toBe(true);
    expect(evidenceProvesFullCommand(executed, "test/a.test.js", AT, full)).toBe(false);
    expect(evidenceProvesFullCommand(executed, "test/a.test.js", OTHER, full)).toBe(false);
    const suite = await sh(full, { cwd, env });
    expect(suite.code).not.toBe(0);
  });

  it("treats a pass from the configured command itself as that red-green command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "factory-same-command-"));
    mkdirSync(join(cwd, "test"), { recursive: true });
    const file = "test/only.test.js";
    writeFileSync(join(cwd, file), 'import { test } from "node:test";\ntest("only", () => {});\n');
    const executed = await runCitedTests({
      cwd,
      files: [file],
      named: [file],
      checkpoint: AT,
      env,
      testCommand: "node --test {files}",
    });
    expect(evidenceProvesFullCommand(executed, file, AT, `node --test '${file}'`)).toBe(true);
    expect(evidenceProvesFullCommand(executed, file, AT, "node --test test/only.test.js test/other.test.js")).toBe(false);
  });

  it("keeps safety-relevant runner options and refuses an unsafe scoped rewrite", () => {
    expect(fileScopedCommand("node --import tsx --test {files}")).toBe("node --import tsx --test");
    expect(fileScopedCommand("node --test --import ./setup.js {files}")).toBe("node --test --import ./setup.js");
    expect(fileScopedCommand("pytest -p no:cacheprovider -c pytest.ini tests")).toBe("pytest -v -p no:cacheprovider -c pytest.ini");
    expect(fileScopedCommand("pytest --log-file report.log tests")).toBe("pytest -v --log-file report.log");
    expect(fileScopedCommand("pytest --log-file=report.log {files}")).toBe("pytest -v --log-file=report.log");
    expect(fileScopedCommand("node --test --test-reporter-destination out.log {files}")).toBe(
      "node --test --test-reporter-destination out.log",
    );
    expect(fileScopedCommand("uv run --with pytest pytest {files}")).toBe("uv run --with pytest pytest -v");
    expect(fileScopedCommand("pytest --log-file {files}")).toBeUndefined();
    expect(fileScopedCommand("pytest --log-file={files}")).toBeUndefined();
    expect(fileScopedCommand("node --test --test-reporter-destination {files}")).toBeUndefined();
    expect(fileScopedCommand("pytest --unknown-opt value tests")).toBeUndefined();
    expect(fileScopedCommand("node --test --not-a-real-flag value {files}")).toBeUndefined();
    expect(fileScopedCommand("pytest --pdb tests")).toBeUndefined();
  });

  it("does not rewrite a shell command with operators or an appended command as a direct runner", () => {
    const unsafe = [
      "pytest tests && echo ok",
      "pytest tests; echo ok",
      "pytest tests;echo ok",
      "pytest tests&&echo ok",
      "node --test a.js && echo ok",
      "node --test a.js; echo ok",
      "node --test --test-reporter=dot test/a.test.js; echo appended",
      "pytest tests\necho ok",
      "pytest $(echo tests)",
      "pytest `echo tests`",
      "pytest tests | tee out",
      "pytest tests|tee out",
      "pytest tests & echo done",
      "pytest tests &",
      "node --test {files} &",
      "pytest tests 2>&1",
      "node --test a.js > /tmp/out",
      "node --test a.js>/tmp/out",
      "pytest tests >/tmp/out",
      "uv run pytest {files} && true",
      "pytest tests||true",
      "python3 -m pytest tests; echo ok",
      "uv run --locked pytest {files}; echo ok",
      'pytest -k "$NAME" tests',
      "pytest \"tests",
      "node --test a.js # comment",
      "pytest tests # && echo hidden",
    ];
    for (const command of unsafe) {
      expect(fileScopedCommand(command), command).toBeUndefined();
      expect(reportingTestCommand(command), command).toBe(command);
    }
    // A quoted operator is an argument of a direct runner, not an appended command.
    expect(fileScopedCommand("pytest -k 'a && b' tests")).toBe("pytest -v -k 'a && b'");
    expect(reportingTestCommand("pytest -k 'a && b' {files}")).toBe("pytest -v -k 'a && b' {files}");
  });

  it("does not collect named rerun evidence from a command that appends another command", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "factory-appended-"));
    mkdirSync(join(cwd, "test"), { recursive: true });
    const file = "test/a.test.js";
    const log = join(cwd, "loads.log");
    writeFileSync(
      join(cwd, file),
      `import { appendFileSync } from "node:fs";
import { test } from "node:test";
appendFileSync(process.env.LOAD_LOG, ${JSON.stringify("ran\n")});
test("a one", () => {});
`,
    );
    const command = `node --test --test-reporter=dot ${file}; echo appended`;
    const executed = await runCitedTests({
      cwd,
      files: [file],
      named: [file],
      checkpoint: AT,
      env: { ...env, LOAD_LOG: log },
      testCommand: command,
    });
    expect(fileScopedCommand(command)).toBeUndefined();
    expect(executed.some((r) => r.name !== "")).toBe(false);
    expect(executed.every((r) => r.result !== "pass")).toBe(true);
    expect(matchTestEvidence(`${file}::a one`, executed, true, AT).ok).toBe(false);
    const loads = readFileSync(log, "utf8").match(/ran/g) ?? [];
    // The configured command may run. A rewritten direct runner must not run again for names.
    expect(loads).toEqual(["ran"]);
  });
});

describe("executed test evidence", () => {
  it("requests named output from direct pytest runners without altering wrappers or scripts", () => {
    expect(reportingTestCommand("uv run --locked pytest {files}")).toBe("uv run --locked pytest -v {files}");
    expect(reportingTestCommand("python3 -m pytest {files}")).toBe("python3 -m pytest -v {files}");
    expect(reportingTestCommand("bash scripts/test-pytest.sh {files}")).toBe("bash scripts/test-pytest.sh {files}");
  });
  it("requests named output from the node test runner's quiet reporters", () => {
    expect(reportingTestCommand("node --test --test-reporter=dot {files}")).toBe("node --test --test-reporter=spec {files}");
    expect(reportingTestCommand("node --test {files}")).toBe("node --test {files}");
    expect(reportingTestCommand("node --test --test-reporter=tap {files}")).toBe("node --test --test-reporter=tap {files}");
  });
  it("keeps pytest names and skips with a file-selecting command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pytest-report-"));
    const rows = await runCitedTests({
      cwd: dir,
      files: ["test/a.py"],
      checkpoint: AT,
      env,
      testCommand: "printf 'test/a.py::works PASSED\\ntest/a.py::later SKIPPED\\n=== 1 passed, 1 skipped in 0.01s ===\\n'; : {files}",
    });
    expect(matchTestEvidence("test/a.py::works", rows, true, AT).ok).toBe(true);
    expect(matchTestEvidence("test/a.py::later", rows, true, AT).reason).toMatch(/skipped/);
  });
  it("parses a real node run: a passing test counts and a skipped test does not", async () => {
    const { cwd, file } = nodeFixture();
    const ran = await sh(`node --test ${file}`, { cwd, env });
    expect(ran.code).toBe(0);
    const parsed = parseTestReport(file, ran.output, ran.code, AT);
    expect(parsed).toEqual([
      { file, name: "sum adds", result: "pass", checkpoint: AT },
      { file, name: "later", result: "skip", checkpoint: AT },
    ]);
    expect(matchTestEvidence(`${file}::sum adds`, parsed, true, AT)).toEqual({ ok: true, reason: "" });
    expect(matchTestEvidence(`${file}::later`, parsed, true, AT).reason).toMatch(/skipped test/);
    expect(matchTestEvidence(`${file}::nope`, parsed, true, AT).reason).toMatch(/invented reference/);
    expect(matchTestEvidence("test/missing.test.js::sum adds", parsed, false, AT).reason).toMatch(/file not in the tree/);
  });

  it("does not accept a SQL file from an unrecognized command that only exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sql-"));
    mkdirSync(join(dir, "supabase/tests"), { recursive: true });
    writeFileSync(join(dir, "supabase/tests/rls.sql"), "select 1;\n");
    const executed = await runCitedTests({
      cwd: dir,
      files: ["supabase/tests/rls.sql"],
      checkpoint: AT,
      testCommand: "test -s {files}",
      env,
    });
    expect(executed).toEqual([{ file: "supabase/tests/rls.sql", name: "", result: "unparsed", checkpoint: AT, command: "test -s 'supabase/tests/rls.sql'" }]);
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
      checkpoint: AT,
      knownChecks: [],
      ranChecks: [],
    };
    expect(testPresence(plan, ["P1"], [handoff], evidence).ok).toBe(false);
    expect(testPresence(plan, ["P1"], [handoff], evidence).detail).toMatch(/unparseable/);
    expect(handoff.evidence).toHaveLength(1);
  });

  it("does not grant exit-code proof to an unrecognized runner", () => {
    for (const command of ["test -s supabase/tests/rls.sql", "sh scripts/run.sh", "cargo test", "true", "npm test"]) {
      const rows = executedFromOutput("supabase/tests/rls.sql", "ok\n", 0, AT, command);
      expect(rows, command).toEqual([
        { file: "supabase/tests/rls.sql", name: "", result: "unparsed", checkpoint: AT, command },
      ]);
      expect(matchTestEvidence("supabase/tests/rls.sql", rows, true, AT).ok, command).toBe(false);
      expect(matchTestEvidence("supabase/tests/rls.sql", rows, true, AT).reason, command).toMatch(/unparseable/);
    }
    // An explicit pytest rule may use a parsed footer, and that rule's non-zero exit is a failure.
    expect(executedFromOutput("test_foo.py", "=== 1 passed in 0.01s ===\n", 0, AT, "pytest -q test_foo.py")[0]?.result).toBe("pass");
    expect(executedFromOutput("test_foo.py", "=== 1 passed in 0.01s ===\n", 1, AT, "pytest -q test_foo.py")[0]?.result).toBe("fail");
    // Exit 0 without a supported parser is unparsed, including a runner we do not have a rule for.
    expect(executedFromOutput("test_foo.py", "ok\n", 0, AT, "cargo test")[0]?.result).toBe("unparsed");
    // A bare non-zero exit is exit-code evidence only for an explicit runner rule.
    expect(executedFromOutput("f.sql", "noise\n", 1, AT, "psql -f f.sql")[0]?.result).toBe("unparsed");
    expect(executedFromOutput("test_foo.py", "plugin noise\n", 1, AT, "pytest -q test_foo.py")[0]?.result).toBe("fail");
    expect(matchTestEvidence("f.sql", executedFromOutput("f.sql", "noise\n", 1, AT, "psql -f f.sql"), true, AT).ok).toBe(false);
  });

  it("diagnoses exit 0 with unparseable output as unparsed and rejects it as proof", () => {
    const parsed = parseTestReport("test_foo.py", "plugin noise\n", 0, AT);
    expect(parsed).toEqual([{ file: "test_foo.py", name: "", result: "unparsed", checkpoint: AT }]);
    expect(matchTestEvidence("test_foo.py", parsed, true, AT).reason).toMatch(/unparseable/);
    expect(matchTestEvidence("test_foo.py::name", parsed, true, AT).reason).toMatch(/unparseable/);
    const fromRunner = executedFromOutput("test_foo.py", "plugin noise\n", 0, AT, "pytest -q test_foo.py");
    expect(fromRunner).toEqual([{ file: "test_foo.py", name: "", result: "unparsed", checkpoint: AT, command: "pytest -q test_foo.py" }]);
    expect(matchTestEvidence("test_foo.py", fromRunner, true, AT).ok).toBe(false);
    expect(parseTestReport("test_foo.py", "plugin noise\n", 1, AT)[0]?.result).toBe("fail");
  });

  it("treats a pytest skip-only summary as a skip, not a pass", () => {
    const parsed = parseTestReport("test_foo.py", "=== 2 skipped in 0.01s ===\n", 0, AT);
    expect(parsed).toEqual([{ file: "test_foo.py", name: "", result: "skip", checkpoint: AT }]);
    expect(matchTestEvidence("test_foo.py", parsed, true, AT).reason).toMatch(/skipped test/);
  });

  it("fails a pytest summary that reports a failure", () => {
    expect(parseTestReport("test_foo.py", "=== 1 failed, 1 skipped in 0.01s ===\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "fail", checkpoint: AT },
    ]);
  });

  it("accepts a pytest summary with passes as a file-level pass", () => {
    expect(parseTestReport("test_foo.py", "=== 2 passed, 1 skipped in 0.01s ===\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "pass", checkpoint: AT },
    ]);
  });

  it("treats a lowercase TAP skip directive as a skip", () => {
    const output = "TAP version 13\nok 1 - name # skip reason\n";
    expect(parseTestReport("test/a.test.js", output, 0, AT)).toEqual([
      { file: "test/a.test.js", name: "name", result: "skip", checkpoint: AT },
    ]);
  });

  it("treats a quiet pytest skip footer as a skip", () => {
    const parsed = parseTestReport("test_foo.py", "2 skipped in 0.01s\n", 0, AT);
    expect(parsed).toEqual([{ file: "test_foo.py", name: "", result: "skip", checkpoint: AT }]);
    expect(matchTestEvidence("test_foo.py", parsed, true, AT).reason).toMatch(/skipped test/);
  });

  it("treats an xfailed-only footer as a skip, not a pass", () => {
    expect(parseTestReport("test_foo.py", "1 xfailed in 0.01s\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "skip", checkpoint: AT },
    ]);
    expect(parseTestReport("test_foo.py", "=== 1 xpassed in 0.01s ===\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "skip", checkpoint: AT },
    ]);
  });

  it("fails a pytest footer when the command exits non-zero", () => {
    expect(parseTestReport("test_foo.py", "=== 2 passed in 0.01s ===\n", 1, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "fail", checkpoint: AT },
    ]);
    expect(parseTestReport("test_foo.py", "1 error in 0.01s\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "fail", checkpoint: AT },
    ]);
  });

  it("treats a TAP # skipped directive as a skip", () => {
    const output = "TAP version 13\nok 1 - name # skipped reason\n";
    expect(parseTestReport("test/a.test.js", output, 0, AT)).toEqual([
      { file: "test/a.test.js", name: "name", result: "skip", checkpoint: AT },
    ]);
  });

  it("treats a TAP skip without a dash description as a skip", () => {
    const output = "TAP version 13\nok 1 # skip reason\n";
    const parsed = parseTestReport("test/a.test.js", output, 0, AT);
    expect(parsed).toEqual([{ file: "test/a.test.js", name: "", result: "skip", checkpoint: AT }]);
    expect(matchTestEvidence("test/a.test.js", parsed, true, AT).reason).toMatch(/skipped test/);
  });

  it("does not record a cited file a command without {files} merely mentions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["a/b.py", "c.py"],
      checkpoint: AT,
      testCommand: "printf '%s\\n' 'a/b.py' '=== 1 passed in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([]);
    expect(matchTestEvidence("a/b.py", executed, true, AT).reason).toMatch(/not executed/);
  });

  it("does not attribute a path that is only a substring of a pytest result path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-sub-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["a/b.py", "b.py"],
      checkpoint: AT,
      testCommand: "printf '%s\\n' 'PASSED a/b.py::test_one' '=== 1 passed in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([{ file: "a/b.py", name: "test_one", result: "pass", checkpoint: AT, command: "printf '%s\\n' 'PASSED a/b.py::test_one' '=== 1 passed in 0.01s ==='" }]);
    expect(matchTestEvidence("b.py", executed, true, AT).reason).toMatch(/not executed/);
  });

  it("does not let a suite pass footer override a SKIPPED pytest line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-skip-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["c.py"],
      checkpoint: AT,
      testCommand: "printf '%s\\n' 'SKIPPED c.py::test_skip' '=== 1 passed, 1 skipped in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([{ file: "c.py", name: "test_skip", result: "skip", checkpoint: AT, command: "printf '%s\\n' 'SKIPPED c.py::test_skip' '=== 1 passed, 1 skipped in 0.01s ==='" }]);
    expect(matchTestEvidence("c.py", executed, true, AT).reason).toMatch(/skipped test/);
  });

  it("attributes pytest's verbose progress line and not a shorter path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-verbose-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["a/b.py", "b.py"],
      checkpoint: AT,
      testCommand: "printf '%s\\n' 'a/b.py::test_one PASSED [ 50%]' 'b.py::test_two FAILED'",
      env,
    });
    const verbose = "printf '%s\\n' 'a/b.py::test_one PASSED [ 50%]' 'b.py::test_two FAILED'";
    expect(executed).toEqual([
      { file: "a/b.py", name: "test_one", result: "pass", checkpoint: AT, command: verbose },
      { file: "b.py", name: "test_two", result: "fail", checkpoint: AT, command: verbose },
    ]);
  });

  it("treats an XFAIL result line as a skip even next to a pass footer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pytest-xfail-"));
    const executed = await runCitedTests({
      cwd: dir,
      files: ["c.py"],
      checkpoint: AT,
      testCommand: "printf '%s\\n' 'c.py::test_x XFAIL' '=== 1 passed in 0.01s ==='",
      env,
    });
    expect(executed).toEqual([{ file: "c.py", name: "test_x", result: "skip", checkpoint: AT, command: "printf '%s\\n' 'c.py::test_x XFAIL' '=== 1 passed in 0.01s ==='" }]);
    expect(matchTestEvidence("c.py", executed, true, AT).reason).toMatch(/skipped test/);
  });

  it("treats a long or colored pytest skip footer as a skip", () => {
    expect(parseTestReport("test_foo.py", "2 skipped in 62.34s (0:01:02)\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "skip", checkpoint: AT },
    ]);
    expect(parseTestReport("test_foo.py", "1 xfailed in 1m 2.34s\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "skip", checkpoint: AT },
    ]);
    expect(parseTestReport("test_foo.py", "\u001b[32m2 skipped in 0.01s\u001b[0m\n", 0, AT)).toEqual([
      { file: "test_foo.py", name: "", result: "skip", checkpoint: AT },
    ]);
  });

  it("lists test files cited as test evidence", () => {
    const handoffs = [HandoffSchema.parse({ package: "P1", evidence: [{ acceptance_id: "A1", kind: "test", ref: "test/a.test.js::one" }, { acceptance_id: "A2", kind: "check", ref: "unit" }] })];
    expect(citedTestFiles(handoffs)).toEqual(["test/a.test.js"]);
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
