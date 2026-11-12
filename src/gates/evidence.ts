import type { Handoff } from "../schemas/handoff.js";
import { sh } from "../exec.js";
import type { Jail } from "../sandbox/sandbox.js";
import { shTimedOut, watchCheck, type CheckPulse } from "./timeout.js";

/** One test the evidence command actually ran. `name` is empty when the runner only reported the file. */
export interface ExecutedTest {
  file: string;
  name: string;
  result: "pass" | "fail" | "skip";
}

export interface EvidenceMatch {
  ok: boolean;
  /** Empty when `ok`. Shown on the gate line. */
  reason: string;
}

const PASS_MARK = "\u2714";
const FAIL_MARK = "\u2716";
const SKIP_MARK = "\uFE63";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Direct pytest runners must report individual names for `path::name` evidence. No shell rewriting. */
export function reportingTestCommand(command: string): string {
  return command.replace(/^((?:uv run(?: --[\w-]+)* |python[\d.]* -m )?pytest)(?=\s|$)/, "$1 -v");
}

/** `path` or `path::test name`. */
export function splitEvidenceRef(ref: string): { file: string; name?: string } {
  const i = ref.indexOf("::");
  if (i === -1) return { file: ref.trim() };
  return { file: ref.slice(0, i).trim(), name: ref.slice(i + 2).trim() };
}

/** Test files cited as `kind: test` evidence, in first-seen order. */
export function citedTestFiles(handoffs: Handoff[]): string[] {
  const out: string[] = [];
  for (const h of handoffs) {
    for (const e of h.evidence) {
      if (e.kind !== "test") continue;
      const file = splitEvidenceRef(e.ref).file;
      if (file && !out.includes(file)) out.push(file);
    }
  }
  return out;
}

function cleanTestName(raw: string): { name: string; skip: boolean } {
  const skip = /#\s*skip(?:ped)?\b/i.test(raw);
  const name = raw.replace(/\s*#\s*skip(?:ped)?\b.*$/i, "").replace(/\s+\([\d.]+ms\)\s*$/, "").trim();
  return { name, skip };
}

interface PytestCounts {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  xfailed: number;
  xpassed: number;
}

const PYTEST_COUNT = String.raw`\d+\s+[A-Za-z]+`;
/**
 * Pytest's own duration (`0.01s`, or `62.34s (0:01:02)` past a minute) and the
 * minute form some reporters print (`1m 2.34s`).
 */
const PYTEST_DURATION = String.raw`(?:\d+h\s+)?(?:\d+m\s+)?\d+(?:\.\d+)?s(?:\s+\([^)]*\))?`;
/** Banner (`=== 2 skipped in 0.01s ===`) or pytest -q (`2 skipped in 0.01s`). */
const PYTEST_SUMMARY = new RegExp(
  `^(?:=+\\s*)?(${PYTEST_COUNT}(?:,\\s*${PYTEST_COUNT})*)\\s+in\\s+${PYTEST_DURATION}\\s*(?:=+)?$`,
);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

/** Pytest footer counts. Warnings, xfailed and xpassed are not passes. */
function pytestCounts(output: string): PytestCounts | undefined {
  let body: string | undefined;
  for (const line of output.split("\n")) {
    const m = PYTEST_SUMMARY.exec(stripAnsi(line).trim());
    if (m) body = m[1] ?? "";
  }
  if (body === undefined) return undefined;
  const counts: PytestCounts = { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  let found = false;
  for (const m of body.matchAll(/(\d+)\s+(xfailed|xpassed|passed|failed|errors?|skipped)\b/gi)) {
    found = true;
    const n = Number(m[1]);
    const kind = (m[2] ?? "").toLowerCase();
    if (kind === "passed") counts.passed += n;
    else if (kind === "failed") counts.failed += n;
    else if (kind === "error" || kind === "errors") counts.errors += n;
    else if (kind === "xfailed") counts.xfailed += n;
    else if (kind === "xpassed") counts.xpassed += n;
    else counts.skipped += n;
  }
  return found ? counts : undefined;
}

/**
 * Node's spec reporter, TAP, and a pytest summary footer (`= … in 0.02s =`, or the quiet
 * `2 skipped in 0.01s` form). Per-test Node/TAP lines win when present, including a non-zero
 * exit. Otherwise a pytest footer is one file-level result: failed or error fails; a non-zero
 * exit fails even when passed > 0; xfailed and xpassed are not passes; skip-only or xfailed-only
 * with exit 0 is a skip. Warnings are not passes. A command that exits 0 without those marks (a
 * SQL file, an integration script) is one file-level pass. A non-zero exit without per-test lines
 * is a file-level failure, not a pass.
 */
export function parseTestReport(file: string, output: string, code: number): ExecutedTest[] {
  const pytestLines = pytestResultLines(file, output);
  if (pytestLines.length) {
    // Never let named passes hide a collection/process failure of the same invocation.
    return code === 0 ? pytestLines : [...pytestLines, { file, name: "", result: "fail" }];
  }
  if (output.includes("TAP version")) {
    const tap = parseTap(file, output);
    if (tap.length) return tap;
  }
  const spec = parseSpec(file, output);
  if (spec.length) return spec;
  if (shTimedOut({ code, signal: null, output, durationMs: 0 })) return [{ file, name: "", result: "fail" }];
  const pytest = pytestCounts(output);
  if (pytest) {
    if (code !== 0 || pytest.failed > 0 || pytest.errors > 0) return [{ file, name: "", result: "fail" }];
    if (pytest.passed > 0) return [{ file, name: "", result: "pass" }];
    if (pytest.skipped > 0 || pytest.xfailed > 0 || pytest.xpassed > 0) return [{ file, name: "", result: "skip" }];
  }
  return [{ file, name: "", result: code === 0 ? "pass" : "fail" }];
}

function parseSpec(file: string, output: string): ExecutedTest[] {
  const out: ExecutedTest[] = [];
  for (const line of output.split("\n")) {
    const mark = line[0];
    if (mark !== PASS_MARK && mark !== FAIL_MARK && mark !== SKIP_MARK) continue;
    const cleaned = cleanTestName(line.slice(1).trim());
    const name = cleaned.name;
    if (!name || name === "failing tests:") continue;
    const result = cleaned.skip || mark === SKIP_MARK ? "skip" : mark === PASS_MARK ? "pass" : "fail";
    out.push({ file, name, result });
  }
  return out;
}

function parseTap(file: string, output: string): ExecutedTest[] {
  const out: ExecutedTest[] = [];
  for (const line of output.split("\n")) {
    const m = /^(not )?ok\s+\d+(?:\s+-\s+|\s+)(.+)$/.exec(line.trim());
    if (!m) continue;
    const cleaned = cleanTestName(m[2] ?? "");
    if (!cleaned.name && !cleaned.skip) continue;
    const result = cleaned.skip ? "skip" : m[1] ? "fail" : "pass";
    out.push({ file, name: cleaned.name, result });
  }
  return out;
}

const PYTEST_STATUS = "PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS";
/** Short summary (`-r`): `PASSED path::name`. Verbose progress: `path::name PASSED`. */
const PYTEST_SHORT = new RegExp(`^(${PYTEST_STATUS})\\s+(\\S+?)::(\\S+)`);
const PYTEST_VERBOSE = new RegExp(`^(\\S+?)::(.+?)\\s+(${PYTEST_STATUS})\\b`);

function pytestResultOf(status: string): "pass" | "fail" | "skip" {
  if (status === "PASSED") return "pass";
  if (status === "SKIPPED" || status === "XFAIL" || status === "XPASS") return "skip";
  return "fail";
}

/** A cited file counts only when a result line names that path exactly. */
export function pytestResultLines(file: string, output: string): ExecutedTest[] {
  const out: ExecutedTest[] = [];
  for (const raw of output.split("\n")) {
    const line = stripAnsi(raw).trim();
    const short = PYTEST_SHORT.exec(line);
    if (short && short[2] === file) {
      out.push({ file, name: short[3] ?? "", result: pytestResultOf(short[1] ?? "") });
      continue;
    }
    const verbose = PYTEST_VERBOSE.exec(line);
    if (verbose && verbose[1] === file) {
      out.push({ file, name: (verbose[2] ?? "").trim(), result: pytestResultOf(verbose[3] ?? "") });
    }
  }
  return out;
}

/**
 * A test ref is evidence only when the file exists, the run selected it, and that result passed.
 * An unknown file or test name is an invented reference. A skip is not a pass.
 * A file-level ref (no `::name`) matches a file the command ran whose tests passed, including a
 * suite that does not print test names. It does not match a different file's pass.
 */
export function matchTestEvidence(ref: string, executed: readonly ExecutedTest[], exists: boolean): EvidenceMatch {
  const { file, name } = splitEvidenceRef(ref);
  if (!file || !exists) return { ok: false, reason: `invented reference (file not in the tree): ${ref}` };
  const rows = executed.filter((e) => e.file === file);
  if (rows.length === 0) return { ok: false, reason: `test was not executed: ${ref}` };
  if (rows.some((e) => e.name === "" && e.result === "fail")) return { ok: false, reason: `test invocation failed: ${ref}` };
  if (name !== undefined) {
    const hit = rows.find((e) => e.name === name);
    if (!hit) return { ok: false, reason: `invented reference (test not in the run; use verbose output for named evidence): ${ref}` };
    if (hit.result === "skip") return { ok: false, reason: `skipped test is not evidence: ${ref}` };
    if (hit.result !== "pass") return { ok: false, reason: `test did not pass: ${ref}` };
    return { ok: true, reason: "" };
  }
  if (rows.some((e) => e.result === "fail")) return { ok: false, reason: `test did not pass: ${ref}` };
  if (!rows.some((e) => e.result === "pass")) return { ok: false, reason: `skipped test is not evidence: ${ref}` };
  return { ok: true, reason: "" };
}

export function matchCheckEvidence(
  ref: string,
  knownChecks: readonly string[],
  ran: readonly { name: string; status: string }[],
): EvidenceMatch {
  if (!knownChecks.includes(ref)) return { ok: false, reason: `invented reference (unknown check): ${ref}` };
  const hit = ran.find((c) => c.name === ref);
  if (!hit) return { ok: false, reason: `check was not executed: ${ref}` };
  if (hit.status !== "pass") return { ok: false, reason: `check did not pass: ${ref}` };
  return { ok: true, reason: "" };
}

/**
 * Runs `tests.run` for the cited files and parses the result.
 * With `{files}`, one invocation per cited path, that path substituted, parsed as a report.
 * Without it, the command runs once and a cited file is attributed only from a pytest result
 * line that names that file (`path::name PASSED`, or the short form `PASSED path::name`).
 * XFAIL and XPASS are skips. A path that is only a substring of another, or a file the output
 * merely mentions beside a suite footer, was not executed. No command means nothing was executed.
 */
export async function runCitedTests(opts: {
  cwd: string;
  files: readonly string[];
  testCommand: string | undefined;
  env: Record<string, string>;
  timeoutMs?: number;
  jail?: Jail;
  onCheck?: (e: CheckPulse) => void;
  heartbeatMs?: number;
}): Promise<ExecutedTest[]> {
  if (!opts.testCommand || opts.files.length === 0) return [];
  const testCommand = reportingTestCommand(opts.testCommand);
  const run = (command: string, where: string) =>
    watchCheck("evidence", () => sh(command, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, jail: opts.jail }), {
      where,
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
  if (testCommand.includes("{files}")) {
    const out: ExecutedTest[] = [];
    for (const file of opts.files) {
      const result = await run(testCommand.replaceAll("{files}", shellQuote(file)), file);
      out.push(...parseTestReport(file, result.output, result.code));
    }
    return out;
  }
  const result = await run(testCommand, "suite");
  const out: ExecutedTest[] = [];
  for (const file of opts.files) {
    const rows = pytestResultLines(file, result.output);
    out.push(...rows);
    if (rows.length && result.code !== 0) out.push({ file, name: "", result: "fail" });
  }
  return out;
}
