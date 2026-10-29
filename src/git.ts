import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Git for the factory process itself (its own env). Agents never get this. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr ?? err.message).trim()}`, { cause: e });
  }
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/** Remote base ref when an `origin` remote exists, else the local branch. */
export async function baseRef(repoDir: string, branch: string): Promise<string> {
  if (await gitOk(repoDir, ["remote", "get-url", "origin"])) {
    await gitOk(repoDir, ["fetch", "--quiet", "origin", branch]);
    if (await gitOk(repoDir, ["rev-parse", "--verify", `origin/${branch}`])) return `origin/${branch}`;
  }
  return branch;
}

/**
 * Whether `branch` exists on `origin`. No origin → false. If the remote cannot be asked (network,
 * auth), assume it exists so the caller picks a fresh name instead of colliding on push.
 */
export async function remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
  if (!(await gitOk(repoDir, ["remote", "get-url", "origin"]))) return false;
  try {
    await execFileP("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoDir, timeout: 60_000 });
    return true;
  } catch (e) {
    return (e as { code?: unknown }).code !== 2;
  }
}

async function mergeBase(cwd: string, base: string): Promise<string> {
  return (await git(cwd, ["merge-base", base, "HEAD"])).trim();
}

async function untracked(cwd: string): Promise<string[]> {
  return lines(await git(cwd, ["ls-files", "--others", "--exclude-standard"]));
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Files changed since the merge base with `base`: commits, working tree and untracked files. */
export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const mb = await mergeBase(cwd, base);
  const tracked = lines(await git(cwd, ["diff", "--no-renames", "--name-only", mb]));
  return [...new Set([...tracked, ...(await untracked(cwd))])].sort();
}

/** Added + removed lines since the merge base, per file. */
export async function diffStat(cwd: string, base: string): Promise<Map<string, number>> {
  const mb = await mergeBase(cwd, base);
  const stat = new Map<string, number>();
  for (const line of lines(await git(cwd, ["diff", "--no-renames", "--numstat", mb]))) {
    const [a, d, file] = line.split("\t");
    if (file) stat.set(file, (Number(a) || 0) + (Number(d) || 0));
  }
  for (const file of await untracked(cwd)) {
    const content = await readFile(join(cwd, file), "utf8").catch(() => "");
    stat.set(file, content ? content.split("\n").length : 0);
  }
  return stat;
}

/** Unified diff since the merge base (stage first so new files are included). */
export async function diffText(cwd: string, base: string, exclude: string[] = []): Promise<string> {
  const mb = await mergeBase(cwd, base);
  return git(cwd, ["diff", "--no-renames", mb, "--", ".", ...exclude.map((p) => `:(exclude,glob)${p}`)]);
}

export async function stageAll(cwd: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
}

/** Commits staged changes as the configured author. Returns false when nothing is staged. */
export async function commitAll(cwd: string, message: string, author: { name: string; email: string }): Promise<boolean> {
  await stageAll(cwd);
  if (await gitOk(cwd, ["diff", "--cached", "--quiet"])) return false;
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "--no-verify", "-m", message]);
  return true;
}

/** Discards all uncommitted changes in a factory-owned worktree. */
export async function discardChanges(cwd: string): Promise<void> {
  await git(cwd, ["reset", "-q", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fdq"]);
}

export async function headSha(cwd: string): Promise<string> {
  return revParse(cwd, "HEAD");
}
