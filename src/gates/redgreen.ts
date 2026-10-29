import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sh, tail } from "../exec.js";
import { git } from "../git.js";

export interface RedGreenResult {
  ok: boolean;
  redOnBase: boolean;
  greenOnHead: boolean;
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
  env: Record<string, string>;
}): Promise<RedGreenResult> {
  const { worktree, baseSha, files, testCommand, env } = opts;
  if (!testCommand) return { ok: false, redOnBase: false, greenOnHead: false, detail: "repo.yaml tests.run is not set" };
  if (files.length === 0) return { ok: false, redOnBase: false, greenOnHead: false, detail: "no repro test named in evidence" };
  const cmd = testCommand.replace("{files}", files.map(shellQuote).join(" "));
  const baseDir = join(mkdtempSync(join(tmpdir(), "factory-base-")), "wt");
  await git(worktree, ["worktree", "add", "-q", "--detach", baseDir, baseSha]);
  try {
    for (const f of files) {
      if (!existsSync(join(worktree, f))) return { ok: false, redOnBase: false, greenOnHead: false, detail: `repro file missing: ${f}` };
      mkdirSync(dirname(join(baseDir, f)), { recursive: true });
      copyFileSync(join(worktree, f), join(baseDir, f));
    }
    const base = await sh(cmd, { cwd: baseDir, env });
    const head = await sh(cmd, { cwd: worktree, env });
    const redOnBase = base.code !== 0;
    const greenOnHead = head.code === 0;
    const detail = [
      redOnBase ? "repro fails on base" : `repro passes on base (does not reproduce the bug):\n${tail(base.output, 20)}`,
      greenOnHead ? "repro passes on HEAD" : `repro fails on HEAD:\n${tail(head.output, 20)}`,
    ].join("\n");
    return { ok: redOnBase && greenOnHead, redOnBase, greenOnHead, detail };
  } finally {
    await git(worktree, ["worktree", "remove", "--force", baseDir]).catch(() => "");
  }
}
