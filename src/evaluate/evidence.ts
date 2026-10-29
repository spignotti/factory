import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Evidence branch: screenshots, diffs, GIFs and videos of a run are committed
 * under `<run-id>/` on the orphan branch `factory-evidence` with git plumbing (a private index; the
 * user's worktrees and index are never touched) and pushed with a plain push; PR links pin the
 * commit. `gc` drops run folders older than the retention with a normal commit (no force-push, so
 * history keeps the blobs).
 */
export const EVIDENCE_BRANCH = "factory-evidence";
export const EVIDENCE_RETENTION_DAYS = 30;
/** Larger files (long videos) are not committed. */
export const MAX_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;

interface Author {
  name: string;
  email: string;
}

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(err.stderr ?? err.message).trim().split("\n")[0]}`, { cause: e });
  }
}

/** `owner/repo` of a GitHub remote URL (https, ssh, scp-like), else null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Pinned link to an evidence file (`?raw=true` serves images inline, also for private repos). */
export function evidenceUrl(slug: string, sha: string, path: string): string {
  return `https://github.com/${slug}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;
}

/** Remote tip of the evidence branch, fetched into `refs/factory/evidence`; null when it does not exist yet. */
async function fetchTip(repoDir: string): Promise<string | null> {
  const remote = await run(repoDir, ["ls-remote", "--heads", "origin", `refs/heads/${EVIDENCE_BRANCH}`]);
  if (!remote) return null;
  await run(repoDir, ["fetch", "-q", "--no-tags", "origin", `+refs/heads/${EVIDENCE_BRANCH}:refs/factory/evidence`]);
  return run(repoDir, ["rev-parse", "refs/factory/evidence"]);
}

/**
 * One commit on top of the remote tip, built in a private index: `edit` adds or removes paths.
 * Pushed plainly; a concurrent push (non-fast-forward) is retried once on the new tip.
 */
async function commitAndPush(
  repoDir: string,
  message: string,
  author: Author,
  edit: (index: (args: string[]) => Promise<string>, parent: string | null) => Promise<boolean>,
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const parent = await fetchTip(repoDir);
    const dir = mkdtempSync(join(tmpdir(), "factory-evidence-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      const index = (args: string[]) => run(repoDir, args, env);
      await index(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
      if (!(await edit(index, parent))) return null;
      const tree = await index(["write-tree"]);
      const who = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
      const sha = await run(repoDir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], who);
      try {
        await run(repoDir, ["push", "-q", "origin", `${sha}:refs/heads/${EVIDENCE_BRANCH}`]);
        return sha;
      } catch (e) {
        if (attempt > 0 || !/rejected|non-fast-forward|fetch first/i.test((e as Error).message)) throw e;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export interface PublishedEvidence {
  sha: string;
  /** `owner/repo`, null when origin is not on GitHub (links then name the commit and path). */
  slug: string | null;
  /** File name → path on the evidence branch. */
  paths: Map<string, string>;
  skipped: string[];
}

/** Commits `files` (names in `dir`) under `<runId>/` and pushes the evidence branch. */
export async function publishEvidence(repoDir: string, opts: { runId: string; dir: string; files: string[]; author: Author }): Promise<PublishedEvidence> {
  const paths = new Map<string, string>();
  const skipped: string[] = [];
  const sha = await commitAndPush(repoDir, `evidence: ${opts.runId}`, opts.author, async (index) => {
    await index(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", opts.runId]);
    for (const f of opts.files) {
      const file = join(opts.dir, f);
      if (statSync(file).size > MAX_EVIDENCE_FILE_BYTES) {
        skipped.push(`${f} (larger than ${MAX_EVIDENCE_FILE_BYTES / 1024 / 1024} MB)`);
        continue;
      }
      const blob = await run(repoDir, ["hash-object", "-w", "--", file]);
      const path = `${opts.runId}/${f}`;
      await index(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
      paths.set(f, path);
    }
    return paths.size > 0;
  });
  if (!sha) throw new Error("no evidence file to publish");
  // The configured URL (not `get-url`, which applies `insteadOf` rewrites).
  const url = await run(repoDir, ["config", "--get", "remote.origin.url"]).catch(() => "");
  return { sha, slug: githubSlug(url), paths, skipped };
}

/**
 * Retention: run folders on the evidence branch whose last commit is older than `days` are removed
 * in one commit. Returns the removed folders (dry run: the ones that would be removed).
 */
export async function pruneEvidence(repoDir: string, opts: { now: number; days?: number; dryRun?: boolean; author: Author }): Promise<string[]> {
  const cutoff = opts.now / 1000 - (opts.days ?? EVIDENCE_RETENTION_DAYS) * 86_400;
  const expired = async (parent: string): Promise<string[]> => {
    const dirs = (await run(repoDir, ["ls-tree", "-d", "--name-only", parent])).split("\n").filter(Boolean);
    const out: string[] = [];
    for (const d of dirs) {
      const at = Number(await run(repoDir, ["log", "-1", "--format=%ct", parent, "--", d]));
      if (at < cutoff) out.push(d);
    }
    return out;
  };
  if (opts.dryRun) {
    const tip = await fetchTip(repoDir);
    return tip ? expired(tip) : [];
  }
  let removed: string[] = [];
  await commitAndPush(repoDir, "evidence: retention", opts.author, async (index, parent) => {
    removed = parent ? await expired(parent) : [];
    for (const d of removed) await index(["rm", "-r", "-q", "--cached", "--", d]);
    return removed.length > 0;
  });
  return removed;
}
