import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sleep } from "../agents/fake-runner.js";
import type { GitHub } from "../gh.js";
import { AUTO_GC_GIT_OPS_WAIT_MS, git, gitOk, tryRepoGitOps } from "../git.js";
import type { Fetch } from "../notify.js";
import { activeHolders } from "../pipeline/lock.js";
import { EVIDENCE_RETENTION_DAYS, pruneEvidence } from "../evaluate/evidence.js";
import { listRuns, type RunRecord } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { BERLIN, workingDaysElapsed } from "../working-days.js";
import { deploySelfBusy, loadGcRetention } from "../gc/retention-config.js";
import { branchHasUnpushedCommits, HOUR as MS_HOUR, lastActivity, protectedIdleRun, resolveGcPrState, worktreeRetentionMs } from "../gc/retention-helpers.js";
import { appendGcLog } from "../gc/retention-log.js";
import { gcStripTerminal, pruneFactoryWorktrees } from "../gc/retention-stages.js";
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

/** True when GitHub's `refs/pull/<n>/head` points at the local branch tip; false on any error. */
async function pullHeadMatches(repo: string, prUrl: string, branch: string): Promise<boolean> {
  const n = /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl)?.[1];
  if (!n) return false;
  try {
    const local = await localSha(repo, branch);
    if (!local) return false;
    const out = (await git(repo, ["ls-remote", "origin", `refs/pull/${n}/head`])).trim();
    return out.split(/\s+/)[0] === local;
  } catch {
    return false;
  }
}

function markCollected(run: RunRecord, at: string): void {
  const path = join(run.dir, "state.json");
  const tmp = `${path}.gc-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...run.state, gc_at: at }, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Default worktree retention for failed no-PR runs when `--retention-days` is omitted. */
export const GC_RETENTION_DAYS = 7;
/** A needs_input run with no answer for this many Mon–Fri days (Europe/Berlin) is abandoned. */
export const NEEDS_INPUT_WORKING_DAYS = 2;

export interface GcOptions {
  factoryHome: string;
  github: GitHub;
  dryRun?: boolean;
  force?: boolean;
  now?: () => number;
  retentionDays?: number;
  /** Evidence-branch retention (a commit and a push per repository); off for the automatic gc of `factory run`. */
  evidence?: boolean;
  /** When true, default dry-run comes from profile `gc.retention.dry_run` (for cron / LaunchAgent). */
  scheduled?: boolean;
  /** Pre-loaded retention config (tests). */
  retention?: ReturnType<typeof loadGcRetention>;
  writeLog?: boolean;
  /** needs_input with no answer for this many working days (Mon–Fri, Europe/Berlin) is abandoned. Default 2. */
  needsInputWorkingDays?: number;
  /** Webhook transport for the needs_input-timeout notification (tests). */
  notifyFetch?: Fetch;
  notifySleep?: Sleep;
  notifyBackoffMs?: number[];
  /** How long to wait for the per-repo git-ops lock. Default 60s (`GIT_OPS_WAIT_MS`). */
  gitOpsWaitMs?: number;
}

function runIsLive(factoryHome: string, runId: string): boolean {
  return activeHolders(factoryHome).some((h) => h.runId === runId);
}

function skipGitOps(skip: (reason: string) => void, op: "busy" | "not-a-repo"): void {
  skip(op === "busy" ? "git worktree operations are busy; worktree kept" : "repository is not a git checkout");
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
    run_dirs_removed: [],
    worktree_pruned: [],
  };
}

/**
 * Scheduled gc is dry-run when the profile says so, even if the CLI default is live.
 * A dry-run must not resume `base_red` runs (`resumesBaseRedAfterGc`).
 */
export function effectiveGcDryRun(opts: { dryRun?: boolean; scheduled?: boolean }, retentionDryRun: boolean): boolean {
  return opts.scheduled ? opts.dryRun === true || retentionDryRun : (opts.dryRun ?? false);
}

/** True when `factory gc` should continue waiting GitHub-CI `base_red` runs. Scheduled dry-run does not. */
export function resumesBaseRedAfterGc(opts: { dryRun?: boolean; scheduled?: boolean }, retentionDryRun: boolean): boolean {
  return !effectiveGcDryRun(opts, retentionDryRun);
}

/**
 * - PR merged or closed: removes the worktree, deletes the local `factory/*` branch and the remote branch when it
 *   still points at the commit the factory pushed (someone else's later push is never deleted). Plain
 *   `git push --delete`, no force.
 * - No PR (failed, needs_input, needs_human, interrupted) and idle for `retentionDays` (default 7): removes the
 *   worktree only; the local branch and its commits stay. Such a run can no longer be resumed.
 * - A terminal run whose branch is pushed, or that has no PR: deletes `home/`, published `evidence/`,
 *   and service logs. `done` and `abandoned` also lose every `node_modules` / `.venv` / `.nox` under the
 *   worktree. A `failed` run keeps those folders until the worktree goes (merged/closed PR, or the no-PR
 *   failed retention): resume does not run setup again. The run directory keeps `events.jsonl`,
 *   `result.json`, `state.json`, `plan.json`, `pr.md` and review/gate reports. Resume-status runs keep the
 *   worktree and `home/`. This strip also runs from the automatic gc at `factory run` start. The push check
 *   fails closed (git error or a missing ref keeps the run).
 * - PR open: the worktree stays (`done` / `abandoned` dependency folders are already stripped when the branch is pushed; `failed` keeps them).
 * A dirty worktree is kept unless `force`. A run that holds a lock slot is left untouched. Worktree removal
 * and local branch deletion take the per-repo git-ops lock (not a run slot), so they proceed while another
 * run of the same repo is active; PR state is looked up before that lock, so a parallel `factory run` is
 * never blocked by a network call. The strip takes no repo lock.
 * Evidence retention: run folders older than 30 days leave the `factory-evidence`
 * branch of every repository the factory ran in, with a normal commit and a plain push.
 * needs_input with no answer for 2 working days (Mon–Fri, Europe/Berlin) is abandoned and the owner is notified.
 * Run directories are not archived and are not deleted by age; status and stats keep seeing them.
 */
export async function gc(opts: GcOptions): Promise<GcReport> {
  const cfg = opts.retention ?? loadGcRetention(opts.factoryHome);
  // `--scheduled` (LaunchAgent / cron) is dry-run whenever the profile says so, even though the CLI passes
  // dryRun=false by default, and it never forces: dirty worktrees are always kept on the scheduled path.
  const dryRun = effectiveGcDryRun(opts, cfg.dry_run);
  if (opts.scheduled) opts = { ...opts, force: false };
  const report = emptyReport(dryRun);
  const nowMs = () => opts.now?.() ?? Date.now();
  const now = () => new Date(nowMs()).toISOString();
  const dirty = async (wt: string) => !opts.force && (await git(wt, ["status", "--porcelain"]).catch(() => "")).trim() !== "";
  const deployBusy = deploySelfBusy();
  if (deployBusy) {
    report.skipped.push({ run_id: "(all)", repo: "(all)", pr: null, reason: "deploy-self holds the deploy lock; gc skipped" });
    if (opts.writeLog ?? true) report.log_path = appendGcLog(opts.factoryHome, { at: now(), scheduled: opts.scheduled ?? false, deploy_self_busy: true, report });
    return report;
  }
  // Strip before worktree removal. That stage deletes the local branch, and a missing ref keeps the run,
  // so the push check has to see the ref that still exists.
  await gcStripTerminal({ ...opts, dryRun }, report);
  const prunedRepos = new Set<string>();
  // One timeout per repo per gc. A lock that stays busy does not cost 60s on every later run.
  const gitOpsBusy = new Set<string>();
  const withGcGitOps = async <T>(repo: string, fn: () => Promise<T>): Promise<T | "busy" | "not-a-repo"> => {
    if (gitOpsBusy.has(repo)) return "busy";
    const op = await tryRepoGitOps(repo, fn, opts.gitOpsWaitMs === undefined ? undefined : { waitMs: opts.gitOpsWaitMs });
    if (!op.ok) {
      if (op.reason === "busy") gitOpsBusy.add(repo);
      return op.reason === "busy" ? "busy" : "not-a-repo";
    }
    return op.value;
  };
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
      const looked = await resolveGcPrState(opts.github, st.repo, st.pr);
      if (looked.state === "unknown") {
        skip(looked.reason);
        continue;
      }
      if (looked.state === "none") continue;
      prState = looked.state;
    }
    if (runIsLive(opts.factoryHome, run.run_id)) {
      skip("run is live; left untouched");
      continue;
    }
    if (st.pr && prState === "open") {
      skip("PR is open");
      continue;
    }
    if (wt && (await dirty(wt))) {
      skip("worktree has uncommitted changes (use --force)");
      continue;
    }
    if (st.branch) {
      const unpushed = await branchHasUnpushedCommits(st.repo, st.branch);
      // A merged PR whose head branch GitHub auto-deleted (and a pruned fetch dropped) is still pushed:
      // GitHub keeps refs/pull/<n>/head. Fails closed when that ref cannot be read.
      if (unpushed.unpushed && st.pr && prState === "merged" && (await pullHeadMatches(st.repo, st.pr, st.branch))) unpushed.unpushed = false;
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
        const op = await withGcGitOps(st.repo, async () => {
          if (runIsLive(opts.factoryHome, run.run_id)) return "live" as const;
          if (await dirty(wt!)) return "dirty" as const;
          await git(st.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt!]);
          return "ok" as const;
        });
        if (op === "busy" || op === "not-a-repo") {
          skipGitOps(skip, op);
          continue;
        }
        if (op === "live") {
          skip("run is live; left untouched");
          continue;
        }
        if (op === "dirty") {
          skip("worktree has uncommitted changes (use --force)");
          continue;
        }
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
      const op = await withGcGitOps(st.repo, async () => {
        if (runIsLive(opts.factoryHome, run.run_id)) return "live" as const;
        if (wt && (await dirty(wt))) return "dirty" as const;
        if (wt) {
          await git(st.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt]);
          entry.worktree_removed = true;
          prunedRepos.add(st.repo);
        } else await git(st.repo, ["worktree", "prune"]).catch(() => "");
        if (factoryBranch && local) {
          await git(st.repo, ["branch", "-D", branch]);
          entry.branch_deleted = true;
        }
        return "ok" as const;
      });
      if (op === "busy" || op === "not-a-repo") {
        skipGitOps(skip, op);
        continue;
      }
      if (op === "live") {
        skip("run is live; left untouched");
        continue;
      }
      if (op === "dirty") {
        skip("worktree has uncommitted changes (use --force)");
        continue;
      }
      // Network delete stays outside the git-ops lock so a slow push does not stall worktree adds.
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
  }
  await abandonUnanswered({ ...opts, dryRun }, report, nowMs);
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
 * pushes. Live runs, open PRs and runs inside the retention are left alone (see `gc`). The git-ops wait
 * is shorter than a manual gc so one busy lock cannot consume the whole budget.
 */
export async function autoGc(opts: { factoryHome: string; github: GitHub; timeoutMs?: number; log?: (s: string) => void }): Promise<GcReport | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? 60_000);
      timer.unref();
    });
    const r = await Promise.race([
      gc({ factoryHome: opts.factoryHome, github: opts.github, evidence: false, writeLog: false, gitOpsWaitMs: AUTO_GC_GIT_OPS_WAIT_MS }),
      timeout,
    ]);
    if (!r) opts.log?.("factory: automatic gc timed out; run `factory gc` by hand\n");
    else if (r.cleaned.length || r.stripped.length || r.abandoned.length || r.home_removed.length || r.run_dirs_removed.length) {
      opts.log?.(
        `factory: gc cleaned ${r.cleaned.length} worktree(s), stripped dependency folders in ${r.stripped.length}, abandoned ${r.abandoned.length}, removed ${r.home_removed.length} home dir(s), removed evidence/services in ${r.run_dirs_removed.length} (factory gc --dry-run shows details)\n`,
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
    for (const c of r.run_dirs_removed) io.out(`${r.dry_run ? "would remove" : "removed"} ${c.removed.join(", ")} for ${c.run_id}\n`);
    if (r.log_path) io.out(`gc report appended to ${r.log_path}\n`);
    if (!r.cleaned.length && !r.skipped.length && !r.stripped.length && !r.abandoned.length && !r.home_removed.length && !r.run_dirs_removed.length) io.out("nothing to clean\n");
  }
  return 0;
}
