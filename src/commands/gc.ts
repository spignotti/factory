import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sleep } from "../agents/fake-runner.js";
import type { GitHub } from "../gh.js";
import { git, gitOk, repoLockId } from "../git.js";
import type { Fetch } from "../notify.js";
import { acquireRepoLock, activeHolders } from "../pipeline/lock.js";
import { EVIDENCE_RETENTION_DAYS, pruneEvidence } from "../evaluate/evidence.js";
import { listRuns, type RunRecord } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { BERLIN, workingDaysElapsed } from "../working-days.js";
import { deploySelfBusy, loadGcRetention } from "../gc/retention-config.js";
import { branchHasUnpushedCommits, HOUR as MS_HOUR, lastActivity, protectedIdleRun, worktreeRetentionMs } from "../gc/retention-helpers.js";
import { appendGcLog } from "../gc/retention-log.js";
import { gcArchiveRuns, gcMetadataArchive, gcRunHomes, pruneFactoryWorktrees } from "../gc/retention-stages.js";
import type { Io } from "./gates.js";
import { abandonRun } from "./abandon.js";
import type { z } from "zod";
import type { GcReportSchema } from "../schemas/reports.js";

/** `factory gc` result (schema `schemas/gc.schema.json`). */
export type GcReport = z.infer<typeof GcReportSchema>;

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

/** Default worktree retention for failed no-PR runs when `--retention-days` is omitted. */
export const GC_RETENTION_DAYS = 7;
/** @deprecated Use profile `gc.retention.metadata_days` (default 90). CLI `--archive-days` overrides metadata retention. */
export const ARCHIVE_RETENTION_DAYS = 90;
/** A needs_input run with no answer for this many Mon–Fri days (Europe/Berlin) is abandoned. */
export const NEEDS_INPUT_WORKING_DAYS = 2;
/** Finished runs with an open PR keep their worktree but lose the regenerable dependency folders after this. */
export const GC_STRIP_AFTER_HOURS = 12;
/** Regenerable dependency folders at the worktree root (`setup` recreates them). */
export const HEAVY_DIRS = ["node_modules", ".venv", ".nox"] as const;

export interface GcOptions {
  factoryHome: string;
  github: GitHub;
  dryRun?: boolean;
  force?: boolean;
  now?: () => number;
  retentionDays?: number;
  stripAfterHours?: number;
  /** Evidence-branch retention (a commit and a push per repository); off for the automatic gc of `factory run`. */
  evidence?: boolean;
  /** Override profile `gc.retention.metadata_days` for metadata tarball moves. */
  archiveDays?: number;
  /** When true, default dry-run comes from profile `gc.retention.dry_run` (for cron). */
  scheduled?: boolean;
  /** Pre-loaded retention config (tests). */
  retention?: ReturnType<typeof loadGcRetention>;
  /** Home/metadata/archive stages and gc.log (off for automatic gc at run start). */
  retentionStages?: boolean;
  writeLog?: boolean;
  /** needs_input with no answer for this many working days (Mon–Fri, Europe/Berlin) is abandoned. Default 2. */
  needsInputWorkingDays?: number;
  /** Webhook transport for the needs_input-timeout notification (tests). */
  notifyFetch?: Fetch;
  notifySleep?: Sleep;
  notifyBackoffMs?: number[];
}

function emptyReport(dryRun: boolean): GcReport {
  return {
    dry_run: dryRun,
    cleaned: [],
    skipped: [],
    stripped: [],
    evidence: [],
    abandoned: [],
    home_removed: [],
    metadata_moved: [],
    archive_purged: [],
    worktree_pruned: [],
  };
}

/**
 * - PR merged or closed: removes the worktree, deletes the local `factory/*` branch and the remote branch when it
 *   still points at the commit the factory pushed (someone else's later push is never deleted). Plain
 *   `git push --delete`, no force.
 * - No PR (failed, needs_input, needs_human, interrupted) and idle for `retentionDays` (default 7): removes the
 *   worktree only; the local branch and its commits stay. Such a run can no longer be resumed.
 * - PR open and the run finished, idle for `stripAfterHours` (default 12): deletes only `node_modules`, `.venv`
 *   and `.nox` at the worktree root; the worktree stays.
 * A dirty worktree is kept unless `force`. Runs of a repository whose lock is held are skipped (PR states are
 * looked up before the lock is taken, so a parallel `factory run` is never blocked by a network call).
 * Evidence retention: run folders older than 30 days leave the `factory-evidence`
 * branch of every repository the factory ran in, with a normal commit and a plain push.
 * needs_input with no answer for 2 working days (Mon–Fri, Europe/Berlin) is abandoned and the owner is notified.
 * Run directories idle for `archiveDays` (default 14) keep the result summary and logs; active runs are not touched.
 */
export async function gc(opts: GcOptions): Promise<GcReport> {
  let cfg = opts.retention ?? loadGcRetention(opts.factoryHome);
  if (opts.archiveDays !== undefined) cfg = { ...cfg, metadata_days: opts.archiveDays };
  const dryRun = opts.dryRun ?? (opts.scheduled ? cfg.dry_run : false);
  const report = emptyReport(dryRun);
  const nowMs = () => opts.now?.() ?? Date.now();
  const now = () => new Date(nowMs()).toISOString();
  const stripMs = (opts.stripAfterHours ?? GC_STRIP_AFTER_HOURS) * MS_HOUR;
  const dirty = async (wt: string) => !opts.force && (await git(wt, ["status", "--porcelain"]).catch(() => "")).trim() !== "";
  const deployBusy = deploySelfBusy();
  if (deployBusy) {
    report.skipped.push({ run_id: "(all)", repo: "(all)", pr: null, reason: "deploy-self holds the deploy lock; gc skipped" });
    if (opts.writeLog ?? true) report.log_path = appendGcLog(opts.factoryHome, { at: now(), scheduled: opts.scheduled ?? false, deploy_self_busy: true, report });
    return report;
  }
  const prunedRepos = new Set<string>();
  for (const run of listRuns(opts.factoryHome)) {
    const st = run.state;
    if (!st || st.gc_at) continue;
    if (protectedIdleRun(run, nowMs(), cfg.worktree_resume_days)) continue;
    const wt = st.worktree && existsSync(st.worktree) ? st.worktree : null;
    const idle = nowMs() - lastActivity(run);
    const retentionMs = worktreeRetentionMs(run, cfg, opts.retentionDays);
    const skip = (reason: string) => void report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason });
    if (st.pr && !st.branch) continue;
    if (!st.pr && (!wt || idle < retentionMs)) continue;
    if (!existsSync(st.repo)) {
      skip("repository directory is gone");
      continue;
    }
    let prState: "open" | "merged" | "closed" = "open";
    if (st.pr) {
      try {
        prState = (await opts.github.prStatus(st.repo, st.pr)).state;
      } catch (e) {
        skip(`PR state unknown: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
    }
    const release = acquireRepoLock(opts.factoryHome, await repoLockId(st.repo), `gc-${run.run_id}`, { maxRuns: lockMaxRuns(st.repo), exclusive: true });
    if (!release) {
      skip("repository is locked by a running factory process");
      continue;
    }
    try {
      if (st.pr && prState === "open") {
        if (wt && st.step === "finished" && idle >= stripMs) {
          const heavy = HEAVY_DIRS.filter((d) => existsSync(join(wt, d)));
          if (heavy.length) {
            if (!dryRun) for (const d of heavy) rmSync(join(wt, d), { recursive: true, force: true });
            report.stripped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, removed: [...heavy] });
          }
        }
        skip("PR is open");
        continue;
      }
      if (wt && (await dirty(wt))) {
        skip("worktree has uncommitted changes (use --force)");
        continue;
      }
      if (st.branch) {
        const unpushed = await branchHasUnpushedCommits(st.repo, st.branch);
        if (unpushed.unpushed) {
          skip(unpushed.reason ?? "branch has unpushed commits");
          continue;
        }
      }
      if (!st.pr) {
        const entry = {
          run_id: run.run_id,
          repo: st.repo,
          pr: null,
          pr_state: "none" as const,
          worktree_removed: true,
          branch_deleted: false,
          remote_branch_deleted: false,
          notes: [`no PR, idle ${Math.floor(idle / MS_HOUR / 24)} days (${st.result ?? "interrupted"}); branch ${st.branch ?? "(none)"} kept; resume is no longer possible`],
        };
        if (!dryRun) {
          await git(st.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt!]);
          markCollected(run, now());
          prunedRepos.add(st.repo);
        }
        report.cleaned.push(entry);
        continue;
      }
      const branch = st.branch!;
      const entry = { run_id: run.run_id, repo: st.repo, pr: st.pr, pr_state: prState as "merged" | "closed", worktree_removed: false, branch_deleted: false, remote_branch_deleted: false, notes: [] as string[] };
      const factoryBranch = FACTORY_BRANCH.test(branch);
      if (!factoryBranch) entry.notes.push(`branch ${branch} is not a factory/* branch; kept`);
      const local = await localSha(st.repo, branch);
      let remote: string | null = null;
      if (factoryBranch && local) {
        try {
          remote = await remoteSha(st.repo, branch);
          if (!remote) entry.notes.push("remote branch already gone");
          else if (remote !== local) entry.notes.push("remote branch moved since the factory pushed it; kept");
        } catch (e) {
          entry.notes.push(`remote not reachable; remote branch kept (${(e as Error).message.slice(0, 120)})`);
        }
      }
      if (!dryRun) {
        if (wt) {
          await git(st.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt]);
          entry.worktree_removed = true;
          prunedRepos.add(st.repo);
        } else await git(st.repo, ["worktree", "prune"]).catch(() => "");
        if (factoryBranch && local) {
          await git(st.repo, ["branch", "-D", branch]);
          entry.branch_deleted = true;
        }
        if (factoryBranch && local && remote && remote === local) {
          try {
            await git(st.repo, ["push", "origin", "--delete", branch]);
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
  await abandonUnanswered({ ...opts, dryRun }, report, nowMs);
  if (opts.retentionStages ?? true) {
    gcRunHomes({ ...opts, dryRun }, report, cfg, nowMs);
    gcMetadataArchive({ ...opts, dryRun }, report, cfg, nowMs);
    gcArchiveRuns({ ...opts, dryRun }, report, cfg, nowMs);
  }
  if (opts.evidence ?? true) {
    const repos = [...new Set(listRuns(opts.factoryHome).flatMap((r) => (r.state?.repo && existsSync(r.state.repo) ? [r.state.repo] : [])))];
    for (const repo of repos) report.evidence.push(await evidenceRetention(repo, nowMs(), dryRun));
  }
  await pruneFactoryWorktrees(prunedRepos, { ...opts, dryRun }, report);
  if (opts.writeLog ?? true) report.log_path = appendGcLog(opts.factoryHome, { at: now(), scheduled: opts.scheduled ?? false, report });
  return report;
}

/**
 * The automatic gc at the start of `factory run`: best effort, bounded in time, never throws, no evidence
 * pushes. Locked repositories, open PRs and runs inside the retention are left alone (see `gc`).
 */
export async function autoGc(opts: { factoryHome: string; github: GitHub; timeoutMs?: number; log?: (s: string) => void }): Promise<GcReport | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? 60_000);
      timer.unref();
    });
    const r = await Promise.race([
      gc({ factoryHome: opts.factoryHome, github: opts.github, evidence: false, retentionStages: false, writeLog: false }),
      timeout,
    ]);
    if (!r) opts.log?.("factory: automatic gc timed out; run `factory gc` by hand\n");
    else if (r.cleaned.length || r.stripped.length || r.abandoned.length || r.home_removed.length || r.metadata_moved.length) {
      opts.log?.(
        `factory: gc cleaned ${r.cleaned.length} worktree(s), stripped dependency folders in ${r.stripped.length}, abandoned ${r.abandoned.length}, removed ${r.home_removed.length} home dir(s), archived ${r.metadata_moved.length} run metadata tarball(s) (factory gc --dry-run shows details)\n`,
      );
    }
    return r;
  } catch (e) {
    opts.log?.(`factory: automatic gc failed (the run continues): ${(e as Error).message.slice(0, 200)}\n`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** needs_input with no answer for `needsInputWorkingDays` Mon–Fri (Europe/Berlin) is abandoned and the owner is notified. */
async function abandonUnanswered(opts: GcOptions, report: GcReport, nowMs: () => number): Promise<void> {
  const days = opts.needsInputWorkingDays ?? NEEDS_INPUT_WORKING_DAYS;
  const live = new Set(activeHolders(opts.factoryHome).map((h) => h.runId).filter((id): id is string => !!id));
  for (const run of listRuns(opts.factoryHome)) {
    const st = run.state;
    if (!st || st.result !== "needs_input" || st.gc_at || live.has(run.run_id)) continue;
    const stopped = Date.parse(st.updated_at);
    if (!Number.isFinite(stopped) || !workingDaysElapsed(new Date(stopped), new Date(nowMs()), days, BERLIN)) continue;
    const reason = `needs_input unanswered for ${days} working days (Mon-Fri, Europe/Berlin); abandoned`;
    if (opts.dryRun) {
      report.abandoned.push({ run_id: run.run_id, repo: st.repo, reason, notified: false });
      continue;
    }
    const outcome = await abandonRun({
      factoryHome: opts.factoryHome,
      runId: run.run_id,
      reason,
      now: nowMs,
      notifyFetch: opts.notifyFetch,
      sleep: opts.notifySleep,
      notifyBackoffMs: opts.notifyBackoffMs,
    });
    if (!outcome.ok) {
      report.skipped.push({ run_id: run.run_id, repo: st.repo, pr: st.pr, reason: outcome.message });
      continue;
    }
    report.abandoned.push({ run_id: run.run_id, repo: st.repo, reason, notified: outcome.notified });
  }
}

/** Checkout `concurrency.max_runs`, or 1 when repo.yaml cannot be read. Exclusive claim still covers higher slots that exist. */
function lockMaxRuns(repo: string): number {
  try {
    return loadRepoConfig(repo).concurrency.max_runs;
  } catch {
    return 1;
  }
}

async function evidenceRetention(repo: string, now: number, dryRun: boolean): Promise<GcReport["evidence"][number]> {
  let author = { name: "factory-bot", email: "factory-bot@users.noreply.github.com" };
  try {
    const { author: name, email } = loadRepoConfig(repo).git;
    author = { name, email: email ?? `${name}@users.noreply.github.com` };
  } catch {
    // No readable repo.yaml: the default author.
  }
  try {
    if (!(await gitOk(repo, ["remote", "get-url", "origin"]))) return { repo, removed: [], note: "no origin" };
    return { repo, removed: await pruneEvidence(repo, { now, dryRun, author, days: EVIDENCE_RETENTION_DAYS }) };
  } catch (e) {
    return { repo, removed: [], note: `evidence retention failed: ${(e as Error).message.slice(0, 160)}` };
  }
}

export async function gcCommand(opts: GcOptions & { json: boolean }, io: Io): Promise<number> {
  const r = await gc(opts);
  if (opts.json) io.out(JSON.stringify(r) + "\n");
  else {
    const verb = r.dry_run ? "would clean" : "cleaned";
    for (const c of r.cleaned) io.out(`${verb} ${c.run_id} (${c.pr ?? "no PR"}, ${c.pr_state})${c.notes.length ? ` — ${c.notes.join("; ")}` : ""}\n`);
    for (const x of r.stripped) io.out(`${r.dry_run ? "would strip" : "stripped"} ${x.removed.join(", ")} in ${x.run_id} (${x.pr ?? "no PR"})\n`);
    for (const s of r.skipped) io.out(`skipped ${s.run_id}${s.pr ? ` (${s.pr})` : ""}: ${s.reason}\n`);
    for (const e of r.evidence) if (e.removed.length) io.out(`${r.dry_run ? "would remove" : "removed"} ${e.removed.length} evidence folder(s) older than ${EVIDENCE_RETENTION_DAYS} days in ${e.repo}\n`);
    for (const a of r.abandoned) io.out(`${r.dry_run ? "would abandon" : "abandoned"} ${a.run_id}: ${a.reason}${a.notified ? " (owner notified)" : ""}\n`);
    for (const h of r.home_removed) io.out(`${r.dry_run ? "would remove" : "removed"} home/ for ${h.run_id} (${h.bytes} bytes)\n`);
    for (const m of r.metadata_moved) io.out(`${r.dry_run ? "would move" : "moved"} metadata for ${m.run_id} to ${m.tarball}\n`);
    for (const p of r.archive_purged) io.out(`${r.dry_run ? "would purge" : "purged"} ${p.path} (${p.bytes} bytes): ${p.reason}\n`);
    if (r.log_path) io.out(`gc report appended to ${r.log_path}\n`);
    if (
      !r.cleaned.length &&
      !r.skipped.length &&
      !r.stripped.length &&
      !r.abandoned.length &&
      !r.home_removed.length &&
      !r.metadata_moved.length &&
      !r.archive_purged.length
    )
      io.out("nothing to clean\n");
  }
  return 0;
}
