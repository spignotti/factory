import type { Handoff } from "../schemas/handoff.js";
import { sh } from "../exec.js";
import type { Jail } from "../sandbox/sandbox.js";
import { shTimedOut, watchCheck, type CheckPulse } from "./timeout.js";

/**
 * One test the evidence command actually ran. `name` is empty when the runner only reported the file.
 * `unparsed` means the output was not a result we can trust — never a fabricated pass.
 * `command`, when set, is the invocation that produced the row. A narrower rerun is not `tests.run`.
 */
export interface ExecutedTest {
  file: string;
  name: string;
  result: "pass" | "fail" | "skip" | "unparsed";
  /** Staged tree the command ran against. A pass from another tree is not evidence. */
  checkpoint: string;
  /** Invocation that produced this row. Absent cannot prove the configured command. */
  command?: string;
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

/**
 * Argv of one simple command. Undefined when the line is not that argv: an operator, an appended
 * command, a substitution, a redirect, a comment, or a quote we cannot close. Single quotes are
 * literal. `{files}` is the only bare brace token. Anything else fails closed so it cannot be
 * rewritten as a direct runner.
 */
function splitCommand(cmd: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let saw = false;
  let bareBrace = false;
  const flush = (): boolean => {
    if (!saw) return true;
    if (bareBrace && cur !== "{files}") return false;
    out.push(cur);
    cur = "";
    saw = false;
    bareBrace = false;
    return true;
  };
  for (const c of cmd) {
    if (c === "\n" || c === "\r") return undefined;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      saw = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        saw = true;
        continue;
      }
      // Double quotes still expand, escape, and history-expand in the shell.
      if (c === "$" || c === "`" || c === "\\" || c === "!") return undefined;
      cur += c;
      saw = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      saw = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (!flush()) return undefined;
      continue;
    }
    if (c === "{" || c === "}") {
      bareBrace = true;
      cur += c;
      saw = true;
      continue;
    }
    // Operators, redirects, substitutions, globs, comments, and grouping are not a safe argv.
    if ("&|;<>`$\\()!~*?[#]".includes(c)) return undefined;
    cur += c;
    saw = true;
  }
  if (quote) return undefined;
  if (!flush()) return undefined;
  return out;
}

function joinArgv(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(" ");
}

const SHELL_META = /^(?:&&|\|\||[;|])$/;
const PYTEST_VERBOSITY = new Set(["-q", "--quiet", "-qq", "-v", "--verbose", "-vv", "-vvv"]);
const PYTEST_BOOL = new Set([
  "-s", "-x", "-l",
  "--exitfirst", "--showlocals", "--lf", "--last-failed", "--ff", "--failed-first",
  "--nf", "--new-first", "--sw", "--stepwise", "--strict", "--strict-markers", "--strict-config",
  "--noconftest", "--disable-warnings", "--cache-clear", "--continue-on-collection-errors",
  "--no-header", "--no-summary", "--full-trace", "--setup-show", "--doctest-modules",
  "--doctest-ignore-import-errors",
]);
const PYTEST_VALUE = new Set([
  "-c", "-k", "-m", "-n", "-o", "-p", "-W",
  "--maxfail", "--tb", "--override-ini", "--junitxml", "--junit-xml", "--rootdir", "--confcutdir",
  "--basetemp", "--import-mode", "--capture", "--durations", "--log-level", "--log-cli-level",
  "--log-cli-format", "--log-cli-date-format", "--log-file", "--log-file-level", "--log-file-format",
  "--log-file-date-format", "--log-file-mode", "--log-format", "--log-date-format",
  "--dist", "--assert", "--html", "--cov", "--cov-report", "--cov-config",
  "--ignore", "--ignore-glob", "--deselect", "--result-log", "--report-log", "--doctest-glob",
]);
/** Options whose value is a file the runner writes. The cited path must never become that value. */
const PYTEST_WRITE = new Set([
  "--log-file", "--junitxml", "--junit-xml", "--html", "--result-log", "--report-log", "--basetemp",
]);
const NODE_BOOL = new Set([
  "--test-force-exit", "--experimental-strip-types", "--experimental-vm-modules",
  "--enable-source-maps", "--no-warnings",
]);
const NODE_VALUE = new Set([
  "--import", "-r", "--require", "--loader", "--experimental-loader", "--test-reporter",
  "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-timeout",
  "--test-concurrency", "--env-file", "--disable-warning", "--disable-proto", "--conditions", "-C",
  "--test-coverage-include", "--test-coverage-exclude",
]);
const NODE_WRITE = new Set(["--test-reporter-destination"]);
const UV_BOOL = new Set([
  "--locked", "--offline", "--frozen", "--no-sync", "--no-dev", "--inexact", "--all-packages",
  "--no-editable", "--compile-bytecode", "--no-progress", "--quiet", "-q", "--all-extras",
  "--no-install", "--refresh", "--isolated", "--no-project", "--active",
]);
const UV_VALUE = new Set([
  "--with", "--with-editable", "--python", "-p", "--directory", "--group", "--extra",
  "--index", "--index-url", "--find-links", "--refresh-package",
]);
const WATCH = new Set(["--watch", "--watch-path", "--watch-all", "-w", "--watchAll"]);
const DEBUGGER = new Set(["--pdb", "--trace", "--pdbcls"]);

type RunnerKind = "pytest" | "node";

/** A direct pytest or `node --test` invocation. Wrappers and shell compounds are not runners. */
function matchRunner(argv: string[]): { kind: RunnerKind; prefix: string[]; args: string[] } | undefined {
  if (argv.some((t) => SHELL_META.test(t))) return undefined;
  if (argv[0] === "uv" && argv[1] === "run") {
    const end = uvRunEnd(argv);
    if (end === undefined || argv[end] !== "pytest") return undefined;
    return { kind: "pytest", prefix: argv.slice(0, end + 1), args: argv.slice(end + 1) };
  }
  if (argv[0] && /^python[\d.]*$/.test(argv[0]) && argv[1] === "-m" && argv[2] === "pytest") {
    return { kind: "pytest", prefix: argv.slice(0, 3), args: argv.slice(3) };
  }
  if (argv[0] === "pytest") return { kind: "pytest", prefix: ["pytest"], args: argv.slice(1) };
  const testAt = argv.indexOf("--test");
  if (argv[0] === "node" && testAt > 0) return { kind: "node", prefix: argv.slice(0, testAt + 1), args: argv.slice(testAt + 1) };
  return undefined;
}

/** Index of the program `uv run` invokes, or undefined when a flag cannot be classified. */
function uvRunEnd(argv: string[]): number | undefined {
  let i = 2;
  while (i < argv.length && argv[i]!.startsWith("-")) {
    const flag = argv[i]!;
    const name = flag.includes("=") ? flag.slice(0, flag.indexOf("=")) : flag;
    if (flag.includes("=")) {
      if (!UV_VALUE.has(name) && !UV_BOOL.has(name)) return undefined;
      i++;
      continue;
    }
    if (UV_VALUE.has(name)) {
      if (!argv[i + 1] || argv[i + 1]!.startsWith("-")) return undefined;
      i += 2;
      continue;
    }
    if (!UV_BOOL.has(name)) return undefined;
    i++;
  }
  return i;
}

function isKnownRunner(command: string): boolean {
  const argv = splitCommand(command);
  return argv !== undefined && matchRunner(argv) !== undefined;
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq > 0 ? token.slice(0, eq) : token;
}

function knownOption(kind: RunnerKind, flag: string): boolean {
  if (kind === "pytest") return PYTEST_VALUE.has(flag) || PYTEST_BOOL.has(flag);
  return NODE_VALUE.has(flag) || NODE_BOOL.has(flag) || flag.startsWith("--experimental-");
}

function rewriteDotReporter(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a === "--test-reporter=dot") {
      out.push("--test-reporter=spec");
      continue;
    }
    if (a === "--test-reporter" && tokens[i + 1] === "dot") {
      out.push("--test-reporter=spec");
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Direct pytest runners must report individual names for `path::name` evidence.
 * Node's dot reporter hides names; spec does not. Wrappers, scripts, and any command that is not
 * one safely tokenized direct runner are left alone.
 */
export function reportingTestCommand(command: string): string {
  const argv = splitCommand(command);
  const runner = argv && matchRunner(argv);
  if (!runner) return command;
  if (runner.kind === "pytest") {
    return command.replace(/^((?:uv run(?: --[\w-]+)* |python[\d.]* -m )?pytest)(?=\s|$)/, "$1 -v");
  }
  return command.replace(/--test-reporter=dot\b/g, "--test-reporter=spec");
}

/**
 * A command that can be rerun for one cited file to collect names. Undefined when there is no
 * explicit runner rule, the command cannot be tokenized safely, or the argv cannot be rewritten
 * without dropping a safety-relevant option or letting the appended path become a write destination.
 * The caller appends the file. An unsafe command produces no named rerun.
 */
export function fileScopedCommand(command: string): string | undefined {
  const argv = splitCommand(command);
  if (!argv) return undefined;
  const runner = matchRunner(argv);
  if (!runner) return undefined;
  if (runner.kind === "node") return nodeScoped(runner.prefix, runner.args);
  return pytestScoped(runner.prefix, runner.args);
}

function unsafeToken(token: string): boolean {
  const name = flagName(token);
  return WATCH.has(name) || DEBUGGER.has(name) || token === ">" || token === ">>" || token === "<";
}

/** True when a value option would consume the next token, including the path the caller appends. */
function danglingValue(tokens: string[], valueOpts: Set<string>, writeOpts: Set<string>): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (unsafeToken(a)) return true;
    if (!a.startsWith("-") || a === "--") continue;
    const name = flagName(a);
    if (a.includes("=")) {
      const value = a.slice(a.indexOf("=") + 1);
      if (writeOpts.has(name) && (!value || value.includes("{files}"))) return true;
      continue;
    }
    if (!valueOpts.has(name)) continue;
    const next = tokens[i + 1];
    if (!next || next.startsWith("-") || next === "{files}" || next.includes("{files}")) return true;
    i++;
  }
  return false;
}

/**
 * Keep recognized options and their original values. Drop only the test selection.
 * An option we cannot classify, a dangling value, or a write destination of `{files}` is unsafe.
 */
function classifyArgs(args: string[], kind: RunnerKind): string[] | undefined {
  const kept: string[] = [];
  const valueOpts = kind === "pytest" ? PYTEST_VALUE : NODE_VALUE;
  const boolOpts = kind === "pytest" ? PYTEST_BOOL : NODE_BOOL;
  const writeOpts = kind === "pytest" ? PYTEST_WRITE : NODE_WRITE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (unsafeToken(a)) return undefined;
    if (a === "--") break;
    if (a === "{files}" || !a.startsWith("-")) continue;
    if (kind === "pytest" && PYTEST_VERBOSITY.has(a)) continue;
    if (a.includes("=") && a.startsWith("--")) {
      const name = flagName(a);
      const value = a.slice(a.indexOf("=") + 1);
      if (!knownOption(kind, name) || !value || value.includes("{files}")) return undefined;
      if (writeOpts.has(name) && value.includes("{files}")) return undefined;
      kept.push(a);
      continue;
    }
    if (valueOpts.has(a)) {
      const next = args[i + 1];
      if (!next || next.startsWith("-") || next === "{files}" || next.includes("{files}")) return undefined;
      kept.push(a, next);
      i++;
      continue;
    }
    if (boolOpts.has(a)) {
      kept.push(a);
      continue;
    }
    if (kind === "node" && a.startsWith("--experimental-")) {
      const next = args[i + 1];
      if (next && !next.startsWith("-") && next !== "{files}") return undefined;
      kept.push(a);
      continue;
    }
    return undefined;
  }
  if (danglingValue(kept, valueOpts, writeOpts)) return undefined;
  return kept;
}

function nodeScoped(prefix: string[], args: string[]): string | undefined {
  const tokens = rewriteDotReporter([...prefix, ...args]);
  const testAt = tokens.indexOf("--test");
  if (testAt < 0) return undefined;
  const head = tokens.slice(0, testAt + 1);
  if (danglingValue(head, NODE_VALUE, NODE_WRITE)) return undefined;
  const kept = classifyArgs(tokens.slice(testAt + 1), "node");
  if (!kept) return undefined;
  return joinArgv([...head, ...kept]);
}

function pytestScoped(prefix: string[], args: string[]): string | undefined {
  if (danglingValue(prefix, PYTEST_VALUE, PYTEST_WRITE)) return undefined;
  const kept = classifyArgs(args, "pytest");
  if (!kept) return undefined;
  return joinArgv([...prefix, "-v", ...kept]);
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

type RawResult = Omit<ExecutedTest, "checkpoint" | "command">;

function stamp(rows: RawResult[], checkpoint: string): ExecutedTest[] {
  return rows.map((r) => ({ ...r, checkpoint }));
}

/** A non-zero exit is an invocation failure even when some named lines passed. */
function finish(file: string, rows: RawResult[], code: number, checkpoint: string): ExecutedTest[] {
  const withFail =
    code !== 0 && !rows.some((r) => r.name === "" && r.result === "fail")
      ? [...rows, { file, name: "", result: "fail" as const }]
      : rows;
  return stamp(withFail, checkpoint);
}

/**
 * Node's spec reporter, TAP, and a pytest summary footer (`= … in 0.02s =`, or the quiet
 * `2 skipped in 0.01s` form). Per-test Node/TAP lines are kept, including a non-zero exit; that
 * exit is also an invocation failure so a sibling pass cannot hide it. Otherwise a pytest footer
 * is one file-level result: failed or error fails; a non-zero exit fails even when passed > 0;
 * xfailed and xpassed are not passes; skip-only or xfailed-only with exit 0 is a skip. Warnings
 * are not passes. Exit 0 without those marks is unparsed, not a pass. Only an explicit parser
 * rule (pytest footer, node spec, TAP) or a known runner's invocation failure may use the exit
 * code. `bareExit: "unparsed"` refuses that for a command with no such rule. A timeout is still
 * a failure.
 */
export function parseTestReport(
  file: string,
  output: string,
  code: number,
  checkpoint: string,
  opts?: { bareExit?: "fail" | "unparsed" },
): ExecutedTest[] {
  const pytestLines = pytestRows(file, output);
  if (pytestLines.length) return finish(file, code === 0 ? pytestLines : [...pytestLines, { file, name: "", result: "fail" }], code, checkpoint);
  if (output.includes("TAP version")) {
    const tap = parseTap(file, output);
    if (tap.length) return finish(file, tap, code, checkpoint);
  }
  const spec = parseSpec(file, output);
  if (spec.length) return finish(file, spec, code, checkpoint);
  if (shTimedOut({ code, signal: null, output, durationMs: 0 })) return stamp([{ file, name: "", result: "fail" }], checkpoint);
  const pytest = pytestCounts(output);
  if (pytest) {
    if (code !== 0 || pytest.failed > 0 || pytest.errors > 0) return stamp([{ file, name: "", result: "fail" }], checkpoint);
    if (pytest.passed > 0) return stamp([{ file, name: "", result: "pass" }], checkpoint);
    if (pytest.skipped > 0 || pytest.xfailed > 0 || pytest.xpassed > 0) return stamp([{ file, name: "", result: "skip" }], checkpoint);
  }
  if (code !== 0 && opts?.bareExit !== "unparsed") return stamp([{ file, name: "", result: "fail" }], checkpoint);
  return stamp([{ file, name: "", result: "unparsed" }], checkpoint);
}

/**
 * Parses one invocation and binds the row to that command. A known runner may treat a bare
 * non-zero exit as an invocation failure. Any other command's bare exit code is unparsed, not a pass.
 */
export function executedFromOutput(file: string, output: string, code: number, checkpoint: string, command: string): ExecutedTest[] {
  const bareExit = isKnownRunner(command) ? "fail" : "unparsed";
  return parseTestReport(file, output, code, checkpoint, { bareExit }).map((r) => ({ ...r, command }));
}

/** Red-green's configured command: `{files}` replaced once, with the same quoting evidence uses. */
export function configuredProbeCommand(testCommand: string, files: readonly string[]): string {
  return testCommand.replace("{files}", files.map(shellQuote).join(" "));
}

function parseSpec(file: string, output: string): RawResult[] {
  const out: RawResult[] = [];
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

function parseTap(file: string, output: string): RawResult[] {
  const out: RawResult[] = [];
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

function pytestRows(file: string, output: string): RawResult[] {
  const out: RawResult[] = [];
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

/** A cited file counts only when a result line names that path exactly. */
export function pytestResultLines(file: string, output: string, checkpoint: string): ExecutedTest[] {
  return stamp(pytestRows(file, output), checkpoint);
}

/**
 * A test ref is evidence only when the file exists, this checkpoint ran it, and that result passed.
 * Absent output is "not executed", not stale. Another checkpoint is stale. An unknown file or test
 * name is an invented reference. A skip is not a pass. A file-level pass does not prove a named
 * ref. Unparsed output is a diagnosis, never a pass.
 */
export function matchTestEvidence(ref: string, executed: readonly ExecutedTest[], exists: boolean, checkpoint: string): EvidenceMatch {
  const { file, name } = splitEvidenceRef(ref);
  if (!file || !exists) return { ok: false, reason: `invented reference (file not in the tree): ${ref}` };
  const rows = executed.filter((e) => e.file === file);
  if (rows.length === 0) return { ok: false, reason: `test was not executed: ${ref}` };
  const fresh = rows.filter((e) => e.checkpoint === checkpoint);
  if (fresh.length === 0) return { ok: false, reason: `stale evidence (tested at another checkpoint): ${ref}` };
  if (fresh.some((e) => e.name === "" && e.result === "fail")) return { ok: false, reason: `test invocation failed: ${ref}` };
  if (name !== undefined) {
    if (fresh.some((e) => e.result === "unparsed") && !fresh.some((e) => e.name !== "")) {
      return { ok: false, reason: `unparseable or insufficient test output: ${ref}` };
    }
    const hit = fresh.find((e) => e.name === name);
    if (!hit) {
      if (!fresh.some((e) => e.name !== "")) {
        return { ok: false, reason: `named evidence needs a runner that reports test names: ${ref}` };
      }
      return { ok: false, reason: `invented reference (test not in the run; use verbose output for named evidence): ${ref}` };
    }
    if (hit.result === "skip") return { ok: false, reason: `skipped test is not evidence: ${ref}` };
    if (hit.result !== "pass") return { ok: false, reason: `test did not pass: ${ref}` };
    return { ok: true, reason: "" };
  }
  if (fresh.some((e) => e.result === "fail")) return { ok: false, reason: `test did not pass: ${ref}` };
  if (fresh.some((e) => e.result === "unparsed") && !fresh.some((e) => e.result === "pass")) {
    return { ok: false, reason: `unparseable or insufficient test output: ${ref}` };
  }
  if (!fresh.some((e) => e.result === "pass")) return { ok: false, reason: `skipped test is not evidence: ${ref}` };
  return { ok: true, reason: "" };
}

/**
 * Whether passing rows for `file` at this checkpoint were produced by the configured full command.
 * A narrower named rerun is not that command, even when every collected name passed.
 */
export function evidenceProvesFullCommand(
  executed: readonly ExecutedTest[],
  file: string,
  checkpoint: string,
  fullCommand: string,
): boolean {
  const rows = executed.filter((e) => e.file === file && e.checkpoint === checkpoint);
  return rows.length > 0 && rows.every((e) => e.result === "pass" && e.command === fullCommand);
}

/** Passing refs from this checkpoint. Skips, failures, unparsed output and another tree are not eligible. */
export function eligibleEvidenceRefs(executed: readonly ExecutedTest[], checkpoint: string): string[] {
  const out: string[] = [];
  for (const e of executed) {
    if (e.checkpoint !== checkpoint || e.result !== "pass") continue;
    const ref = e.name ? `${e.file}::${e.name}` : e.file;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
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

function mergeNameRun(file: string, checkpoint: string, first: ExecutedTest[], again: ExecutedTest[]): ExecutedTest[] {
  const failed = [...first, ...again].some((r) => r.result === "fail");
  const chosen = again.some((r) => r.name !== "") || again.some((r) => r.result === "unparsed") ? again : first;
  if (failed && !chosen.some((r) => r.name === "" && r.result === "fail")) {
    return [...chosen, { file, name: "", result: "fail", checkpoint }];
  }
  return chosen;
}

/**
 * Runs `tests.run` for the cited files and parses the result.
 * With `{files}`, one invocation per cited path, that path substituted, parsed as a report.
 * Without it, the command runs once and a cited file is attributed only from a pytest result
 * line that names that file (`path::name PASSED`, or the short form `PASSED path::name`).
 * Node suite output has no file path, so names from it are not attributed. When a named ref still
 * has no name and the command can be rewritten safely, that file is rerun alone. A wrapper, an
 * unknown option, a write destination that would consume the cited path, or a command that cannot
 * be tokenized safely is not rewritten and produces no named rerun.
 * That rerun is not the configured tests.run. XFAIL and XPASS are skips. A path that is only a
 * substring of another, or a file the output merely mentions beside a suite footer, was not executed.
 * No command means nothing was executed.
 */
export async function runCitedTests(opts: {
  cwd: string;
  files: readonly string[];
  /** Cited files whose evidence names a test, not only the file. */
  named?: readonly string[];
  /** Staged tree these results were collected from. */
  checkpoint: string;
  testCommand: string | undefined;
  env: Record<string, string>;
  timeoutMs?: number;
  jail?: Jail;
  onCheck?: (e: CheckPulse) => void;
  heartbeatMs?: number;
}): Promise<ExecutedTest[]> {
  if (!opts.testCommand || opts.files.length === 0) return [];
  const checkpoint = opts.checkpoint;
  const named = new Set(opts.named ?? []);
  const known = isKnownRunner(opts.testCommand);
  const run = (command: string, where: string) =>
    watchCheck("evidence", () => sh(command, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, jail: opts.jail }), {
      where,
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
  const collect = async (command: string, file: string): Promise<ExecutedTest[]> => {
    const result = await run(command, file);
    return executedFromOutput(file, result.output, result.code, checkpoint, command);
  };
  const quoted = (file: string) => shellQuote(file);
  if (opts.testCommand.includes("{files}")) {
    const reporting = reportingTestCommand(opts.testCommand);
    const scoped = fileScopedCommand(opts.testCommand);
    const out: ExecutedTest[] = [];
    for (const file of opts.files) {
      let rows = await collect(reporting.replaceAll("{files}", quoted(file)), file);
      if (named.has(file) && !rows.some((r) => r.name !== "") && scoped) {
        rows = mergeNameRun(file, checkpoint, rows, await collect(`${scoped} ${quoted(file)}`, file));
      }
      out.push(...rows);
    }
    return out;
  }
  const suiteCommand = reportingTestCommand(opts.testCommand);
  const result = await run(suiteCommand, "suite");
  const out: ExecutedTest[] = [];
  let attributed = false;
  for (const file of opts.files) {
    const rows = pytestResultLines(file, result.output, checkpoint).map((r) => ({ ...r, command: suiteCommand }));
    if (!rows.length) continue;
    attributed = true;
    out.push(...rows);
    if (result.code !== 0) out.push({ file, name: "", result: "fail", checkpoint, command: suiteCommand });
  }
  // A known runner that exits 0 without a result line did run. That is unparsed, not a file-level pass.
  if (!attributed && known && result.code === 0) {
    for (const file of opts.files) out.push({ file, name: "", result: "unparsed", checkpoint, command: suiteCommand });
  }
  const scoped = fileScopedCommand(opts.testCommand);
  if (!scoped) return out;
  for (const file of opts.files) {
    if (!named.has(file) || out.some((r) => r.file === file && r.name !== "")) continue;
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.file === file) out.splice(i, 1);
    out.push(...await collect(`${scoped} ${quoted(file)}`, file));
  }
  return out;
}
