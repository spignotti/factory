import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResultKind } from "../events.js";
import type { GitHub } from "../gh.js";
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

/** needs_input / needs_human / base_red: the run can still be resumed. */
export function isResumeResult(result: RunResultKind | null | undefined): boolean {
  return result != null && RESUME_RESULTS.has(result);
}

/** Runs that must not be touched while idle for fewer than `worktree_resume_days`. */
export function protectedIdleRun(run: RunRecord, nowMs: number, resumeDays: number): boolean {
  const st = run.state;
  if (!st) return true;
  if (st.result === null) return true;
  if (!isResumeResult(st.result)) return false;
  return nowMs - lastActivity(run) < resumeDays * DAY;
}

export type GcPrState =
  | { state: "none" | "open" | "merged" | "closed" }
  | { state: "unknown"; reason: string };

/**
 * PR state for gc, via `GitHub.prStatus` (the same call the worktree stage uses).
 * No PR is `none`. A thrown lookup stays `unknown` so the caller keeps the run.
 */
export async function resolveGcPrState(github: GitHub, repo: string, pr: string | null): Promise<GcPrState> {
  if (!pr) return { state: "none" };
  try {
    return { state: (await github.prStatus(repo, pr)).state };
  } catch (e) {
    return { state: "unknown", reason: `PR state unknown: ${(e as Error).message.slice(0, 200)}` };
  }
}

/**
 * Historical idle check for sandbox `home/` (kept for callers that still pass `home_hours`).
 * `gc` itself strips a terminal run immediately once the branch is pushed or there is no PR, and never
 * strips a resume-status run.
 */
export function homeEligible(run: RunRecord, nowMs: number, homeHours: number, opts?: { prTerminal?: boolean }): boolean {
  const st = run.state;
  if (!st || st.result === null) return false;
  if (st.result === "locked") return false;
  if (isResumeResult(st.result) && !opts?.prTerminal) return false;
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

