import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { GcOptions, GcReport } from "../commands/gc.js";
import { git, tryRepoGitOps } from "../git.js";
import { activeHolders } from "../pipeline/lock.js";
import { listRuns } from "../runs.js";
import { isProtectedFactoryPath } from "./retention-config.js";
import type { RunRecord } from "../runs.js";
import { branchHasUnpushedCommits, dirBytes, isResumeResult } from "./retention-helpers.js";

/** Regenerable dependency folders (`setup` recreates them), anywhere under the worktree. */
export const HEAVY_DIRS = ["node_modules", ".venv", ".nox"] as const;
const HEAVY = new Set<string>(HEAVY_DIRS);

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

function runIsLive(factoryHome: string, runId: string): boolean {
  return activeHolders(factoryHome).some((h) => h.runId === runId);
}

/** A progress event recorded a successful evidence publish (`data.evidence.sha`). */
export function evidencePublished(runDir: string): boolean {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"sha"')) continue;
    try {
      const ev = JSON.parse(line) as { data?: { evidence?: { sha?: string } } };
      if (ev.data?.evidence?.sha) return true;
    } catch {
      // a torn line is not a publish
    }
  }
  return false;
}

function heavyUnder(worktree: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (HEAVY.has(name)) {
        if (realDirInside(worktree, p)) out.push(relative(worktree, p));
        continue;
      }
      walk(p);
    }
  };
  walk(worktree);
  return out;
}

/**
 * Terminal run whose branch is pushed, or that has no PR: `home/` and published caches may go.
 * Resume-status runs (`needs_input` / `needs_human` / `base_red`), interrupted runs and live runs keep them.
 * A PR whose push check fails, finds no ref, or sees unpushed commits is not stripped (fails closed).
 * This check does not repeat the worktree stage's merged `refs/pull/<n>/head` exception. That stage
 * strips with the removal it already decided, so a pruned remote branch cannot leave caches behind
 * after the local ref is deleted.
 * Dependency folders of a `failed` run are not part of this decision: they go only with the worktree.
 */
async function stripEligible(opts: GcOptions, run: RunRecord): Promise<"strip" | "live" | "keep"> {
  const st = run.state;
  if (!st || st.result === null) return "keep";
  if (runIsLive(opts.factoryHome, run.run_id)) return "live";
  if (st.result === "locked" || isResumeResult(st.result)) return "keep";
  if (!st.pr) return "strip";
  if (!st.branch || !existsSync(st.repo)) return "keep";
  const unpushed = await branchHasUnpushedCommits(st.repo, st.branch);
  return unpushed.unpushed ? "keep" : "strip";
}

function dropDir(path: string, dryRun: boolean): void {
  if (!dryRun) rmSync(path, { recursive: true, force: true });
}

/**
 * Deletes regenerable weight the caller already decided to collect: `home/`, published `evidence/`,
 * service logs, and — when `heavy` — every `node_modules` / `.venv` / `.nox` under the worktree.
 * Does not remove the worktree and does not re-check whether the branch is pushed. Safe to call again
 * in the same report (including dry-run, where the directories are still there).
 */
export function applyTerminalStrip(opts: GcOptions, report: GcReport, run: RunRecord, heavy: boolean): void {
  const st = run.state;
  if (!st) return;
  const runsRoot = join(opts.factoryHome, "runs");
  const dry = opts.dryRun === true;
  const home = join(run.dir, "home");
  const homeKept = report.skipped.some((s) => s.run_id === run.run_id && s.reason.startsWith("home/ is a symlink"));
  if (existsSync(home) && !homeKept && !report.home_removed.some((h) => h.run_id === run.run_id)) {
    if (isProtectedFactoryPath(opts.factoryHome, home) || !realDirInside(runsRoot, home)) {
      report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason: "home/ is a symlink or outside $FACTORY_HOME/runs; kept" });
    } else {
      const bytes = dirBytes(home);
      dropDir(home, dry);
      report.home_removed.push({
        run_id: run.run_id,
        repo: st.repo,
        bytes,
        reason: st.pr ? "terminal run, branch pushed; sandbox home is cache" : "terminal run, no PR; sandbox home is cache",
      });
    }
  }
  const prior = report.run_dirs_removed.find((c) => c.run_id === run.run_id);
  const already = new Set(prior?.removed ?? []);
  const removed: ("evidence/" | "services/")[] = [];
  const evidence = join(run.dir, "evidence");
  if (!already.has("evidence/") && existsSync(evidence) && evidencePublished(run.dir) && realDirInside(runsRoot, evidence) && !isProtectedFactoryPath(opts.factoryHome, evidence)) {
    dropDir(evidence, dry);
    removed.push("evidence/");
  }
  const services = join(run.dir, "services");
  if (!already.has("services/") && existsSync(services) && realDirInside(runsRoot, services) && !isProtectedFactoryPath(opts.factoryHome, services)) {
    dropDir(services, dry);
    removed.push("services/");
  }
  if (removed.length) {
    if (prior) prior.removed.push(...removed);
    else report.run_dirs_removed.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, removed });
  }
  if (!heavy || report.stripped.some((s) => s.run_id === run.run_id)) return;
  const wt = st.worktree && existsSync(st.worktree) ? st.worktree : null;
  if (!wt) return;
  const dirs = heavyUnder(wt).sort();
  if (!dirs.length) return;
  if (!dry) for (const rel of dirs) rmSync(join(wt, rel), { recursive: true, force: true });
  report.stripped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, removed: dirs });
}

/**
 * Deletes regenerable weight from a terminal run: `home/`, published `evidence/`, service logs, and — except
 * for a `failed` run — every `node_modules` / `.venv` / `.nox` under the worktree. `failed` is resumable and
 * setup does not run again, so those folders stay until the worktree stage removes the worktree (same
 * pushed/merged decision, including `refs/pull/<n>/head`). Keeps `events.jsonl`, `result.json`, `state.json`,
 * `plan.json`, `pr.md`, review and gate reports. Does not remove the worktree. No repo lock: these paths
 * are cache, not a git operation.
 */
export async function gcStripTerminal(opts: GcOptions, report: GcReport): Promise<void> {
  for (const run of listRuns(opts.factoryHome)) {
    const st = run.state;
    if (!st) continue;
    const eligible = await stripEligible(opts, run);
    if (eligible === "keep") continue;
    if (eligible === "live") {
      report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason: "run is live; home/ kept" });
      continue;
    }
    // Resume of `failed` does not re-run setup. Dependency folders wait for the worktree stage.
    applyTerminalStrip(opts, report, run, st.result !== "failed");
  }
}

/** Runs `git worktree prune` on repositories that had worktree cleanup, under the git-ops lock. */
export async function pruneFactoryWorktrees(repos: Iterable<string>, opts: GcOptions, report: GcReport): Promise<void> {
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    if (opts.dryRun) {
      report.worktree_pruned.push({ repo });
      continue;
    }
    const op = await tryRepoGitOps(
      repo,
      () => git(repo, ["worktree", "prune"]).catch(() => ""),
      opts.gitOpsWaitMs === undefined ? undefined : { waitMs: opts.gitOpsWaitMs },
    );
    if (op.ok) report.worktree_pruned.push({ repo });
  }
}
