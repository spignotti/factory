import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResultKind } from "../events.js";
import { git, gitOk } from "../git.js";
import type { RunRecord } from "../runs.js";
import type { GcRetention } from "./retention-config.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Last write of the run's state (falls back to the start time from the run id). */
export function lastActivity(run: RunRecord): number {
  const t = run.state?.updated_at ? Date.parse(run.state.updated_at) : NaN;
  return Number.isFinite(t) ? t : run.started_at.getTime();
}

const RESUME_RESULTS = new Set<RunResultKind>(["needs_input", "needs_human", "base_red"]);

/** Runs that must not be touched while idle for fewer than `worktree_resume_days`. */
export function protectedIdleRun(run: RunRecord, nowMs: number, resumeDays: number): boolean {
  const st = run.state;
  if (!st) return true;
  if (st.result === null) return true;
  if (!RESUME_RESULTS.has(st.result)) return false;
  return nowMs - lastActivity(run) < resumeDays * DAY;
}

/** Terminal runs whose sandbox `home/` may be removed after `home_hours`. */
export function homeEligible(run: RunRecord, nowMs: number, homeHours: number): boolean {
  const st = run.state;
  if (!st || st.result === null) return false;
  if (RESUME_RESULTS.has(st.result)) return false;
  if (st.result === "locked") return false;
  const idle = nowMs - lastActivity(run);
  if (idle < homeHours * HOUR) return false;
  return true;
}

export function worktreeRetentionMs(run: RunRecord, cfg: GcRetention, retentionDaysOverride?: number): number {
  if (retentionDaysOverride !== undefined) return retentionDaysOverride * DAY;
  const r = run.state?.result;
  if (r === "failed") return cfg.worktree_failed_days * DAY;
  if (r === "needs_input" || r === "needs_human" || r === "base_red") return cfg.worktree_resume_days * DAY;
  return cfg.worktree_failed_days * DAY;
}

/** Sum byte size of a file or directory tree. */
export function dirBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let n = 0;
  for (const name of readdirSync(path)) n += dirBytes(join(path, name));
  return n;
}

/** True when the branch has commits that no remote branch contains. */
export async function branchHasUnpushedCommits(repo: string, branch: string): Promise<{ unpushed: boolean; reason?: string }> {
  if (!existsSync(repo)) return { unpushed: false };
  if (!(await gitOk(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]))) return { unpushed: false };
  const notOnRemote = (await git(repo, ["rev-list", "--count", branch, "--not", "--remotes"]).catch(() => "0")).trim();
  const n = Number(notOnRemote);
  if (Number.isFinite(n) && n > 0) {
    return { unpushed: true, reason: `branch ${branch} has ${n} commit(s) not on any remote` };
  }
  if (!(await gitOk(repo, ["rev-parse", "-q", "--verify", `${branch}@{upstream}`]))) return { unpushed: false };
  const upstream = (await git(repo, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]).catch(() => "")).trim();
  if (upstream && upstream !== branch) {
    const ahead = (await git(repo, ["rev-list", "--count", `${branch}@{upstream}..${branch}`]).catch(() => "0")).trim();
    const a = Number(ahead);
    if (Number.isFinite(a) && a > 0) return { unpushed: true, reason: `branch ${branch} is ${a} commit(s) ahead of ${upstream}` };
  }
  return { unpushed: false };
}

/**
 * needs_input is still open work. So is a live process, an interrupted run, a resumable failure,
 * and a GitHub-CI base_red still inside its resume window.
 */
export function metadataArchiveBlocked(run: RunRecord, nowMs: number, baseRedHours: number): boolean {
  const st = run.state;
  if (!st || st.result === null) return true;
  if (st.pr && !st.gc_at) return true;
  if (st.result === "needs_human" || st.result === "needs_input") return true;
  if (st.result === "failed" && !st.gc_at) return true;
  if (st.result === "base_red" && !st.base_ci && !st.gc_at) return true;
  if (st.result === "base_red" && st.base_ci && !st.gc_at) {
    if (nowMs - lastActivity(run) < baseRedHours * HOUR) return true;
  }
  return false;
}

export function metadataRetentionMs(run: RunRecord, cfg: GcRetention): number {
  const days = run.state?.result === "failed" ? cfg.metadata_failed_days : cfg.metadata_days;
  return days * DAY;
}

/** Run ids protected as the newest `minPerRepo` runs per repository. */
export function protectedMetadataRunIds(runs: RunRecord[], minPerRepo: number): Set<string> {
  const byRepo = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const repo = run.state?.repo;
    if (!repo) continue;
    const list = byRepo.get(repo) ?? [];
    list.push(run);
    byRepo.set(repo, list);
  }
  const protectedIds = new Set<string>();
  for (const list of byRepo.values()) {
    list.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
    for (const run of list.slice(0, minPerRepo)) protectedIds.add(run.run_id);
  }
  return protectedIds;
}
