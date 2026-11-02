import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { GcOptions, GcReport } from "../commands/gc.js";
import { git, repoLockId } from "../git.js";
import { acquireRepoLock, activeHolders } from "../pipeline/lock.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { listRuns } from "../runs.js";
import { isProtectedFactoryPath, type GcRetention } from "./retention-config.js";
import type { RunRecord } from "../runs.js";
import {
  DAY,
  dirBytes,
  homeEligible,
  lastActivity,
  metadataArchiveBlocked,
  metadataRetentionMs,
  protectedIdleRun,
  protectedMetadataRunIds,
} from "./retention-helpers.js";

function lockMaxRuns(repo: string): number {
  try {
    return loadRepoConfig(repo).concurrency.max_runs;
  } catch {
    return 1;
  }
}

function baseRedHours(repo: string): number {
  try {
    if (existsSync(repo)) return loadRepoConfig(repo).limits.base_red_resume_hours;
  } catch {
    // default
  }
  return 48;
}

/**
 * True when `path` is a real directory (not a symlink) whose resolved location is strictly inside the resolved
 * `root`. Fails closed on any error, so gc never follows a link out of `$FACTORY_HOME`.
 */
export function realDirInside(root: string, path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    const r = realpathSync(root);
    const rel = relative(r, realpathSync(path));
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && rel === relative(root, path);
  } catch {
    return false;
  }
}

/** Takes every lock slot of the run's repository for `fn`; returns false (nothing done) when a slot is held. */
async function withRunRepoLock(opts: GcOptions, run: RunRecord, tag: string, fn: () => void): Promise<boolean> {
  const repo = run.state!.repo;
  let id = repo;
  try {
    if (existsSync(repo)) id = await repoLockId(repo);
  } catch {
    // fall back to the path
  }
  const release = acquireRepoLock(opts.factoryHome, id, `${tag}-${run.run_id}`, { maxRuns: existsSync(repo) ? lockMaxRuns(repo) : 1, exclusive: true });
  if (!release) return false;
  try {
    fn();
  } finally {
    release();
  }
  return true;
}

/** Removes eligible `runs/<id>/home` directories. */
export async function gcRunHomes(opts: GcOptions, report: GcReport, cfg: GcRetention, nowMs: () => number): Promise<void> {
  const live = new Set(activeHolders(opts.factoryHome).map((h) => h.runId).filter((id): id is string => !!id));
  const runsRoot = join(opts.factoryHome, "runs");
  const now = nowMs();
  for (const run of listRuns(opts.factoryHome)) {
    const st = run.state;
    if (!st || live.has(run.run_id)) continue;
    if (protectedIdleRun(run, now, cfg.worktree_resume_days)) continue;
    if (!homeEligible(run, now, cfg.home_hours)) continue;
    const home = join(run.dir, "home");
    if (!existsSync(home)) continue;
    if (isProtectedFactoryPath(opts.factoryHome, home)) continue;
    if (!realDirInside(runsRoot, home)) {
      report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason: "home/ is a symlink or outside $FACTORY_HOME/runs; kept" });
      continue;
    }
    const bytes = dirBytes(home);
    const entry = { run_id: run.run_id, repo: st.repo, bytes, reason: `terminal run idle ≥ ${cfg.home_hours}h; sandbox home is cache` };
    if (opts.dryRun) {
      report.home_removed.push(entry);
      continue;
    }
    const done = await withRunRepoLock(opts, run, "gc-home", () => rmSync(home, { recursive: true, force: true }));
    if (!done) {
      report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason: "repository is locked by a running factory process; home/ kept" });
      continue;
    }
    report.home_removed.push(entry);
  }
}

/**
 * Moves old run metadata into `$FACTORY_HOME/archive/runs/<id>.tar.gz` (without `home/` and `worktree/`).
 * The tarball is written to a temp name, listed back with `tar -tzf`, then renamed; the run directory is removed
 * only after that. A run whose recorded worktree still exists is skipped (the worktree stage owns it).
 */
export async function gcMetadataArchive(opts: GcOptions, report: GcReport, cfg: GcRetention, nowMs: () => number): Promise<void> {
  const runs = listRuns(opts.factoryHome);
  const protectedIds = protectedMetadataRunIds(runs, cfg.metadata_min_per_repo);
  const live = new Set(activeHolders(opts.factoryHome).map((h) => h.runId).filter((id): id is string => !!id));
  const runsRoot = join(opts.factoryHome, "runs");
  const archiveRoot = join(opts.factoryHome, "archive", "runs");
  const now = nowMs();
  for (const run of runs) {
    const st = run.state;
    if (!st || live.has(run.run_id) || protectedIds.has(run.run_id)) continue;
    if (protectedIdleRun(run, now, cfg.worktree_resume_days)) continue;
    if (metadataArchiveBlocked(run, now, baseRedHours(st.repo))) continue;
    if (now - lastActivity(run) < metadataRetentionMs(run, cfg)) continue;
    const skip = (reason: string) => void report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason });
    if (st.worktree && existsSync(st.worktree)) {
      skip("worktree still exists; metadata kept until the worktree is collected");
      continue;
    }
    if (!realDirInside(runsRoot, run.dir) || dirname(run.dir) !== runsRoot) {
      skip("run directory is a symlink or outside $FACTORY_HOME/runs; kept");
      continue;
    }
    const tarball = join(archiveRoot, `${run.run_id}.tar.gz`);
    if (isProtectedFactoryPath(opts.factoryHome, tarball)) continue;
    const bytes = dirBytes(run.dir);
    const entry = { run_id: run.run_id, repo: st.repo, tarball, bytes, reason: "metadata past retention; tarball to archive/runs" };
    if (opts.dryRun) {
      report.metadata_moved.push(entry);
      continue;
    }
    const out = { failure: "" };
    const done = await withRunRepoLock(opts, run, "gc-meta", () => {
      const tmp = `${tarball}.tmp-${process.pid}`;
      try {
        mkdirSync(archiveRoot, { recursive: true });
        const name = basename(run.dir);
        execFileSync("tar", ["-czf", tmp, "--exclude", `${name}/home`, "--exclude", `${name}/worktree`, "-C", runsRoot, name], { stdio: "ignore" });
        const listing = execFileSync("tar", ["-tzf", tmp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        if (!listing.split("\n").includes(`${name}/state.json`)) throw new Error("tarball does not contain state.json");
        renameSync(tmp, tarball);
      } catch (e) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // nothing was written
        }
        out.failure = (e as Error).message.slice(0, 200) || "tar failed";
        return;
      }
      rmSync(run.dir, { recursive: true, force: true });
    });
    if (!done) {
      skip("repository is locked by a running factory process; metadata kept");
      continue;
    }
    if (out.failure) {
      skip(`tarball failed; run directory kept (${out.failure})`);
      continue;
    }
    report.metadata_moved.push(entry);
  }
}

/** Purges old tarballs and heavy dirs under `$FACTORY_HOME/archive/runs`. */
export function gcArchiveRuns(opts: GcOptions, report: GcReport, cfg: GcRetention, nowMs: () => number): void {
  const root = join(opts.factoryHome, "archive", "runs");
  if (!existsSync(root)) return;
  const cutoff = nowMs() - cfg.archive_tarball_days * DAY;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (isProtectedFactoryPath(opts.factoryHome, path)) continue;
    const st = lstatSync(path);
    const mtime = st.mtimeMs;
    if (st.isDirectory()) {
      for (const heavy of ["home", "worktree"] as const) {
        const sub = join(path, heavy);
        if (!existsSync(sub)) continue;
        const bytes = dirBytes(sub);
        const reason = `strip ${heavy}/ from archived run dir`;
        if (opts.dryRun) {
          report.archive_purged.push({ path: sub, bytes, reason });
          continue;
        }
        rmSync(sub, { recursive: true, force: true });
        report.archive_purged.push({ path: sub, bytes, reason });
      }
      if (mtime >= cutoff) continue;
      const bytes = dirBytes(path);
      const reason = `archived run dir older than ${cfg.archive_tarball_days} days`;
      if (opts.dryRun) {
        report.archive_purged.push({ path, bytes, reason });
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      report.archive_purged.push({ path, bytes, reason });
      continue;
    }
    if (!name.endsWith(".tar.gz")) continue;
    if (mtime >= cutoff) continue;
    const bytes = st.size;
    const reason = `metadata tarball older than ${cfg.archive_tarball_days} days`;
    if (opts.dryRun) {
      report.archive_purged.push({ path, bytes, reason });
      continue;
    }
    rmSync(path, { force: true });
    report.archive_purged.push({ path, bytes, reason });
  }
}

/** Runs `git worktree prune` on repositories that had worktree cleanup. */
export async function pruneFactoryWorktrees(repos: Iterable<string>, opts: GcOptions, report: GcReport): Promise<void> {
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    const release = acquireRepoLock(opts.factoryHome, await repoLockId(repo), "gc-prune", { maxRuns: lockMaxRuns(repo), exclusive: true });
    if (!release) continue;
    try {
      if (!opts.dryRun) await git(repo, ["worktree", "prune"]).catch(() => "");
      report.worktree_pruned.push({ repo });
    } finally {
      release();
    }
  }
}
