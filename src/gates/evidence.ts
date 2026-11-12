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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  const skip = /#\s*SKIP\b/.test(raw);
  const name = raw.replace(/\s+#\s*SKIP\b.*$/, "").replace(/\s+\([\d.]+ms\)\s*$/, "").trim();
  return { name, skip };
}

/**
 * Node's spec reporter and TAP. A command that exits 0 without per-test lines (a SQL file,
 * an integration script) is one file-level pass. A non-zero exit without per-test lines is
 * a file-level failure, not a pass.
 */
export function parseTestReport(file: string, output: string, code: number): ExecutedTest[] {
  if (output.includes("TAP version")) {
    const tap = parseTap(file, output);
    if (tap.length) return tap;
  }
  const spec = parseSpec(file, output);
  if (spec.length) return spec;
  if (shTimedOut({ code, signal: null, output, durationMs: 0 })) return [{ file, name: "", result: "fail" }];
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
    const m = /^(not )?ok\s+\d+\s+-\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const cleaned = cleanTestName(m[2] ?? "");
    const name = cleaned.name;
    if (!name) continue;
    const result = cleaned.skip ? "skip" : m[1] ? "fail" : "pass";
    out.push({ file, name, result });
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
  if (name !== undefined) {
    const hit = rows.find((e) => e.name === name);
    if (!hit) return { ok: false, reason: `invented reference (test not in the run): ${ref}` };
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
 * Runs `tests.run` once per cited file that exists and parses the result.
 * `{files}` is that one file, so a pass belongs to the cited path and not to another test.
 * No command means nothing was executed.
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
  const out: ExecutedTest[] = [];
  for (const file of opts.files) {
    const command = opts.testCommand.includes("{files}")
      ? opts.testCommand.replaceAll("{files}", shellQuote(file))
      : opts.testCommand;
    const result = await watchCheck("evidence", () => sh(command, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, jail: opts.jail }), {
      where: file,
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
    out.push(...parseTestReport(file, result.output, result.code));
  }
  return out;
}
