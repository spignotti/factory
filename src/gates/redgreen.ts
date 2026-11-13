import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh, tail } from "../exec.js";
import { git, withRepoGitOps } from "../git.js";
import { configuredProbeCommand } from "./evidence.js";
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
  /** Sum of the repro commands this call actually ran. A reused base probe counts only the HEAD run. */
  duration_ms: number;
  /** The base probe was read from this run's cache. The HEAD command still ran. */
  base_reused: boolean;
  detail: string;
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

/** Spec (`✖ name`) and TAP (`not ok N - name`). A file path is a load failure, not a test name. */
function eachFailedTestName(output: string): string[] {
  const names: string[] = [];
  for (const m of output.matchAll(/^\u2716\s+(.+)$/gm)) {
    const name = (m[1] ?? "").replace(/\s+\([\d.]+ms\)\s*$/, "").trim();
    if (!isFileFailureName(name)) names.push(name);
  }
  for (const m of output.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)) {
    const name = (m[1] ?? "").replace(/\s+#\s*SKIP\b.*$/, "").trim();
    if (!isFileFailureName(name)) names.push(name);
  }
  return names;
}

function namedTestFailed(output: string): boolean {
  return eachFailedTestName(output).length > 0 || /^FAILED\s+\S+/m.test(output);
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
  const named = eachFailedTestName(output)[0];
  if (named) return named;
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

interface StoredBaseProbe {
  key: string;
  redOnBase: boolean;
  assertion?: string;
  baseTail: string;
}

/**
 * Identity of a base probe: the base commit, the test command, setup, and the bytes of the repro
 * and support files. Product code is not part of it. A SHA alone is not enough.
 */
function baseProbeKey(input: {
  worktree: string;
  baseSha: string;
  files: readonly string[];
  supportFiles: readonly string[];
  testCommand: string;
  setup?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(input.baseSha);
  hash.update("\0");
  hash.update(input.testCommand);
  hash.update("\0");
  hash.update(input.setup ?? "");
  hash.update("\0");
  for (const file of [...new Set([...input.files, ...input.supportFiles])].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(input.worktree, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readBaseProbe(file: string, key: string): StoredBaseProbe | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredBaseProbe>;
    if (parsed.key !== key || typeof parsed.redOnBase !== "boolean" || typeof parsed.baseTail !== "string") return undefined;
    return {
      key,
      redOnBase: parsed.redOnBase,
      ...(typeof parsed.assertion === "string" ? { assertion: parsed.assertion } : {}),
      baseTail: parsed.baseTail,
    };
  } catch {
    return undefined;
  }
}

/** Only a conclusive base result is stored. A timeout or an unclassified run is not reused. */
function writeBaseProbe(file: string, entry: StoredBaseProbe): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entry));
}

/**
 * Red-green proof for bug plans: the repro test files must fail on base and pass on HEAD.
 * The files are copied from HEAD into a temporary detached worktree at `baseSha`.
 * When `cacheFile` is set, a conclusive base probe is reused for the same base, command, setup
 * and repro/support bytes. The HEAD command always runs against the current tree.
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
  /** Run artifact. Conclusive base probes are reused from here; inconclusive ones are not written. */
  cacheFile?: string;
  /** The configured tests.run already passed this single-file HEAD probe. A narrower named rerun does not. */
  headPassed?: boolean;
}): Promise<RedGreenResult> {
  const { worktree, baseSha, files, testCommand, env } = opts;
  const support = opts.supportFiles ?? [];
  let spent = 0;
  const inconclusive = (detail: string, timedOut = false, baseReused = false): RedGreenResult => ({
    ok: false,
    redOnBase: false,
    greenOnHead: false,
    inconclusive: true,
    timedOut,
    base_reused: baseReused,
    duration_ms: spent,
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
  const cmd = configuredProbeCommand(testCommand, files);
  const supportNote = support.length ? `\nbase probe support: ${support.join(", ")}` : "";
  const run = async (where: "setup" | "base" | "head", cwd: string, command: string) => {
    const result = await watchCheck("red_green", () => sh(command, { cwd, env, timeoutMs: timeoutMs(), jail: opts.jail?.(cwd) }), {
      where,
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
    spent += result.durationMs;
    return result;
  };
  const finishHead = async (
    redOnBase: boolean,
    baseLine: string,
    reused: boolean,
    baseRun?: { output: string; code: number; signal?: NodeJS.Signals | null },
  ): Promise<RedGreenResult> => {
    const head = opts.headPassed ? { code: 0, signal: null, output: "HEAD evidence reused", durationMs: 0 } : await run("head", worktree, cmd);
    const prefix = reused ? "base probe reused\n" : "";
    if (shTimedOut(head)) {
      return inconclusive(
        `${prefix}repro timed out on HEAD (inconclusive: the process tree was killed; this is not a failing test):\n${tail(head.output, 20)}${supportNote}`,
        true,
        reused,
      );
    }
    const headClass = classifyReproRun(head.code, head.output, head.signal);
    if (redOnBase && headClass !== "assertion" && headClass !== "pass") {
      const basePart = baseRun
        ? reproClassDetail("base", "assertion", baseRun.output, baseRun.code, baseRun.signal)
        : baseLine;
      return inconclusive(`${prefix}${basePart}\n${reproClassDetail("HEAD", headClass, head.output, head.code, head.signal)}${supportNote}`, false, reused);
    }
    const greenOnHead = headClass === "pass";
    const detail = [
      prefix.trim(),
      baseLine,
      greenOnHead ? "repro passes on HEAD" : `repro fails on HEAD (test: ${assertionName(head.output) ?? "assertion"}):\n${tail(head.output, 20)}`,
      supportNote.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    return { ok: redOnBase && greenOnHead, redOnBase, greenOnHead, inconclusive: false, timedOut: false, base_reused: reused, duration_ms: spent, detail };
  };

  const key = baseProbeKey({ worktree, baseSha, files, supportFiles: support, testCommand: cmd, setup: opts.setup });
  const stored = opts.cacheFile ? readBaseProbe(opts.cacheFile, key) : undefined;
  if (stored) {
    const baseLine = stored.redOnBase
      ? `repro fails on base (test: ${stored.assertion ?? "assertion"})`
      : `repro passes on base (does not reproduce the bug):\n${stored.baseTail}`;
    return finishHead(stored.redOnBase, baseLine, true);
  }

  const tmp = mkdtempSync(join(tmpdir(), "factory-base-"));
  const baseDir = join(tmp, "wt");
  await withRepoGitOps(worktree, () => git(worktree, ["worktree", "add", "-q", "--detach", baseDir, baseSha]));
  try {
    for (const f of [...files, ...support]) {
      mkdirSync(dirname(join(baseDir, f)), { recursive: true });
      copyFileSync(join(worktree, f), join(baseDir, f));
    }
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
    const redOnBase = baseClass === "assertion";
    const baseLine = redOnBase
      ? `repro fails on base (test: ${assertionName(base.output) ?? "assertion"})`
      : `repro passes on base (does not reproduce the bug):\n${tail(base.output, 20)}`;
    if (opts.cacheFile) {
      writeBaseProbe(opts.cacheFile, {
        key,
        redOnBase,
        ...(redOnBase ? { assertion: assertionName(base.output) } : {}),
        baseTail: tail(base.output, 20),
      });
    }
    return await finishHead(redOnBase, baseLine, false, base);
  } finally {
    await withRepoGitOps(worktree, () => git(worktree, ["worktree", "remove", "--force", baseDir]).catch(() => "")).catch(() => "");
    rmSync(tmp, { recursive: true, force: true });
  }
}
