import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "../gh.js";
import { git, gitOk, repoLockId } from "../git.js";
import { acquireRepoLock } from "../pipeline/lock.js";
import { listRuns, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";

/** `factory gc` result (schema `schemas/gc.schema.json`). */
export interface GcReport {
  dry_run: boolean;
  cleaned: { run_id: string; repo: string; pr: string; pr_state: "merged" | "closed"; worktree_removed: boolean; branch_deleted: boolean; remote_branch_deleted: boolean; notes: string[] }[];
  skipped: { run_id: string; repo: string; pr: string | null; reason: string }[];
}

/** Only branches the factory created are ever deleted. */
const FACTORY_BRANCH = /^factory\/[A-Za-z0-9._/-]+$/;

async function localSha(repo: string, branch: string): Promise<string | null> {
  return (await gitOk(repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])) ? (await git(repo, ["rev-parse", `refs/heads/${branch}`])).trim() : null;
}

async function remoteSha(repo: string, branch: string): Promise<string | null> {
  const out = (await git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim();
  return out ? out.split(/\s+/)[0]! : null;
}

function markCollected(run: RunRecord, at: string): void {
  const path = join(run.dir, "state.json");
  const tmp = `${path}.gc-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...run.state, gc_at: at }, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Cleans up after runs whose PR is merged or closed (SPEC §9, Amendment n): removes the worktree,
 * deletes the local `factory/*` branch and the remote branch when it still points at the commit the
 * factory pushed (someone else's later push is never deleted). Plain `git push --delete`, no force.
 * A dirty worktree is kept unless `force`. Runs of a repository whose lock is held are skipped.
 */
export async function gc(opts: { factoryHome: string; github: GitHub; dryRun?: boolean; force?: boolean; now?: () => number }): Promise<GcReport> {
  const report: GcReport = { dry_run: opts.dryRun ?? false, cleaned: [], skipped: [] };
  const now = () => new Date(opts.now?.() ?? Date.now()).toISOString();
  for (const run of listRuns(opts.factoryHome)) {
    const st = run.state;
    if (!st?.pr || !st.branch || st.gc_at) continue;
    const skip = (reason: string) => void report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason });
    if (!existsSync(st.repo)) {
      skip("repository directory is gone");
      continue;
    }
    const release = acquireRepoLock(opts.factoryHome, await repoLockId(st.repo), `gc-${run.run_id}`);
    if (!release) {
      skip("repository is locked by a running factory process");
      continue;
    }
    try {
      let pr;
      try {
        pr = await opts.github.prStatus(st.repo, st.pr);
      } catch (e) {
        skip(`PR state unknown: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      if (pr.state === "open") {
        skip("PR is open");
        continue;
      }
      const wt = st.worktree && existsSync(st.worktree) ? st.worktree : null;
      if (wt && !opts.force && (await git(wt, ["status", "--porcelain"]).catch(() => "")).trim()) {
        skip("worktree has uncommitted changes (use --force)");
        continue;
      }
      const entry = { run_id: run.run_id, repo: st.repo, pr: st.pr, pr_state: pr.state, worktree_removed: false, branch_deleted: false, remote_branch_deleted: false, notes: [] as string[] };
      const factoryBranch = FACTORY_BRANCH.test(st.branch);
      if (!factoryBranch) entry.notes.push(`branch ${st.branch} is not a factory/* branch; kept`);
      const local = await localSha(st.repo, st.branch);
      let remote: string | null = null;
      if (factoryBranch && local) {
        try {
          remote = await remoteSha(st.repo, st.branch);
          if (!remote) entry.notes.push("remote branch already gone");
          else if (remote !== local) entry.notes.push("remote branch moved since the factory pushed it; kept");
        } catch (e) {
          entry.notes.push(`remote not reachable; remote branch kept (${(e as Error).message.slice(0, 120)})`);
        }
      }
      if (!opts.dryRun) {
        if (wt) {
          await git(st.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt]);
          entry.worktree_removed = true;
        } else await git(st.repo, ["worktree", "prune"]).catch(() => "");
        if (factoryBranch && local) {
          await git(st.repo, ["branch", "-D", st.branch]);
          entry.branch_deleted = true;
        }
        if (factoryBranch && local && remote && remote === local) {
          try {
            await git(st.repo, ["push", "origin", "--delete", st.branch]);
            entry.remote_branch_deleted = true;
          } catch (e) {
            entry.notes.push(`remote branch delete failed: ${(e as Error).message.slice(0, 120)}`);
          }
        }
        markCollected(run, now());
      } else {
        entry.worktree_removed = wt !== null;
        entry.branch_deleted = factoryBranch && local !== null;
        entry.remote_branch_deleted = factoryBranch && local !== null && remote === local;
      }
      report.cleaned.push(entry);
    } finally {
      release();
    }
  }
  return report;
}

export async function gcCommand(opts: { factoryHome: string; github: GitHub; dryRun: boolean; force: boolean; json: boolean }, io: Io): Promise<number> {
  const r = await gc(opts);
  if (opts.json) io.out(JSON.stringify(r) + "\n");
  else {
    const verb = r.dry_run ? "would clean" : "cleaned";
    for (const c of r.cleaned) io.out(`${verb} ${c.run_id} (${c.pr}, ${c.pr_state})${c.notes.length ? ` — ${c.notes.join("; ")}` : ""}\n`);
    for (const s of r.skipped) io.out(`skipped ${s.run_id}${s.pr ? ` (${s.pr})` : ""}: ${s.reason}\n`);
    if (!r.cleaned.length && !r.skipped.length) io.out("nothing to clean\n");
  }
  return 0;
}
