import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LOCK_GLOBS } from "./paths.js";
import { matchesAny } from "./schemas/plan.js";

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

export async function mergeBase(cwd: string, base: string): Promise<string> {
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

/** Why a changed file does not count toward the diff line limits. */
export type DiffExclusion = "lockfile" | "binary" | "diff_exclude";

export interface DiffEntry {
  /** Added + removed lines (0 for binary files). */
  lines: number;
  /** Set when the file is left out of the counted lines. */
  excluded?: DiffExclusion;
}

export interface DiffStatOptions {
  /** `limits.diff_exclude`: generated paths left out of the count. */
  exclude?: string[];
  /** `tests.globs`: a test file is always counted, whatever `exclude` says. */
  testGlobs?: string[];
}

/** First 8 KB contain a NUL byte: binary, as git decides it. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function diffExclusion(file: string, binary: boolean, opts: DiffStatOptions = {}): DiffExclusion | undefined {
  if (binary) return "binary";
  if (matchesAny(file, LOCK_GLOBS)) return "lockfile";
  if (matchesAny(file, opts.exclude ?? []) && !matchesAny(file, opts.testGlobs ?? [])) return "diff_exclude";
  return undefined;
}

/** Added + removed lines since the merge base, per file, with the files the line limits leave out. */
export async function diffStat(cwd: string, base: string, opts: DiffStatOptions = {}): Promise<Map<string, DiffEntry>> {
  const mb = await mergeBase(cwd, base);
  const stat = new Map<string, DiffEntry>();
  const put = (file: string, lines: number, binary: boolean) => {
    const excluded = diffExclusion(file, binary, opts);
    stat.set(file, excluded ? { lines, excluded } : { lines });
  };
  for (const line of lines(await git(cwd, ["diff", "--no-renames", "--numstat", mb]))) {
    const [a, d, file] = line.split("\t");
    // numstat prints `-\t-` for binary files.
    if (file) put(file, (Number(a) || 0) + (Number(d) || 0), a === "-" && d === "-");
  }
  for (const file of await untracked(cwd)) {
    const buf = await readFile(join(cwd, file)).catch(() => Buffer.alloc(0));
    const binary = looksBinary(buf);
    const text = binary ? "" : buf.toString("utf8");
    // As git counts them: a trailing newline does not start another line.
    put(file, text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, binary);
  }
  return stat;
}

export interface DiffTotals {
  /** Lines that count toward max_diff_lines, fast_lane.max_diff_lines and merge.low_max_diff_lines. */
  counted: number;
  excluded: number;
  /** Excluded text files with lines (lockfiles, diff_exclude). */
  excludedFiles: string[];
  binaryFiles: number;
}

export function diffTotals(stat: Map<string, DiffEntry>): DiffTotals {
  const t: DiffTotals = { counted: 0, excluded: 0, excludedFiles: [], binaryFiles: 0 };
  for (const [file, e] of [...stat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!e.excluded) t.counted += e.lines;
    else if (e.excluded === "binary") t.binaryFiles++;
    else {
      t.excluded += e.lines;
      if (e.lines > 0) t.excludedFiles.push(file);
    }
  }
  return t;
}

/** `943 lines (+533 excluded: package-lock.json; 4 binary files)`. */
export function formatDiffTotals(t: DiffTotals): string {
  const extra = [
    ...(t.excluded > 0 ? [`+${t.excluded} excluded: ${t.excludedFiles.join(", ")}`] : []),
    ...(t.binaryFiles > 0 ? [`${t.binaryFiles} binary file${t.binaryFiles === 1 ? "" : "s"}`] : []),
  ];
  return `${t.counted} lines${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

/** Diff stat with the repo's exclusions (`limits.diff_exclude`, test files always counted). */
export async function repoDiffStat(cwd: string, base: string, repo: { limits: { diff_exclude: string[] }; tests: { globs: string[] } }): Promise<Map<string, DiffEntry>> {
  return diffStat(cwd, base, { exclude: repo.limits.diff_exclude, testGlobs: repo.tests.globs });
}

/** Unified diff since the merge base (stage first so new files are included). */
export async function diffText(cwd: string, base: string, exclude: string[] = []): Promise<string> {
  const mb = await mergeBase(cwd, base);
  return git(cwd, ["diff", "--no-renames", mb, "--", ".", ...exclude.map((p) => `:(exclude,glob)${p}`)]);
}

/** Unified diff of the given files since the merge base. */
export async function diffFiles(cwd: string, base: string, files: string[]): Promise<string> {
  if (!files.length) return "";
  const mb = await mergeBase(cwd, base);
  return git(cwd, ["diff", "--no-renames", mb, "--", ...files.map((f) => `:(literal)${f}`)]);
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

export type MergeOutcome = { ok: true } | { ok: false; conflicts: string[]; error: string };

/**
 * Merges `ref` into HEAD as `author` (fast-forward allowed, hooks skipped). On failure the merge is
 * aborted, so the worktree is left as before, and the conflicting files are reported.
 */
export async function mergeRef(cwd: string, ref: string, message: string, author: { name: string; email: string }): Promise<MergeOutcome> {
  try {
    await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "merge", "-q", "--no-edit", "--no-verify", "-m", message, ref]);
    return { ok: true };
  } catch (e) {
    const conflicts = lines(await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ""));
    await gitOk(cwd, ["merge", "--abort"]);
    return { ok: false, conflicts, error: (e as Error).message };
  }
}

export async function isAncestor(cwd: string, ancestor: string, of = "HEAD"): Promise<boolean> {
  return gitOk(cwd, ["merge-base", "--is-ancestor", ancestor, of]);
}

/** Discards all uncommitted changes in a factory-owned worktree. */
export async function discardChanges(cwd: string): Promise<void> {
  await git(cwd, ["reset", "-q", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fdq"]);
}

export async function headSha(cwd: string): Promise<string> {
  return revParse(cwd, "HEAD");
}

export async function originUrl(repoDir: string): Promise<string> {
  return (await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "")).trim();
}

/** Repo lock id: the origin URL, else the path (one factory process per repository). */
export async function repoLockId(repoDir: string): Promise<string> {
  return (await originUrl(repoDir)) || repoDir;
}

/**
 * Remotes whose URL embeds credentials (`https://user:token@…`, `https://token@…`). The main repo's git
 * dir is readable inside the sandbox, so such a token would reach the agents. Names only, never URLs.
 */
export async function remotesWithCredentials(repoDir: string): Promise<string[]> {
  const out = await git(repoDir, ["config", "--get-regexp", "^remote\\..*\\.(push)?url$"]).catch(() => "");
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^remote\.(.+)\.(?:push)?url (.*)$/.exec(line.trim());
    if (m && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(m[2]!) && !/^ssh:\/\/[^/:@\s]+@/i.test(m[2]!)) names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * Runs `fn` in a temporary detached worktree of `repoDir` at `sha` (clean: tracked files only, no
 * untracked or ignored files of the user's checkout), removed afterwards.
 */
export async function withBaseWorktree<T>(repoDir: string, sha: string, dir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await git(repoDir, ["worktree", "add", "-q", "--detach", dir, sha]);
  try {
    return await fn(dir);
  } finally {
    await git(repoDir, ["worktree", "remove", "--force", dir]).catch(() => "");
    rmSync(dir, { recursive: true, force: true });
    await gitOk(repoDir, ["worktree", "prune"]);
  }
}
