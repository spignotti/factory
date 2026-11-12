import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh, tail } from "../exec.js";
import { git, withRepoGitOps } from "../git.js";
import { matchesAny } from "../schemas/plan.js";
import { gateCheckTimeoutMs, type CheckPulse, shTimedOut, watchCheck } from "./timeout.js";
import type { Deadline } from "../pipeline/budget.js";
import type { Jail } from "../sandbox/sandbox.js";

export interface RedGreenResult {
  ok: boolean;
  redOnBase: boolean;
  greenOnHead: boolean;
  /** The proof could not run (no command, no repro, setup failed, a non-test exit, or the command timed out); says nothing about the bug. */
  inconclusive: boolean;
  /** The base or HEAD command was killed for the wall-clock cap. Not a failing assertion. */
  timedOut: boolean;
  detail: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * What a red-green run proved. `assertion` is a test that ran and failed. Import, collection,
 * command, timeout and an exit we cannot classify are not a proven reproduction: an assertion
 * message may mention `SyntaxError` and still be `assertion` when the test ran.
 */
export type ReproClass = "pass" | "assertion" | "import" | "collection" | "command" | "unclear";

function summaryCount(output: string, label: string): number | undefined {
  const m = new RegExp(`(?:\\u2139|#)\\s+${label}\\s+(\\d+)`).exec(output);
  return m ? Number(m[1]) : undefined;
}

/** A load failure is reported under the file path. A slash means that path, not a test name. */
function isFileFailureName(name: string): boolean {
  return !name || name === "failing tests:" || name.startsWith("/") || name.startsWith("file:") || name.includes("/");
}

function namedTestFailed(output: string): boolean {
  for (const m of output.matchAll(/^\u2716\s+(.+)$/gm)) {
    const name = (m[1] ?? "").replace(/\s+\([\d.]+ms\)\s*$/, "").trim();
    if (isFileFailureName(name)) continue;
    return true;
  }
  return /^FAILED\s+\S+/m.test(output);
}

/** A test ran and failed. `ERR_ASSERTION` wins over words like SyntaxError inside the message. */
function hasAssertion(output: string): boolean {
  if (/\bERR_ASSERTION\b|\bAssertionError\b/.test(output)) return true;
  if (/^E\s+assert\s+/m.test(output)) return true;
  return namedTestFailed(output);
}

function hasImport(output: string): boolean {
  return /\bERR_MODULE_NOT_FOUND\b|Cannot find module|compileSourceTextModule/.test(output);
}

function hasCollection(output: string): boolean {
  return /ERROR collecting|errors during collection|collected 0 items|Interrupted: \d+ errors? during collection|\bImportError\b|\bModuleNotFoundError\b/.test(output);
}

export function assertionName(output: string): string | undefined {
  for (const m of output.matchAll(/^\u2716\s+(.+)$/gm)) {
    const name = (m[1] ?? "").replace(/\s+\([\d.]+ms\)\s*$/, "").trim();
    if (isFileFailureName(name)) continue;
    return name;
  }
  const pytest = /^FAILED\s+(\S+)/m.exec(output);
  return pytest?.[1];
}

/**
 * Classifies one repro command. Exit status alone is not an assertion: import, collection,
 * command and an unclassified non-zero exit are not a proven reproduction.
 */
export function classifyReproRun(code: number, output: string, signal?: NodeJS.Signals | null): ReproClass {
  if (signal || code === 126 || code === 127 || code >= 128) return "command";
  if (code === 0) {
    const pass = summaryCount(output, "pass");
    const skipped = summaryCount(output, "skipped");
    const fail = summaryCount(output, "fail");
    if (pass === 0 && (skipped ?? 0) > 0 && (fail ?? 0) === 0) return "unclear";
    return "pass";
  }
  if (hasAssertion(output)) return "assertion";
  if (hasImport(output)) return "import";
  if (hasCollection(output)) return "collection";
  return "unclear";
}

/**
 * Files copied onto the base commit for the repro: the repro tests, plus changed files that
 * match the test globs (fixtures and helpers). Product files are not copied, so the base
 * probe cannot include the fix it is trying to prove.
 */
export function baseProbeFiles(reproFiles: string[], changed: readonly string[], testGlobs: readonly string[]): { tests: string[]; support: string[] } {
  const tests = [...new Set(reproFiles)];
  const repro = new Set(tests);
  const support = changed.filter((f) => !repro.has(f) && matchesAny(f, [...testGlobs]));
  return { tests, support };
}

function reproExitDetail(code: number, signal: NodeJS.Signals | null | undefined): string {
  return signal ? `killed by ${signal}` : `exit ${code}`;
}

/** Why a run is not a proven assertion failure. Command deaths keep the exit line the gates already use. */
function reproClassDetail(where: "base" | "HEAD", klass: ReproClass, output: string, code: number, signal?: NodeJS.Signals | null): string {
  if (klass === "command") {
    return `repro on ${where} was not a failing test (${reproExitDetail(code, signal)}; inconclusive, not a red repro):\n${tail(output, 20)}`;
  }
  if (klass === "import" || klass === "collection") {
    return `repro on ${where} did not run (${klass}; not a proven reproduction):\n${tail(output, 20)}`;
  }
  return `repro on ${where} was not a proven assertion failure (${reproExitDetail(code, signal)}; inconclusive):\n${tail(output, 20)}`;
}

/**
 * Red-green proof for bug plans: the repro test files must fail on base and pass on HEAD.
 * The files are copied from HEAD into a temporary detached worktree at `baseSha`.
 */
export async function redGreenProof(opts: {
  worktree: string;
  baseSha: string;
  files: string[];
  /** Changed test fixtures and helpers copied onto the base commit. Not product code. */
  supportFiles?: string[];
  testCommand: string | undefined;
  /** repo.yaml `setup`, run in the base worktree so a missing environment is not mistaken for the bug. */
  setup?: string;
  env: Record<string, string>;
  /** repo.yaml `limits.gate_timeout_minutes`; capped by `deadline` when set. */
  gateTimeoutMinutes: number;
  /** `tests.timeout_s`: wall-clock cap in seconds. Overrides `gateTimeoutMinutes`. */
  timeoutS?: number;
  /** `max_wall_minutes` deadline; commands are killed when it passes. */
  deadline?: Deadline;
  /** Sandbox per working dir (base worktree or the run worktree). */
  jail?: (cwd: string) => Jail | undefined;
  /** Progress while the base or HEAD command runs (`factory status`). */
  onCheck?: (e: CheckPulse) => void;
  heartbeatMs?: number;
}): Promise<RedGreenResult> {
  const { worktree, baseSha, files, testCommand, env } = opts;
  const support = opts.supportFiles ?? [];
  const inconclusive = (detail: string, timedOut = false): RedGreenResult => ({
    ok: false,
    redOnBase: false,
    greenOnHead: false,
    inconclusive: true,
    timedOut,
    detail,
  });
  if (!testCommand) return inconclusive("repo.yaml tests.run is not set");
  if (files.length === 0) return inconclusive("no repro test named in evidence");
  const missing = [...files, ...support].filter((f) => !existsSync(join(worktree, f)));
  if (missing.length) return inconclusive(`repro file missing: ${missing.join(", ")}`);
  const timeoutMs = () =>
    gateCheckTimeoutMs({
      check: opts.timeoutS !== undefined ? { timeout_s: opts.timeoutS } : undefined,
      gateTimeoutMinutes: opts.gateTimeoutMinutes,
      deadline: opts.deadline,
    });
  const cmd = testCommand.replace("{files}", files.map(shellQuote).join(" "));
  const run = (where: "setup" | "base" | "head", cwd: string, command: string) =>
    watchCheck("red_green", () => sh(command, { cwd, env, timeoutMs: timeoutMs(), jail: opts.jail?.(cwd) }), {
      where,
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
  const tmp = mkdtempSync(join(tmpdir(), "factory-base-"));
  const baseDir = join(tmp, "wt");
  await withRepoGitOps(worktree, () => git(worktree, ["worktree", "add", "-q", "--detach", baseDir, baseSha]));
  try {
    for (const f of [...files, ...support]) {
      mkdirSync(dirname(join(baseDir, f)), { recursive: true });
      copyFileSync(join(worktree, f), join(baseDir, f));
    }
    const supportNote = support.length ? `\nbase probe support: ${support.join(", ")}` : "";
    if (opts.setup) {
      const setup = await run("setup", baseDir, opts.setup);
      if (shTimedOut(setup)) return inconclusive(`setup timed out in the base worktree (inconclusive; the process tree was killed):\n${tail(setup.output, 20)}`, true);
      if (setup.code !== 0) return inconclusive(`setup failed in the base worktree:\n${tail(setup.output, 20)}`);
    }
    const base = await run("base", baseDir, cmd);
    // A killed hang is not "the repro fails". Treating it as red would let a green HEAD pass the proof.
    if (shTimedOut(base)) {
      return inconclusive(`repro timed out on base (inconclusive: the process tree was killed; this is not a failing test):\n${tail(base.output, 20)}`, true);
    }
    const baseClass = classifyReproRun(base.code, base.output, base.signal);
    if (baseClass !== "assertion" && baseClass !== "pass") {
      return inconclusive(`${reproClassDetail("base", baseClass, base.output, base.code, base.signal)}${supportNote}`);
    }
    const head = await run("head", worktree, cmd);
    if (shTimedOut(head)) {
      return inconclusive(`repro timed out on HEAD (inconclusive: the process tree was killed; this is not a failing test):\n${tail(head.output, 20)}${supportNote}`, true);
    }
    const headClass = classifyReproRun(head.code, head.output, head.signal);
    if (baseClass === "assertion" && headClass !== "assertion" && headClass !== "pass") {
      return inconclusive(`${reproClassDetail("base", baseClass, base.output, base.code, base.signal)}\n${reproClassDetail("HEAD", headClass, head.output, head.code, head.signal)}${supportNote}`);
    }
    const redOnBase = baseClass === "assertion";
    const greenOnHead = headClass === "pass";
    const detail = [
      redOnBase ? `repro fails on base (test: ${assertionName(base.output) ?? "assertion"})` : `repro passes on base (does not reproduce the bug):\n${tail(base.output, 20)}`,
      greenOnHead ? "repro passes on HEAD" : `repro fails on HEAD (test: ${assertionName(head.output) ?? "assertion"}):\n${tail(head.output, 20)}`,
      supportNote.trim(),
    ].filter(Boolean).join("\n");
    return { ok: redOnBase && greenOnHead, redOnBase, greenOnHead, inconclusive: false, timedOut: false, detail };
  } finally {
    await withRepoGitOps(worktree, () => git(worktree, ["worktree", "remove", "--force", baseDir]).catch(() => "")).catch(() => "");
    rmSync(tmp, { recursive: true, force: true });
  }
}
