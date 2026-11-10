import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sleep } from "../agents/fake-runner.js";
import { EventLog, type RunResult, writeResult } from "../events.js";
import { git, repoLockId, withRepoGitOps } from "../git.js";
import { loadNotifyConfig, notifyRunFinished, type Fetch } from "../notify.js";
import { releaseRunLock } from "../pipeline/lock.js";
import type { RunState } from "../pipeline/state.js";
import { listRuns, type RunRecord } from "../runs.js";

export interface AbandonOptions {
  factoryHome: string;
  runId: string;
  /** Stored on the run and sent in the notify payload. */
  reason: string;
  now?: () => number;
  /** POST the run-finished webhook (default true). A missing hook is not a failure. */
  notify?: boolean;
  notifyFetch?: Fetch;
  sleep?: Sleep;
  notifyBackoffMs?: number[];
}

export interface AbandonOutcome {
  ok: boolean;
  message: string;
  /** True when a webhook POST was attempted and returned sent. */
  notified: boolean;
  worktree_removed: boolean;
}

/**
 * Marks a run abandoned: releases a stale lock held by it, removes its worktree, writes
 * `result.json` / `state.json`, and keeps the run directory (events, logs). A live process
 * that still holds the lock is left alone. The branch is kept.
 */
export async function abandonRun(opts: AbandonOptions): Promise<AbandonOutcome> {
  const run = listRuns(opts.factoryHome).find((r) => r.run_id === opts.runId);
  if (!run?.state) return { ok: false, message: `no run ${opts.runId} under ${join(opts.factoryHome, "runs")}`, notified: false, worktree_removed: false };
  if (run.state.result === "abandoned") return { ok: true, message: `run ${opts.runId} is already abandoned`, notified: false, worktree_removed: false };

  let lockNote = "no lock held";
  if (existsSync(run.state.repo)) {
    const lock = releaseRunLock(opts.factoryHome, await repoLockId(run.state.repo), opts.runId);
    if (lock.status === "live") {
      return { ok: false, message: `run ${opts.runId} is still running (pid ${lock.pid}); stop it before abandon`, notified: false, worktree_removed: false };
    }
    if (lock.status === "released") lockNote = `released stale lock (pid ${lock.pid})`;
  }

  let worktreeRemoved = false;
  if (run.state.worktree) {
    try {
      worktreeRemoved = await removeRunWorktree(run.state.repo, run.state.worktree);
    } catch (e) {
      return { ok: false, message: `worktree not removed: ${(e as Error).message.slice(0, 200)}`, notified: false, worktree_removed: false };
    }
  }

  const now = opts.now ?? Date.now;
  const state: RunState = { ...run.state, result: "abandoned", reason: opts.reason, worktree: null, updated_at: new Date(now()).toISOString() };
  writeFileSync(join(run.dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  const result = abandonedResult({ ...run, state }, opts.reason);
  writeResult(join(run.dir, "result.json"), result);

  const events = new EventLog(run.dir, run.run_id, now);
  events.emit({ step: "run", event: "run_finished", data: { result: "abandoned", reason: opts.reason } });
  let notified = false;
  if (opts.notify !== false) {
    const outcome = await notifyRunFinished(result, { factoryHome: opts.factoryHome, fetch: opts.notifyFetch, sleep: opts.sleep, backoffMs: opts.notifyBackoffMs }, events, new Date(now()));
    notified = outcome?.status === "sent";
    // notifyRunFinished stays silent when there is no notify.yaml; the run log still records the attempt.
    let configured = true;
    try {
      configured = loadNotifyConfig(opts.factoryHome) !== undefined;
    } catch {
      // Unreadable notify.yaml: notifyRunFinished already logged the error.
    }
    if (!configured) events.emit({ step: "run", event: "notify", data: { status: "skipped", reason: "no notify.yaml" } });
  }
  const branch = state.branch ? `; branch ${state.branch} kept` : "";
  const wt = worktreeRemoved ? "; worktree removed" : "";
  return { ok: true, message: `abandoned ${opts.runId} (${lockNote}${wt}${branch}); result and logs kept in ${run.dir}`, notified, worktree_removed: worktreeRemoved };
}

/** Deletes a run worktree. A git failure falls back to removing the directory. True when something was removed. */
export async function removeRunWorktree(repo: string, worktree: string): Promise<boolean> {
  if (!existsSync(repo)) {
    if (!existsSync(worktree)) return false;
    rmSync(worktree, { recursive: true, force: true });
    return !existsSync(worktree);
  }
  return withRepoGitOps(repo, async () => {
    if (!existsSync(worktree)) {
      await git(repo, ["worktree", "prune"]).catch(() => undefined);
      return false;
    }
    try {
      await git(repo, ["worktree", "remove", "--force", worktree]);
      return true;
    } catch {
      // not registered, or the git dir is wedged: delete the directory below
    }
    rmSync(worktree, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]).catch(() => undefined);
    return !existsSync(worktree);
  });
}

function abandonedResult(run: RunRecord, reason: string): RunResult {
  const prev = run.result;
  const st = run.state!;
  return {
    run_id: run.run_id,
    repo: st.repo,
    task: st.task?.ref ?? prev?.task ?? "",
    type: prev?.type ?? null,
    lane: st.lane ?? prev?.lane ?? "standard",
    result: "abandoned",
    risk: prev?.risk ?? null,
    ...(prev?.risk_reasons ? { risk_reasons: prev.risk_reasons } : {}),
    merge_policy: prev?.merge_policy ?? null,
    pr: st.pr,
    rounds: prev?.rounds ?? st.rounds ?? 0,
    minutes: prev?.minutes ?? 0,
    cost_usd: prev?.cost_usd ?? 0,
    reason,
    ...(prev?.questions?.length ? { questions: prev.questions } : {}),
    branch: st.branch,
    worktree: null,
    run_dir: run.dir,
  };
}
