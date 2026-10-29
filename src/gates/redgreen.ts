import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh, tail } from "../exec.js";
import { git } from "../git.js";

export interface RedGreenResult {
  ok: boolean;
  redOnBase: boolean;
  greenOnHead: boolean;
  /** The proof could not run (no command, no repro, setup failed); says nothing about the bug. */
  inconclusive: boolean;
  detail: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  /** `max_wall_minutes` deadline (epoch ms); commands are killed when it passes. */
  deadline?: number;
}): Promise<RedGreenResult> {
  const { worktree, baseSha, files, testCommand, env } = opts;
  const inconclusive = (detail: string): RedGreenResult => ({ ok: false, redOnBase: false, greenOnHead: false, inconclusive: true, detail });
  if (!testCommand) return inconclusive("repo.yaml tests.run is not set");
  if (files.length === 0) return inconclusive("no repro test named in evidence");
  const missing = files.filter((f) => !existsSync(join(worktree, f)));
  if (missing.length) return inconclusive(`repro file missing: ${missing.join(", ")}`);
  const timeoutMs = () => (opts.deadline === undefined ? undefined : Math.max(1000, opts.deadline - Date.now()));
  const cmd = testCommand.replace("{files}", files.map(shellQuote).join(" "));
  const tmp = mkdtempSync(join(tmpdir(), "factory-base-"));
  const baseDir = join(tmp, "wt");
  await git(worktree, ["worktree", "add", "-q", "--detach", baseDir, baseSha]);
  try {
    for (const f of files) {
      mkdirSync(dirname(join(baseDir, f)), { recursive: true });
      copyFileSync(join(worktree, f), join(baseDir, f));
    }
    if (opts.setup) {
      const setup = await sh(opts.setup, { cwd: baseDir, env, timeoutMs: timeoutMs() });
      if (setup.code !== 0) return inconclusive(`setup failed in the base worktree:\n${tail(setup.output, 20)}`);
    }
    const base = await sh(cmd, { cwd: baseDir, env, timeoutMs: timeoutMs() });
    const head = await sh(cmd, { cwd: worktree, env, timeoutMs: timeoutMs() });
    const redOnBase = base.code !== 0;
    const greenOnHead = head.code === 0;
    const detail = [
      redOnBase ? "repro fails on base" : `repro passes on base (does not reproduce the bug):\n${tail(base.output, 20)}`,
      greenOnHead ? "repro passes on HEAD" : `repro fails on HEAD:\n${tail(head.output, 20)}`,
    ].join("\n");
    return { ok: redOnBase && greenOnHead, redOnBase, greenOnHead, inconclusive: false, detail };
  } finally {
    await git(worktree, ["worktree", "remove", "--force", baseDir]).catch(() => "");
    rmSync(tmp, { recursive: true, force: true });
  }
}
