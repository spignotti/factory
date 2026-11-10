import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh, tail } from "../exec.js";
import { git, withRepoGitOps } from "../git.js";
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

export type ReproExit = "pass" | "fail" | "other";

/**
 * Exit status only. Output text is not a classifier: a real assertion can say `SyntaxError` or
 * `No such file or directory` and still be the bug.
 * 0 = pass. 126/127 (cannot run the command), a signal death, or 128+n = inconclusive.
 * Any other non-zero exit is a failing test, including 2 and 101.
 */
export function classifyReproExit(code: number, signal?: NodeJS.Signals | null): ReproExit {
  if (signal) return "other";
  if (code === 0) return "pass";
  if (code === 126 || code === 127 || code >= 128) return "other";
  if (code > 0) return "fail";
  return "other";
}

function reproExitDetail(code: number, signal: NodeJS.Signals | null | undefined): string {
  return signal ? `killed by ${signal}` : `exit ${code}`;
}

/**
 * Red-green proof for bug plans: the repro test files must fail on base and pass on HEAD.
 * The files are copied from HEAD into a temporary detached worktree at `baseSha`.
 */
export async function redGreenProof(opts: {
  worktree: string;
  baseSha: string;
  files: string[];
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
  const missing = files.filter((f) => !existsSync(join(worktree, f)));
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
    for (const f of files) {
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
    const baseKind = classifyReproExit(base.code, base.signal);
    if (baseKind === "other") {
      return inconclusive(`repro on base was not a failing test (${reproExitDetail(base.code, base.signal)}; inconclusive, not a red repro):\n${tail(base.output, 20)}`);
    }
    const head = await run("head", worktree, cmd);
    if (shTimedOut(head)) {
      return inconclusive(`repro timed out on HEAD (inconclusive: the process tree was killed; this is not a failing test):\n${tail(head.output, 20)}`, true);
    }
    const headKind = classifyReproExit(head.code, head.signal);
    if (headKind === "other") {
      return inconclusive(`repro on HEAD was not a failing test (${reproExitDetail(head.code, head.signal)}; inconclusive, not a red repro):\n${tail(head.output, 20)}`);
    }
    const redOnBase = baseKind === "fail";
    const greenOnHead = headKind === "pass";
    const detail = [
      redOnBase ? "repro fails on base" : `repro passes on base (does not reproduce the bug):\n${tail(base.output, 20)}`,
      greenOnHead ? "repro passes on HEAD" : `repro fails on HEAD:\n${tail(head.output, 20)}`,
    ].join("\n");
    return { ok: redOnBase && greenOnHead, redOnBase, greenOnHead, inconclusive: false, timedOut: false, detail };
  } finally {
    await withRepoGitOps(worktree, () => git(worktree, ["worktree", "remove", "--force", baseDir]).catch(() => "")).catch(() => "");
    rmSync(tmp, { recursive: true, force: true });
  }
}
