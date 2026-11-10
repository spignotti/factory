import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CommandTimeoutError, execFileTimed, isCommandTimeout } from "./exec.js";
import { tryPathLock } from "./pipeline/lock.js";
import { LOCK_GLOBS } from "./paths.js";
import { matchesAny } from "./schemas/plan.js";

/** Local git (status, diff, commit). A hang is killed rather than blocking the run. */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;
/** Network git (fetch, push, pull, clone, ls-remote). */
export const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;
const GIT_NETWORK = new Set(["fetch", "push", "pull", "clone", "ls-remote"]);

/** First non-option argument, skipping `-c` / `-C` values. */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return args[i + 1];
    if (a === "-c" || a === "-C") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

export function gitTimeoutMs(args: string[]): number {
  const sub = gitSubcommand(args);
  return sub !== undefined && GIT_NETWORK.has(sub) ? GIT_NETWORK_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS;
}

export interface GitCallOptions {
  /** Overrides the default local/network timeout (the queue worker passes a shorter one). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Git for the factory process itself (its own env). Agents never get this. */
export async function git(cwd: string, args: string[], opts?: GitCallOptions): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? gitTimeoutMs(args);
  try {
    const { stdout } = await execFileTimed("git", args, { cwd, timeoutMs, maxBuffer: 64 * 1024 * 1024, env: opts?.env });
    return stdout;
  } catch (e) {
    if (e instanceof CommandTimeoutError) throw new Error(e.message, { cause: e });
    const err = e as { stderr?: string; message?: string };
    // A missing cwd makes Node set stderr to "" and put `spawn git ENOENT` on `message`.
    // `??` would keep the empty stderr and hide that (eval recorded `git ls-files failed: `).
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const detail = stderr || (err.message ?? String(e)).trim();
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause: e });
  }
}

/**
 * False when git exits non-zero. A timeout is not a failed command: it is rethrown so a caller
 * that needed fresh remote state cannot continue on a stale ref.
 */
export async function gitOk(cwd: string, args: string[], opts?: GitCallOptions): Promise<boolean> {
  try {
    await git(cwd, args, opts);
    return true;
  } catch (e) {
    if (isCommandTimeout(e)) throw e;
    return false;
  }
}

export async function revParse(cwd: string, ref: string, opts?: GitCallOptions): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], opts)).trim();
}

/**
 * Remote base ref when an `origin` remote exists, else the local branch.
 * A fetch that times out throws: a cached `origin/<branch>` is not a substitute for a fresh one.
 */
export async function baseRef(repoDir: string, branch: string, opts?: GitCallOptions): Promise<string> {
  if (await gitOk(repoDir, ["remote", "get-url", "origin"], opts)) {
    try {
      await gitOk(repoDir, ["fetch", "--quiet", "origin", branch], opts);
    } catch (e) {
      throw new Error(`${(e as Error).message}; refusing to continue on a stale base`, { cause: e });
    }
    if (await gitOk(repoDir, ["rev-parse", "--verify", `origin/${branch}`], opts)) return `origin/${branch}`;
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
    await execFileTimed("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], {
      cwd: repoDir,
      timeoutMs: gitTimeoutMs(["ls-remote"]),
    });
    return true;
  } catch (e) {
    // A timeout or any failure other than "no such ref" (exit 2): the remote cannot be asked.
    if (isCommandTimeout(e)) return true;
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
export type DiffExclusion = "lockfile" | "binary" | "diff_exclude" | "test";

export interface DiffEntry {
  /** Added + removed lines (0 for binary files). */
  lines: number;
  /** Set when the file is left out of the counted lines. */
  excluded?: DiffExclusion;
}

export interface DiffStatOptions {
  /** `limits.diff_exclude`: generated paths left out of the count. */
  exclude?: string[];
  /** `tests.globs`: how the factory classifies a test file (same globs as the test gates). */
  testGlobs?: string[];
  /**
   * When false, a file matching `testGlobs` is excluded as `test` and does not count toward
   * `limits.max_diff_lines`. Default true: test files count, and `exclude` still cannot drop them.
   */
  countTests?: boolean;
}

/** First 8 KB contain a NUL byte: binary, as git decides it. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function diffExclusion(file: string, binary: boolean, opts: DiffStatOptions = {}): DiffExclusion | undefined {
  if (binary) return "binary";
  if (matchesAny(file, LOCK_GLOBS)) return "lockfile";
  const test = matchesAny(file, opts.testGlobs ?? []);
  // The max_diff_lines opt-out. `diff_exclude` still cannot hide a test file on its own.
  if (opts.countTests === false && test) return "test";
  if (matchesAny(file, opts.exclude ?? []) && !test) return "diff_exclude";
  return undefined;
}

export interface NumstatEntry {
  path: string;
  /** Source path when git paired this file as a rename. */
  from?: string;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * Parses `git diff --numstat -z`: `A\tD\tpath\0`, or for a rename `A\tD\t\0old\0new\0`
 * (no `{old => new}` path to split, no quoting of unusual file names).
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const parts = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const [, a, d, inline] = m as unknown as [string, string, string, string];
    // numstat prints `-\t-` for binary files.
    const base = { added: Number(a) || 0, removed: Number(d) || 0, binary: a === "-" && d === "-" };
    if (inline) entries.push({ path: inline, ...base });
    else {
      const from = parts[++i];
      const path = parts[++i];
      if (from && path) entries.push({ path, from, ...base });
    }
  }
  return entries;
}

/**
 * Added + removed lines since the merge base, per file, with the files the line limits leave out.
 *
 * Renames are detected (`-M`, git's default 50% similarity): a moved file counts its changed lines
 * under the new path, not its whole content twice (tourenpilot-ops #82: 5 scripts moved, 4262 lines
 * without rename detection, 66 with). A rename across an exclusion boundary (e.g. a generated file
 * moved into the source tree, or source moved into a `diff_exclude` or test path) is counted as delete +
 * add, like before, so moving code in or out of an excluded path cannot hide lines.
 */
export async function diffStat(cwd: string, base: string, opts: DiffStatOptions = {}): Promise<Map<string, DiffEntry>> {
  const mb = await mergeBase(cwd, base);
  const stat = new Map<string, DiffEntry>();
  const put = (file: string, lines: number, binary: boolean) => {
    const excluded = diffExclusion(file, binary, opts);
    stat.set(file, excluded ? { lines, excluded } : { lines });
  };
  const putEntry = (e: NumstatEntry) => put(e.path, e.added + e.removed, e.binary);
  const renamed = parseNumstatZ(await git(cwd, ["diff", "-M", "--numstat", "-z", mb]));
  let plain: Map<string, NumstatEntry> | undefined;
  for (const e of renamed) {
    if (!e.from) {
      putEntry(e);
      continue;
    }
    if (diffExclusion(e.from, e.binary, opts) === diffExclusion(e.path, e.binary, opts)) {
      putEntry(e);
      continue;
    }
    plain ??= new Map(parseNumstatZ(await git(cwd, ["diff", "--no-renames", "--numstat", "-z", mb])).map((x) => [x.path, x]));
    for (const p of [e.from, e.path]) {
      const x = plain.get(p);
      if (x) putEntry(x);
    }
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
  /**
   * Lines that count toward the limit this stat was built for.
   * With `countTests: false`, test files are not in here (see `excludedTestLines`).
   */
  counted: number;
  excluded: number;
  /** Excluded text files with lines (lockfiles, diff_exclude). Test files are listed separately. */
  excludedFiles: string[];
  binaryFiles: number;
  /** Lines in files excluded as tests (`limits.diff_count_tests: false`). */
  excludedTestLines: number;
  excludedTestFiles: string[];
}

export function diffTotals(stat: Map<string, DiffEntry>): DiffTotals {
  const t: DiffTotals = { counted: 0, excluded: 0, excludedFiles: [], binaryFiles: 0, excludedTestLines: 0, excludedTestFiles: [] };
  for (const [file, e] of [...stat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!e.excluded) t.counted += e.lines;
    else if (e.excluded === "binary") t.binaryFiles++;
    else if (e.excluded === "test") {
      t.excludedTestLines += e.lines;
      if (e.lines > 0) t.excludedTestFiles.push(file);
    } else {
      t.excluded += e.lines;
      if (e.lines > 0) t.excludedFiles.push(file);
    }
  }
  return t;
}

/**
 * Lines for `fast_lane.max_diff_lines` and `merge.low_max_diff_lines`.
 * Test files count here even when the max_diff_lines gate left them out.
 */
export function linesCountingTests(t: DiffTotals): number {
  return t.counted + t.excludedTestLines;
}

/** Both numbers for the run log and result.json. Absent when test files still count. */
export function diffCountFields(t: DiffTotals, countTests: boolean): { counted_lines: number; excluded_test_lines: number } | undefined {
  if (countTests) return undefined;
  return { counted_lines: t.counted, excluded_test_lines: t.excludedTestLines };
}

/** `943 lines (+533 excluded: package-lock.json; 4 binary files)`. */
export function formatDiffTotals(t: DiffTotals, opts?: { countTests?: boolean }): string {
  const extra = [
    ...(opts?.countTests === false ? [`+${t.excludedTestLines} test lines not counted`] : []),
    ...(t.excluded > 0 ? [`+${t.excluded} excluded: ${t.excludedFiles.join(", ")}`] : []),
    ...(t.binaryFiles > 0 ? [`${t.binaryFiles} binary file${t.binaryFiles === 1 ? "" : "s"}`] : []),
  ];
  return `${t.counted} lines${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

/**
 * Diff stat with the repo's exclusions (`limits.diff_exclude`).
 * `opts.countTests` defaults to true. Pass `repo.limits.diff_count_tests` for the max_diff_lines
 * gate; fast-lane and merge risk pass it too and add `excludedTestLines` back (`linesCountingTests`).
 */
export async function repoDiffStat(
  cwd: string,
  base: string,
  repo: { limits: { diff_exclude: string[] }; tests: { globs: string[] } },
  opts?: { countTests?: boolean },
): Promise<Map<string, DiffEntry>> {
  return diffStat(cwd, base, { exclude: repo.limits.diff_exclude, testGlobs: repo.tests.globs, countTests: opts?.countTests ?? true });
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

export async function originUrl(repoDir: string, opts?: GitCallOptions): Promise<string> {
  // No origin is "", but a timeout is rethrown: falling back to the path would pick another lock and queue key.
  return (
    await git(repoDir, ["remote", "get-url", "origin"], opts).catch((e: unknown) => {
      if (isCommandTimeout(e)) throw e;
      return "";
    })
  ).trim();
}

/** Repo lock id: the origin URL, else the path (one factory process per repository). */
export async function repoLockId(repoDir: string, opts?: GitCallOptions): Promise<string> {
  return (await originUrl(repoDir, opts)) || repoDir;
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
 * How long manual and scheduled `factory gc` waits for an in-flight worktree add or remove.
 * The automatic gc at the start of `factory run` waits less so one busy lock cannot consume its budget.
 */
export const GIT_OPS_WAIT_MS = 60_000;
export const AUTO_GC_GIT_OPS_WAIT_MS = 5_000;

/** Absolute git common dir, or undefined when `repoDir` is not a checkout. */
async function commonGitDir(repoDir: string): Promise<string | undefined> {
  try {
    const out = (await git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return out ? resolve(repoDir, out) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serializes factory mutations of one checkout's worktree registry (`worktree add/remove/prune`,
 * local `branch -D`). The lock file is `factory.gitops.lock` in the git common dir, not a run slot:
 * another run may hold a slot while this is taken, and it is released when `fn` returns.
 * `busy` means a live holder kept it for the whole wait.
 */
export async function tryRepoGitOps<T>(
  repoDir: string,
  fn: () => Promise<T> | T,
  opts?: { waitMs?: number; pollMs?: number },
): Promise<{ ok: true; value: T } | { ok: false; reason: "busy" | "not-a-repo" }> {
  const common = await commonGitDir(repoDir);
  if (!common) return { ok: false, reason: "not-a-repo" };
  const locked = await tryPathLock(join(common, "factory.gitops.lock"), "gitops", fn, { waitMs: opts?.waitMs ?? GIT_OPS_WAIT_MS, pollMs: opts?.pollMs });
  if (!locked.ok) return { ok: false, reason: "busy" };
  return { ok: true, value: locked.value };
}

/** `tryRepoGitOps`, throwing when the lock is not acquired. */
export async function withRepoGitOps<T>(repoDir: string, fn: () => Promise<T> | T, opts?: { waitMs?: number; pollMs?: number }): Promise<T> {
  const r = await tryRepoGitOps(repoDir, fn, opts);
  if (!r.ok) throw new Error(r.reason === "busy" ? `git worktree operations on ${repoDir} are busy` : `not a git repository: ${repoDir}`);
  return r.value;
}

/**
 * Runs `fn` in a temporary detached worktree of `repoDir` at `sha` (clean: tracked files only, no
 * untracked or ignored files of the user's checkout), removed afterwards.
 * Add and remove take the git-ops lock so they do not interleave with `factory gc`.
 */
export async function withBaseWorktree<T>(repoDir: string, sha: string, dir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  // `git worktree add` resolves a relative path against the repo, not the caller's cwd.
  // `--work-dir work` otherwise created `repo/work/.../plan-base` and `git ls-files` on the
  // intended path failed with an empty stderr (`spawn git ENOENT`).
  const abs = resolve(dir);
  await withRepoGitOps(repoDir, () => git(repoDir, ["worktree", "add", "-q", "--detach", abs, sha]));
  try {
    return await fn(abs);
  } finally {
    try {
      await withRepoGitOps(repoDir, async () => {
        await git(repoDir, ["worktree", "remove", "--force", abs]).catch(() => "");
        rmSync(abs, { recursive: true, force: true });
        await gitOk(repoDir, ["worktree", "prune"]);
      });
    } catch {
      // The lock was busy. Drop the directory; a later prune clears a stale registration.
      rmSync(abs, { recursive: true, force: true });
    }
  }
}
