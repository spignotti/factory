import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BaseStatus } from "../gh.js";
import { prepareAgentHome } from "../agents/env.js";
import { realSleep } from "../agents/fake-runner.js";
import { InvalidOutputError, ProviderWindowError, TransientAgentError } from "../agents/models.js";
import { type Clock, EventLog, type RunResult, type RunResultKind, type RunStop, type StopCause, secretValues, writeResult } from "../events.js";
import { isCommandTimeout, sh, tail } from "../exec.js";
import { removeRunWorktree } from "../commands/abandon.js";
import { baseRef, commitAll, discardChanges, git, gitOk, headSha, isAncestor, mergeRef, withBaseWorktree, originUrl, remoteBranchExists, repoLockId, revParse, withRepoGitOps } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { PlanSchema, type Plan } from "../schemas/plan.js";
import { loadRepoConfig, parseRepoConfig, REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import { withRepoModels } from "../config.js";
import { briefing, canonicalRepoId, flushMemory, loadMemory, observations } from "../memory.js";
import { finalize, stopCauseForMergeFailure, stopCauseForSyncFailure, syncBase } from "../steps/finalize.js";
import { ensurePrDraft } from "../steps/pr-draft.js";
import { baseCheckOutcome, type GateReport, runChecks, runGates } from "../steps/gates.js";
import { gitAuthor, implementPackages } from "../steps/implement.js";
import { obtainPlan, type PlanEffort, type PlanOutcome, readTask, resolvePlanEffort, type TaskInput } from "../steps/intake.js";
import { EnvMissing } from "../services.js";
import { redactTree, type ResolvedSecrets, resolveSecrets, SecretsError } from "../secrets.js";
import { WallBudget } from "./budget.js";
import { pollCommitCi } from "./ci-wait.js";
import { agentEnv, checkDeadline, commandEnv, jailFor, runServices, type RunContext, type RunDeps, type Task, throwIfInterrupted, writeJson } from "./context.js";
import { readBaseCheck, writeBaseCheck } from "./base-check.js";
import { acquireRepoLockWithRetry, claimResources, decidePathClaim, lockRepoKey, repoLockHolder, waitForRepoLock, type LockRelease } from "./lock.js";
import { pauseRequested } from "../queue/pause.js";
import { admissionBlock } from "../queue/admit.js";
import { planPaths, touchesExclusive } from "./overlap.js";
import { fixStep, type LoopOutcome, reviewLoop } from "./loop.js";
import { openFindings } from "./merge.js";
import { budgetFrom, budgetTo, continuationLimit, missingPlanQuotes, openPrProblem } from "./recovery.js";
import { buildOutcome, buildProvenance, implementModel, nextAttempt, stopFor, writeRecoveryNote } from "./outcome.js";
import { isFailedExit, reportFailure } from "./failure.js";
import { MAX_RESOLVER_TURNS, type ResolverStop, resolverTurn } from "./resolve.js";
import { newState, readState, type RunState, saveState } from "./state.js";
import { WatchdogAbort } from "./watchdog.js";
import { postQuestions as postQuestionsOnIssue } from "./questions.js";
import { notifyRunFinished, flushNotifyOutbox, START_FLUSH } from "../notify.js";
import { listRuns, runStartedAt } from "../runs.js";

export interface RunOptions extends TaskInput {
  repo: string;
  planEffort?: PlanEffort;
  noPr?: boolean;
  /** Repo locked by another run: wait in a queue instead of returning `locked`. */
  wait?: boolean;
  /** Named notify.yaml target (`factory run --notify`). Stored on the run; the name only. */
  notifyTarget?: string;
  /** Predetermined id (`queue run`). Also placed on the child command line so a restart can match the pid. */
  runId?: string;
}

export interface ResumeOptions {
  wait?: boolean;
  /** Overrides the original run's --no-pr. */
  noPr?: boolean;
  /** Overrides the stored notify target (`factory resume --notify`). Omitted: keep the stored name. */
  notifyTarget?: string;
}

export function newRunId(now: number): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${d}-${randomBytes(3).toString("hex")}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}


/** Findings memory of the repo: where it lives and this run's briefing. Never fails the run. */
async function openMemory(f: RunFrame, deps: RunDeps, repoDir: string): Promise<string> {
  const id = canonicalRepoId(await originUrl(repoDir), repoDir);
  f.memory = { factoryHome: deps.factoryHome, repoId: id };
  try {
    return briefing(loadMemory(deps.factoryHome, id));
  } catch (e) {
    f.events.emit({ step: "intake", event: "progress", data: { memory_error: (e as Error).message } });
    return "";
  }
}

/** Flaky checks of every gate run of this run dir. */
function flakyChecks(runDir: string): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(runDir).filter((n) => /^gates-\d+\.json$/.test(n))) {
    try {
      const report = JSON.parse(readFileSync(join(runDir, file), "utf8")) as { checks?: { name: string; status: string }[] };
      for (const c of report.checks ?? []) if (c.status === "flaky") names.add(c.name);
    } catch {
      // unreadable report: nothing to learn from it
    }
  }
  return [...names];
}

/** One slot per run, up to `maxRuns` (default 1). `wait` queues instead of `locked`. The reason names the lock key, never a credential URL. */
export async function takeRepoLock(
  deps: RunDeps,
  repoDir: string,
  runId: string,
  events: EventLog,
  wait: boolean,
  maxRuns = 1,
): Promise<{ release?: LockRelease; reason: string }> {
  // Same resource files the queue claims before start. A manual run cannot pass a busy database.
  // Waiting here would hold a coding slot; the caller stays out of the repo lock instead.
  let names: string[];
  try {
    names = loadRepoConfig(repoDir).concurrency.resources;
  } catch {
    names = [];
  }
  const resources = claimResources(deps.factoryHome, names, runId);
  if (!resources.ok) {
    const who = resources.held.runId ?? "?";
    return { reason: `resource ${resources.held.name} is held by run ${who} (pid ${resources.held.pid})` };
  }
  const raw = await repoLockId(repoDir);
  const id = lockRepoKey(raw);
  const release = await acquireRepoLockWithRetry(deps.factoryHome, raw, runId, { maxRuns, signal: deps.signal });
  const wrap = (drop: LockRelease): LockRelease =>
    Object.assign(
      () => {
        drop();
        resources.release();
      },
      { slot: drop.slot },
    );
  if (release) return { release: wrap(release), reason: "" };
  const holder = repoLockHolder(deps.factoryHome, raw);
  const by = holder ? `run ${holder.runId ?? "?"} (pid ${holder.pid})` : "another run";
  if (!wait) {
    resources.release();
    return { reason: `repo ${id} is locked by ${by}` };
  }
  events.emit({ step: "intake", event: "queued", data: { repo: id, holder_run_id: holder?.runId ?? null, holder_pid: holder?.pid ?? null, waiter_pid: process.pid } });
  const queuedAt = Date.now();
  try {
    const got = await waitForRepoLock(deps.factoryHome, raw, runId, { pollMs: deps.lockPollMs ?? 15_000, signal: deps.signal, maxRuns });
    events.emit({ step: "intake", event: "progress", data: { lock_acquired: { waited_ms: Date.now() - queuedAt } } });
    return { release: wrap(got), reason: "" };
  } catch (e) {
    resources.release();
    throw e;
  }
}

/**
 * After the plan names files: keep the slot only when those paths do not overlap another live run.
 * Open pull requests do not block; a conflict between them is resolved when it happens. A conflict
 * releases the slot before waiting, so two runs cannot each hold a slot and wait. Returns false when
 * the run is `locked` (the lock is already released).
 */
async function ensurePathClaim(
  f: RunFrame,
  deps: RunDeps,
  repoDir: string,
  runId: string,
  events: EventLog,
  plan: Plan,
  exclusivePaths: string[],
  wait: boolean,
): Promise<boolean> {
  const paths = planPaths(plan);
  const exclusive = touchesExclusive(paths, exclusivePaths);
  const raw = await repoLockId(repoDir);
  const key = lockRepoKey(raw);
  const poll = deps.lockPollMs ?? 15_000;
  const yieldSlot = async (reason: string, overlap: string[]): Promise<boolean> => {
    if (!wait) {
      f.release?.();
      f.release = undefined;
      f.set({ result: "locked", reason });
      return false;
    }
    f.release?.();
    f.release = undefined;
    events.emit({ step: "intake", event: "queued", data: { repo: key, overlap, waiter_pid: process.pid } });
    await realSleep(poll, deps.signal);
    const again = await takeRepoLock(deps, repoDir, runId, events, true, f.maxRuns);
    if (!again.release) {
      f.set({ result: "locked", reason: again.reason || reason });
      return false;
    }
    f.release = again.release;
    f.lockSlot = again.release.slot;
    return true;
  };
  for (;;) {
    const slot = f.release?.slot;
    if (slot === undefined) return false;
    const decision = decidePathClaim(deps.factoryHome, raw, slot, runId, { paths, exclusive });
    if (!decision.ok) {
      if (decision.kind === "busy") {
        await realSleep(poll, deps.signal);
        continue;
      }
      const reason = `planned paths overlap active runs: ${decision.conflicts.join("; ")}`;
      if (!(await yieldSlot(reason, decision.conflicts))) return false;
      continue;
    }
    return true;
  }
}

/** So a finalize path-claim wait can drop the slot and take one again, same as intake. */
function bindLockWait(f: RunFrame, ctx: RunContext): void {
  ctx.releaseLock = () => {
    f.release?.();
    f.release = undefined;
  };
  ctx.reacquireLock = async () => {
    // Non-waiting attempts only. `takeRepoLock(..., true)` waits in `waitForRepoLock` with no deadline,
    // so a full slot set would outrun max_wall_minutes until some other run released.
    const poll = ctx.deps.lockPollMs ?? 15_000;
    for (;;) {
      checkDeadline(ctx);
      const again = await takeRepoLock(ctx.deps, ctx.repoDir, ctx.runId, ctx.events, false, f.maxRuns);
      if (again.release) {
        f.release = again.release;
        f.lockSlot = again.release.slot;
        ctx.lockSlot = again.release.slot;
        return again.release.slot;
      }
      const left = ctx.deadline.at - Date.now();
      if (left <= 0) checkDeadline(ctx);
      await realSleep(Math.min(poll, left), ctx.deps.signal);
    }
  };
}

interface Outcome {
  result: RunResultKind;
  reason: string;
  /**
   * Machine-readable stop cause and permitted recovery action (issue #179). Set wherever the stop
   * site knows its real cause. Never carries merge permission: risk, protected paths, pause, issue
   * revision, model-family separation, reviewed SHA and required checks stay authoritative.
   */
  stop?: RunStop;
  /**
   * Epoch ms when the provider usage window resets. Set only with a `provider_window_wait` stop (#177);
   * the queue parks the entry until then without holding a coding slot.
   */
  window_resets_at?: number;
  /** `window_resets_at` is an assumed time, not one the provider reported. */
  window_estimated?: boolean;
  type: RunResult["type"];
  risk: RunResult["risk"];
  /** `riskClass` reasons. Absent until finalize classifies the diff. */
  risk_reasons?: string[];
  merge_policy: RunResult["merge_policy"];
  pr: string | null;
  rounds: number;
  questions?: string[];
  /** Whether the questions reached the issue (comment and labels). Set only when a post was attempted. */
  questions_posted?: boolean;
  /** Whether a failed run's comment, label swap and PR close reached the issue. Set only when a report was attempted. */
  failure_reported?: boolean;
  /** The plan's stated assumptions. */
  assumptions?: string[];
  skipped_gates?: string[];
  branch: string | null;
  worktree: string | null;
}

/** Shared frame of `run` and `resume`: error → result kind, result.json + state.json, lock release. */
class RunFrame {
  out: Outcome = { result: "failed", reason: "", type: null, risk: null, merge_policy: null, pr: null, rounds: 0, branch: null, worktree: null };
  state?: RunState;
  release?: LockRelease;
  /** Slot taken with the repo lock; port allocation prefers this slot. */
  lockSlot = 0;
  /** `concurrency.max_runs` from the checkout, used when a path conflict re-acquires. */
  maxRuns = 1;
  /** Set once the repo lock is held: findings memory to flush at the end. */
  memory?: { factoryHome: string; repoId: string };
  /** For the run-end notification. */
  deps?: RunDeps;
  /** Repo config the attempt was judged with. Provenance fingerprints this, not a secret value. */
  provenanceRepo?: RepoConfig;
  /** Base commit once intake resolved it, including when the run stops before `state.base_sha` is kept. */
  baseSha?: string;

  constructor(
    readonly runId: string,
    readonly runDir: string,
    readonly repoDir: string,
    readonly events: EventLog,
    readonly startedAt: number,
    readonly now: Clock,
    public taskRef: string,
  ) {}

  set(o: Partial<Outcome>): void {
    this.out = { ...this.out, ...o };
  }

  save(): void {
    if (this.state) saveState(this, this.state);
  }

  /** Run-end cleanup (services), before result.json. */
  readonly cleanups: (() => Promise<void>)[] = [];

  async execute(body: () => Promise<void>): Promise<RunResult> {
    try {
      await body();
    } catch (e) {
      const reason = (e as Error).message;
      if (e instanceof Interrupted) {
        // A reboot or Ctrl-C is not the change's fault: the same bounded retry as a provider drop.
        // Resume discards the uncommitted leftovers of the interrupted step.
        if (this.state) this.state.transient = true;
        this.set({ result: "needs_human", reason: `${reason}; factory resume ${this.runId}`, stop: stopFor("transient_retry") });
      } else if (e instanceof TransientAgentError) {
        // Provider timeout/drop/capacity, retries used up: the run is fine, the provider was not. Resumable;
        // the uncommitted leftovers are the agent's (not a human fix), so resume discards them.
        if (this.state) this.state.transient = true;
        // Capacity, network and stream drops are the same bounded retry. A usage-window reset is
        // `provider_window_wait` (the branch below) and is not inferred from 429.
        // The run, checkpoint and spent budgets stay.
        this.set({ result: "needs_human", reason: `${reason}; factory resume ${this.runId}`, stop: stopFor("transient_retry") });
      } else if (e instanceof ProviderWindowError) {
        // Every usable model hit a usage limit with a resetting window, reported or assumed (#177). The reset time is
        // result metadata, not reason text: the queue waits for that window without a coding slot. The run,
        // checkpoint and spent budgets stay; generic 429/capacity stays on the transient_retry path above.
        if (this.state) this.state.transient = true;
        this.set({ result: "needs_human", reason: `${reason}; factory resume ${this.runId}`, stop: stopFor("provider_window_wait"), window_resets_at: e.resetsAtMs, ...(e.estimated ? { window_estimated: true } : {}) });
      } else if (e instanceof EnvMissing) {
        this.set({ result: "needs_human", reason, stop: stopFor("human_approval") });
      } else {
        // Wall time spent, or a silent agent / invalid output the resolver could not take (no time left
        // or no turn left), or any other error: the run fails and says why on the issue. What the
        // aborted step left uncommitted is not a human fix: a manual resume discards it.
        if (this.state) this.state.transient = true;
        this.set({ result: "failed", reason, stop: undefined });
      }
    }
    for (const cleanup of this.cleanups.splice(0)) await cleanup().catch(() => undefined);
    await this.postQuestions();
    await this.reportFailure();
    // Service logs and browser captures are written by child processes: redact them in place.
    if (this.events.secrets.length) redactTree(this.runDir, (t) => this.events.redact(t), ["worktree", "home", "plan-base", "eval-base"]);
    let result: RunResult;
    try {
      result = await this.finish();
    } finally {
      this.release?.();
    }
    // After the lock is released: the woken bot may start the next run right away.
    if (this.deps) await notifyFinished(result, this.deps, this.events);
    return result;
  }

  /**
   * Questions belong on the issue, not only in result.json; queue runs have no notify hook. A GitHub
   * failure is recorded (`questions_posted: false`) and never changes the result; the queue worker
   * retries. A `--no-pr` run writes nothing to GitHub.
   */
  private async postQuestions(): Promise<void> {
    const issue = this.state?.task.issue;
    const questions = this.out.questions;
    if (this.out.result !== "needs_input" || !questions?.length || issue === undefined || !this.deps || this.state?.no_pr) return;
    try {
      await postQuestionsOnIssue(this.deps.github, this.repoDir, issue, this.runId, questions, (t) => this.events.redact(t));
      this.out.questions_posted = true;
      this.events.emit({ step: "run", event: "progress", data: { questions_posted: true, issue } });
    } catch (e) {
      this.out.questions_posted = false;
      this.events.emit({ step: "run", event: "progress", data: { questions_posted: false, issue, error: (e as Error).message.slice(0, 300) } });
    }
  }

  /**
   * A failed run says why on its issue and closes its own PR, so the ticket waits for nobody (the queue
   * worker does the same for every stop it fails, and retries after a GitHub error). A `--no-pr` run
   * writes nothing to GitHub.
   */
  private async reportFailure(): Promise<void> {
    const st = this.state;
    const issue = st?.task.issue;
    if (issue === undefined || !this.deps || st?.no_pr) return;
    const paused = pauseRequested(this.deps.factoryHome, { runId: this.runId }) !== undefined;
    if (!isFailedExit({ result: this.out.result, stop: this.out.stop, questions: this.out.questions }, { paused })) return;
    try {
      await reportFailure(this.deps.github, this.repoDir, issue, this.runId, this.out.reason, this.out.pr ?? st?.pr ?? null, (t) => this.events.redact(t));
      this.out.failure_reported = true;
      this.events.emit({ step: "run", event: "progress", data: { failure_reported: true, issue } });
    } catch (e) {
      this.out.failure_reported = false;
      this.events.emit({ step: "run", event: "progress", data: { failure_reported: false, issue, error: (e as Error).message.slice(0, 300) } });
    }
  }

  private flushMemory(): void {
    if (!this.memory || !this.state) return;
    try {
      const obs = observations(this.state.findings, flakyChecks(this.runDir));
      if (obs.length) flushMemory({ ...this.memory, runId: this.runId, now: new Date(this.now()), observations: obs });
      this.events.emit({ step: "run", event: "progress", data: { memory: { repo: this.memory.repoId, observations: obs.length } } });
    } catch (e) {
      this.events.emit({ step: "run", event: "progress", data: { memory_error: (e as Error).message } });
    }
  }

  private async finish(): Promise<RunResult> {
    const { out } = this;
    const known = this.state;
    const outcome = known
      ? buildOutcome({
          ticket: known.task.issue ?? null,
          attempts: typeof known.attempts === "number" ? known.attempts : null,
          pr: out.pr,
          result: out.result,
        })
      : undefined;
    let head: string | null = null;
    const worktree = out.worktree ?? known?.worktree ?? null;
    if (worktree && existsSync(worktree)) head = await headSha(worktree).catch(() => null);
    const provenance = buildProvenance({
      model: implementModel(join(this.runDir, "events.jsonl")),
      effort: known?.plan_effort ?? "unknown",
      repo: this.provenanceRepo ?? { source: "unavailable" },
      secrets: this.events.secrets,
      base: known?.base_sha ?? this.baseSha ?? null,
      head,
      checks: this.provenanceRepo?.checks ?? [],
    });
    const result: RunResult = {
      run_id: this.runId,
      repo: this.repoDir,
      task: this.taskRef,
      type: out.type,
      lane: "standard",
      result: out.result,
      risk: out.risk,
      risk_reasons: out.risk_reasons ?? [],
      merge_policy: out.merge_policy,
      pr: out.pr,
      rounds: out.rounds,
      minutes: Math.round(((this.now() - this.startedAt) / 60_000) * 10) / 10,
      cost_usd: Math.round(this.events.totals.cost_usd * 10_000) / 10_000,
      reason: out.reason,
      ...(out.stop ? { stop: out.stop } : {}),
      ...(out.window_resets_at !== undefined ? { window_resets_at: out.window_resets_at } : {}),
      ...(out.window_estimated ? { window_estimated: true } : {}),
      ...(outcome ? { outcome } : {}),
      provenance,
      ...(this.events.diffCount ?? {}),
      ...(out.questions ? { questions: out.questions } : {}),
      ...(out.questions_posted !== undefined ? { questions_posted: out.questions_posted } : {}),
      ...(out.failure_reported !== undefined ? { failure_reported: out.failure_reported } : {}),
      ...(out.assumptions?.length ? { assumptions: out.assumptions } : {}),
      ...(out.skipped_gates?.length ? { skipped_gates: out.skipped_gates } : {}),
      branch: out.branch,
      worktree: out.worktree,
      run_dir: this.runDir,
    };
    this.flushMemory();
    this.events.emit({ step: "run", event: "run_finished", data: { result: result.result, reason: result.reason } });
    if (this.state) {
      this.state.result = result.result;
      this.state.reason = result.reason;
      // One attempt's cause describes only that attempt: a finished or unclassified end clears it.
      if (out.stop) this.state.stop = out.stop;
      else delete this.state.stop;
      this.save();
    }
    return writeResult(join(this.runDir, "result.json"), result, this.events.secrets);
  }
}

/**
 * The run's `max_wall_minutes` budget (active time: box suspends are credited back), ticking from
 * now until the run ends. Each suspend it credits is logged as `wall_suspended_ms`.
 */
function wallBudget(f: RunFrame, events: EventLog, repo: RepoConfig): WallBudget {
  const budget = new WallBudget(repo.limits.max_wall_minutes * 60_000, {
    onSuspend: (ms) => void events.emit({ step: "run", event: "progress", data: { wall_suspended_ms: ms } }),
  }).start();
  f.cleanups.push(async () => budget.stop());
  return budget;
}

/** Run-end webhook to the repo's bot (notify.yaml). Never throws, never changes the result. */
async function notifyFinished(result: RunResult, deps: RunDeps, events: EventLog): Promise<void> {
  try {
    await notifyRunFinished(result, { factoryHome: deps.factoryHome, fetch: deps.notifyFetch, sleep: deps.sleep, backoffMs: deps.notifyBackoffMs, signal: deps.signal, disabled: deps.noNotify, notifyTarget: deps.notifyTarget }, events);
  } catch {
    // notifyRunFinished does not throw; this guards the run result against any surprise
  }
}

/**
 * CI status of the base commit; while `pending`, polls until it settles or `base_ci_wait_minutes` pass.
 * Returns the final status and how long it waited.
 */
async function settledBaseStatus(f: RunFrame, deps: RunDeps, repoDir: string, baseSha: string, waitMinutes: number): Promise<{ status: BaseStatus; waitedMs: number }> {
  return pollCommitCi({
    github: deps.github,
    repoDir,
    sha: baseSha,
    waitMinutes,
    pollMs: deps.baseCiPollMs ?? 30_000,
    sleep: deps.sleep,
    signal: deps.signal,
    onUpdate: (info) =>
      f.events.emit({
        step: "intake",
        event: "progress",
        data: {
          base_ci:
            info.phase === "waiting"
              ? { status: info.status, sha: baseSha, waiting_up_to_minutes: waitMinutes }
              : { status: info.status, sha: baseSha, waited_ms: info.waitedMs },
        },
      }),
  });
}

/**
 * repo.yaml `secrets:` for this run: values are added to the redaction list before anything can
 * print them. Undefined (and the run set to needs_human) when a name does not resolve.
 */
async function openSecrets(f: RunFrame, repo: RepoConfig, repoDir: string, deps: RunDeps, step: string): Promise<ResolvedSecrets | undefined> {
  if (!repo.secrets) return { env: {}, missing: [], redact: [], short: [], files: [], names: [] };
  let s: ResolvedSecrets;
  try {
    s = await resolveSecrets(repo.secrets, { repoDir, factoryHome: deps.factoryHome, parentEnv: deps.parentEnv });
  } catch (e) {
    if (!(e instanceof SecretsError)) throw e;
    f.set({ result: "needs_human", reason: `secrets: ${e.message}`, stop: stopFor("human_approval") });
    return undefined;
  }
  f.events.addSecrets(s.redact);
  f.events.emit({ step, event: "progress", data: { secrets: { provider: repo.secrets.provider, resolved: Object.keys(s.env).length, missing: s.missing } } });
  if (s.missing.length) {
    f.set({ result: "needs_human", reason: `secrets not resolved: ${s.missing.join(", ")} (see factory doctor --repo)`, stop: stopFor("human_approval") });
    return undefined;
  }
  return s;
}

/** `factory run`: intake → plan → implement → review loop → finalize. Always writes `result.json`. */
export async function runFactory(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  if (opts.notifyTarget) deps = { ...deps, notifyTarget: opts.notifyTarget };
  await flushNotifyOutbox(deps.factoryHome, { factoryHome: deps.factoryHome, fetch: deps.notifyFetch, sleep: deps.sleep, backoffMs: deps.notifyBackoffMs, signal: deps.signal }, START_FLUSH).catch(() => undefined);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const runId = opts.runId ?? newRunId(startedAt);
  if (!runStartedAt(runId)) throw new Error(`invalid run id ${runId}`);
  const runDir = join(deps.factoryHome, "runs", runId);
  if (existsSync(runDir)) throw new Error(`run ${runId} already exists`);
  mkdirSync(runDir, { recursive: true });
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  if (deps.sandbox) events.emit({ step: "intake", event: "sandbox", data: { ...deps.sandbox } });
  const repoDir = resolve(opts.repo);
  const ref = opts.issue !== undefined ? `#${opts.issue}` : (opts.planFile ?? opts.textFile ?? "");
  const f = new RunFrame(runId, runDir, repoDir, events, startedAt, now, ref);
  f.deps = deps;

  return f.execute(async () => {
    events.emit({ step: "intake", event: "step_started" });
    const checkout: RepoConfig = loadRepoConfig(repoDir);
    const task: Task = await readTask(opts, repoDir, deps.github);
    f.taskRef = task.ref;
    // Persist the starter's target before the lock, so a locked run still records who to wake.
    const st = (f.state = newState({ runId, repo: repoDir, task, noPr: opts.noPr ?? false, wait: opts.wait ?? false, notifyTarget: opts.notifyTarget }));
    st.plan_effort = resolvePlanEffort(opts.planEffort, task.labels);
    f.save();
    const lock = await takeRepoLock(deps, repoDir, runId, events, opts.wait ?? false, checkout.concurrency.max_runs);
    if (!lock.release) return f.set({ result: "locked", reason: lock.reason });
    f.release = lock.release;
    f.lockSlot = lock.release.slot;
    f.maxRuns = checkout.concurrency.max_runs;
    // The base is fixed before planning: planner and plan_normalize read a clean detached worktree at
    // it, never the user's checkout (untracked files such as `.env` stay out of agent reach).
    const baseSha = await revParse(repoDir, await baseRef(repoDir, checkout.base_branch));
    f.baseSha = baseSha;
    // Checks, policies and secrets come from the base commit: a change to repo.yaml on the branch
    // (a protected change) takes effect only after a human merged it.
    const repo = await baseRepoConfig(repoDir, baseSha, checkout, events, "intake");
    f.provenanceRepo = repo;
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, repoDir, deps, "intake");
    if (!secrets) return;

    const agentHome = prepareAgentHome(runDir);
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, repoDir);
    const budget = budgetFrom(st.repair);
    const base = {
      deps, runId, runDir, repoDir, repo, events, agentHome, task, deadline, briefing: memoryBriefing, secrets, budget,
      persist: () => {
        st.repair = budgetTo(budget);
        f.save();
      },
    };

    const planned: PlanOutcome = await withBaseWorktree(repoDir, baseSha, join(runDir, "plan-base"), async (planDir) => {
      const pctx = { ...base, repoDir: planDir };
      return obtainPlan(pctx, resolvePlanEffort(opts.planEffort, task.labels));
    });
    if (planned.kind === "needs_input") return f.set({ result: "needs_input", reason: "plan needs input", questions: planned.questions, stop: stopFor("explicit_decision") });
    if (planned.kind === "failed") return f.set({ result: "failed", reason: planned.reason });
    const plan = planned.plan;
    f.set({ type: plan.type, ...(plan.assumptions?.length ? { assumptions: plan.assumptions } : {}) });
    writeJson(base, "plan.json", plan);
    events.emit({ step: "intake", event: "step_finished", data: { plan_source: planned.source, packages: plan.packages.length } });
    f.save();
    if (!(await ensurePathClaim(f, deps, repoDir, runId, events, plan, checkout.concurrency.exclusive_paths, opts.wait ?? false))) return;

    // Base check, then the worktree.
    checkDeadline(base);
    const suspendedBefore = deadline.suspendedMs;
    const { status, waitedMs } = await settledBaseStatus(f, deps, repoDir, baseSha, repo.limits.base_ci_wait_minutes);
    // Waiting for the base CI is not work: it does not count against max_wall_minutes (a suspend
    // during the wait is already credited by the budget, so it is not added twice).
    deadline.extend(waitedMs - (deadline.suspendedMs - suspendedBefore));
    if (status === "red" || status === "pending") {
      // Remember the commit so a later gc can resume this same run once CI is green.
      st.base_sha = baseSha;
      st.base_ci = status === "red" ? "red" : "pending";
      const why = status === "pending" ? `still pending after ${repo.limits.base_ci_wait_minutes} min` : "red";
      return f.set({ result: "base_red", reason: `CI on ${repo.base_branch} (${baseSha.slice(0, 8)}) is ${why}, not green` });
    }
    await beginWork(f, base, plan, baseSha, status, { noPr: opts.noPr ?? false, startedAt });
  });
}

/** Worktree, setup and the rest of the pipeline, once the base commit is not a red/pending CI stop. */
async function beginWork(
  f: RunFrame,
  base: {
    deps: RunDeps;
    runId: string;
    runDir: string;
    repoDir: string;
    repo: RepoConfig;
    events: EventLog;
    agentHome: string;
    task: Task;
    deadline: WallBudget;
    briefing: string;
    secrets: ResolvedSecrets;
    budget: ReturnType<typeof budgetFrom>;
    persist: () => void;
  },
  plan: Plan,
  baseSha: string,
  ciStatus: BaseStatus,
  opts: { noPr: boolean; startedAt: number },
): Promise<void> {
  const { deps, events, repo, deadline, repoDir, runDir, runId, task } = base;
  const st = f.state!;
  const stem = `factory/${task.issue ?? "task"}-${slug(plan.goal)}`;
  const slot = f.lockSlot;
  let branch = f.maxRuns > 1 ? `${stem}-${runId.slice(-6)}-s${slot}` : stem;
  const taken = (b: string) =>
    gitOk(repoDir, ["rev-parse", "--verify", `refs/heads/${b}`]).then(async (local) => local || remoteBranchExists(repoDir, b));
  if (await taken(branch)) branch = f.maxRuns > 1 ? `${stem}-${runId}-s${slot}` : `${branch}-${runId.slice(-6)}`;
  // Absolute: a relative path is resolved against the repo by `git worktree add`, not against this process.
  const worktree = resolve(join(runDir, "worktree"));
  const add = (b: string) => withRepoGitOps(repoDir, () => git(repoDir, ["worktree", "add", "-q", "-b", b, worktree, baseSha]));
  try {
    await add(branch);
  } catch (e) {
    if (f.maxRuns <= 1) throw e;
    branch = `${stem}-${runId}-s${slot}`;
    await add(branch);
  }
  f.set({ branch, worktree });
  Object.assign(st, { branch, worktree, base_sha: baseSha, step: "implement", base_ci: undefined });
  f.save();
  const ctx: RunContext = { ...base, worktree, branch, baseSha, plan, handoffs: [], gateCount: 0, deadline, lockSlot: f.lockSlot, maxRuns: f.maxRuns, wait: f.state?.wait ?? false };
  bindLockWait(f, ctx);
  const services = (ctx.services = runServices(ctx));
  f.cleanups.push(() => services.stopAll());
  const env = agentEnv(ctx);

  if (repo.setup) {
    const setup = await sh(repo.setup, { cwd: worktree, env, timeoutMs: Math.max(1000, deadline.at - Date.now()), jail: jailFor(ctx, worktree) });
    checkDeadline(ctx);
    if (setup.code !== 0) return f.set({ result: "needs_human", reason: `setup failed (env_missing?): ${tail(setup.output, 5)}`, stop: stopFor("unknown") });
  }
  // No GitHub CI on the base: the fast checks run here once per base commit; the outcome is shared
  // with later runs and with the queue worker, which holds starts while it is red.
  const baseKey = ciStatus === "none" ? lockRepoKey(await repoLockId(repoDir)) : "";
  const recorded = baseKey ? readBaseCheck(deps.factoryHome, baseKey) : undefined;
  if (recorded?.status === "green" && recorded.sha === baseSha) {
    events.emit({ step: "intake", event: "progress", data: { base_check: { status: "green", sha: baseSha, recorded_at: recorded.at } } });
  } else if (ciStatus === "none") {
    const fast = repo.checks.filter((c) => c.tier === "fast");
    const results = await runChecks(fast, {
      cwd: worktree,
      env: commandEnv(ctx),
      envCommand: repo.env_command,
      gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
      deadline,
      jail: jailFor(ctx, worktree),
      services,
      onCheck: (e) => events.emit({ step: "intake", event: e.event, data: { check: e.check, phase: "running", base: true } }),
    });
    throwIfInterrupted(deps);
    for (const r of results) events.emit({ step: "intake", event: "gate_result", data: { base: true, check: r.name, status: r.status } });
    const stop = baseCheckOutcome(results);
    if (!stop || stop.result === "base_red") {
      const failed = results.filter((r) => r.status === "fail").map((r) => r.name);
      writeBaseCheck(deps.factoryHome, baseKey, { sha: baseSha, status: stop ? "red" : "green", failed: stop ? failed : [], at: new Date(f.now()).toISOString() });
    }
    // A local base_red starts over on its next try: drop the worktree (and its setup output) once services stop.
    if (stop?.result === "base_red") {
      f.cleanups.push(async () => {
        await removeRunWorktree(repoDir, worktree);
        await withRepoGitOps(repoDir, () => git(repoDir, ["branch", "-D", branch])).catch(() => undefined);
      });
    }
    if (stop) return f.set(stop.result === "needs_human" ? { result: stop.result, reason: stop.reason, stop: stopFor("unknown") } : stop);
  }
  await drive(f, ctx, { noPr: opts.noPr, startedAt: opts.startedAt });
}

/** A stopped GitHub-CI `base_red` that gc / `factory run` may continue. */
export function isBaseRedWaiting(st: { result: string | null; base_ci?: string; base_sha?: string | null; gc_at?: string; worktree?: string | null } | undefined): boolean {
  return !!st && st.result === "base_red" && !!st.base_ci && !!st.base_sha && !st.gc_at && !st.worktree;
}

const HOUR_MS = 3_600_000;

/**
 * Continues a GitHub-CI `base_red` run once that base commit is green (or has no checks).
 * Outside `limits.base_red_resume_hours` (or while CI is still red/pending) the run is left as it is.
 * Returns undefined when nothing was resumed, so a sweep can try again later.
 */
export async function continueBaseRed(runId: string, deps: RunDeps): Promise<RunResult | undefined> {
  const runDir = join(deps.factoryHome, "runs", runId);
  let st: RunState;
  try {
    st = readState(runDir);
  } catch {
    return undefined;
  }
  if (!isBaseRedWaiting(st) || !st.base_sha || !existsSync(st.repo) || !existsSync(join(runDir, "plan.json"))) return undefined;
  let checkout: RepoConfig;
  try {
    checkout = loadRepoConfig(st.repo);
  } catch {
    return undefined;
  }
  const hours = checkout.limits.base_red_resume_hours;
  if (hours <= 0) return undefined;
  const now = deps.now ?? Date.now;
  const updated = Date.parse(st.updated_at);
  if (!Number.isFinite(updated) || now() - updated > hours * HOUR_MS) return undefined;
  let ci: BaseStatus;
  try {
    ci = await deps.github.baseStatus(st.repo, st.base_sha);
  } catch {
    return undefined;
  }
  if (ci === "red" || ci === "pending") return undefined;

  const startedAt = now();
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  const f = new RunFrame(runId, runDir, st.repo, events, startedAt, now, st.task.ref);
  const lock = await takeRepoLock(deps, st.repo, runId, events, false, checkout.concurrency.max_runs);
  if (!lock.release) {
    events.emit({ step: "resume", event: "progress", data: { base_red_resume: "locked" } });
    return undefined;
  }
  f.release = lock.release;
  f.lockSlot = lock.release.slot;
  f.maxRuns = checkout.concurrency.max_runs;
  f.deps = deps;
  let plan: Plan;
  try {
    plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
  } catch (e) {
    f.release();
    f.release = undefined;
    throw e;
  }
  try {
    if (!(await ensurePathClaim(f, deps, st.repo, runId, events, plan, checkout.concurrency.exclusive_paths, false))) return undefined;
  } catch (e) {
    f.release?.();
    f.release = undefined;
    throw e;
  }
  rmSync(join(runDir, "result.json"), { force: true });
  st.result = null;
  st.reason = "";
  st.base_ci = undefined;
  f.state = st;
  f.save();

  return f.execute(async () => {
    events.emit({ step: "resume", event: "step_started", data: { base_red_resume: true, base_sha: st.base_sha, ci } });
    const checkout = loadRepoConfig(st.repo);
    const repo = await baseRepoConfig(st.repo, st.base_sha!, checkout, events, "resume");
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    f.deps = deps;
    const secrets = await openSecrets(f, repo, st.repo, deps, "resume");
    if (!secrets) return;
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
    f.set({ type: plan.type, ...(plan.assumptions?.length ? { assumptions: plan.assumptions } : {}) });
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, st.repo);
    const budget = budgetFrom(st.repair);
    const base = {
      deps, runId, runDir, repoDir: st.repo, repo, events, agentHome: prepareAgentHome(runDir), task: st.task, deadline, briefing: memoryBriefing, secrets, budget,
      persist: () => {
        st.repair = budgetTo(budget);
        f.save();
      },
    };
    await beginWork(f, base, plan, st.base_sha!, ci, { noPr: st.no_pr, startedAt });
  });
}

/** Resumes every eligible `base_red` run. One failure does not stop the others. */
export async function sweepBaseRed(deps: RunDeps, log?: (s: string) => void): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const run of listRuns(deps.factoryHome)) {
    if (!isBaseRedWaiting(run.state)) continue;
    try {
      const result = await continueBaseRed(run.run_id, deps);
      if (!result) continue;
      log?.(`factory: resumed ${run.run_id} after base CI turned green → ${result.result}\n`);
      out.push(result);
    } catch (e) {
      log?.(`factory: base_red resume of ${run.run_id} failed: ${(e as Error).message.slice(0, 200)}\n`);
    }
  }
  return out;
}

/**
 * A queue pause marker stops before the next product edit: the worktree and plan stay, the PR is put
 * back to draft, and auto-merge is not reached. The process is not signalled. The marker stays until
 * a human clears it.
 */
async function stopIfPaused(f: RunFrame): Promise<boolean> {
  if (!f.deps) return false;
  const why = pauseRequested(f.deps.factoryHome, { runId: f.runId });
  if (!why) return false;
  const draftError = await keepDraft(f);
  const reason = `paused: ${why}; resume with \`factory resume ${f.runId}\``;
  // A pause is an operator order: only clearing it (a human action) may resume this run.
  f.set({ result: "needs_human", reason: draftError ? `${reason}; ${draftError}` : reason, stop: stopFor("human_approval") });
  return true;
}

/**
 * implement → review loop → finalize, starting at `state.step`, persisting state.json after every
 * package, round and step. Shared by run and resume. Returns the technical stop for the resolver, or
 * nothing when the run's result is set (done, or a stop that is not technical: pause, outage, lock).
 */
async function advance(f: RunFrame, ctx: RunContext, opts: { noPr: boolean; startedAt: number; gates?: GateReport }): Promise<ResolverStop | undefined> {
  const st = f.state!;
  if (await stopIfPaused(f)) return;
  const sync = () => {
    st.lane = "standard";
    delete st.lane_escalation;
    st.handoffs = ctx.handoffs;
    st.gate_count = ctx.gateCount;
    st.base_sha = ctx.baseSha;
    f.save();
  };
  let gates = opts.gates;
  let loop: LoopOutcome | undefined;

  if (st.step === "implement") {
    const done = Object.keys(st.packages).filter((id) => st.packages[id] === "done");
    const impl = await implementPackages(ctx, {
      done,
      onPackage: (id, status, failure) => {
        st.packages[id] = status;
        if (failure) st.failures[id] = failure;
        else delete st.failures[id];
        sync();
      },
    });
    st.packages = Object.fromEntries(impl.status);
    st.failures = impl.failures;
    sync();
    gates = impl.lastGates ?? gates;
    const notDone = [...impl.status].filter(([, s]) => s !== "done");
    if (notDone.length || !gates) {
      const failed = notDone.map(([id, s]) => `${id} ${s}${impl.failures[id] ? `: ${impl.failures[id]}` : ""}`);
      return { reason: `packages not done: ${failed.join("; ")}`, gates, packages: notDone.filter(([, s]) => s === "failed").map(([id]) => id) };
    }
    st.step = "review";
    sync();
  }
  if (st.step === "review") {
    if (await stopIfPaused(f)) return;
    loop = await reviewLoop(ctx, gates!, {
      firstRound: st.rounds + 1,
      findings: st.findings,
      reviewedSha: st.reviewed_sha,
      onRound: (round, findings, reviewedSha) => {
        st.rounds = round;
        st.findings = findings;
        if (reviewedSha) st.reviewed_sha = reviewedSha;
        sync();
      },
    });
    if (loop.result !== "done") return { reason: loop.reason, gates: loop.gates, findings: openFindings(loop.findings) };
    st.step = "finalize";
    sync();
  }
  loop ??= { result: "done", reason: "", rounds: st.rounds, findings: st.findings, gates, reviewedSha: st.reviewed_sha };

  if (await stopIfPaused(f)) return;
  const fin = await finalize(ctx, {
    ...loop,
    packages: new Map(Object.entries(st.packages)),
    failures: st.failures,
    noPr: opts.noPr,
    startedAt: opts.startedAt,
    existingPr: st.pr ? { url: st.pr, draft: st.pr_draft ?? true } : undefined,
    reviewedSha: loop.reviewedSha ?? st.reviewed_sha,
  });
  st.pr = fin.pr;
  st.pr_draft = fin.draft;
  if (fin.approvedSha) st.approved_sha = fin.approvedSha;
  else delete st.approved_sha;
  if (fin.reviewedSha) st.reviewed_sha = fin.reviewedSha;
  if (fin.ciWait) st.ci_wait = fin.ciWait;
  else delete st.ci_wait;
  delete st.continuation;
  if (st.step === "finalize" && fin.result === "done") st.step = "finished";
  sync();
  f.set({ result: fin.result, reason: fin.reason, stop: fin.cause && fin.result === "needs_human" ? stopFor(fin.cause) : undefined, risk: fin.risk.risk, risk_reasons: fin.risk.reasons, merge_policy: fin.mergePolicy, pr: fin.pr, rounds: st.rounds, ...(fin.skipped_gates?.length ? { skipped_gates: fin.skipped_gates } : {}) });
  const tech = fin.result === "needs_human" ? fin.technical : undefined;
  if (!tech) return;
  const stop: ResolverStop = { reason: fin.reason, gates: tech.gates, ...(tech.findings?.length ? { findings: tech.findings } : {}) };
  if (tech.ciSha) {
    const failures = await ctx.deps.github.headFailures(ctx.repoDir, tech.ciSha).catch(() => []);
    stop.ci = { sha: tech.ciSha, failures: failures.map((c) => ({ ...c, output_tail: ctx.events.redact(c.output_tail) })) };
  }
  if (tech.baseConflict) {
    const sha = await revParse(ctx.repoDir, await baseRef(ctx.repoDir, ctx.repo.base_branch));
    stop.merge = { sha, label: ctx.repo.base_branch, base: true };
  }
  return stop;
}

/** A silent agent or an invalid model output gets a resolver turn only while the wall budget has room for one. */
function wallAllowsResolver(ctx: RunContext): boolean {
  return ctx.deadline.at - Date.now() >= ctx.repo.limits.stall_minutes * 60_000;
}

/**
 * The run's pipeline with its resolver: every technical stop goes to a resolver turn instead of ending
 * the run, then the run continues where it stopped. At most {@link MAX_RESOLVER_TURNS} turns per run
 * (`state.resolver_turns`); after that, or when the resolver says the approach is wrong, the run fails.
 */
async function drive(f: RunFrame, ctx: RunContext, opts: { noPr: boolean; startedAt: number; gates?: GateReport; stop?: ResolverStop }): Promise<void> {
  let gates = opts.gates;
  let stop = opts.stop;
  for (;;) {
    if (!stop) {
      try {
        stop = await advance(f, ctx, { noPr: opts.noPr, startedAt: opts.startedAt, gates });
      } catch (e) {
        if (!(e instanceof WatchdogAbort || e instanceof InvalidOutputError) || !wallAllowsResolver(ctx)) throw e;
        stop = { reason: e.message };
      }
      if (!stop) return;
    }
    const resolved = await resolveStop(f, ctx, stop);
    if (!resolved) return;
    gates = resolved;
    stop = undefined;
  }
}

/** Resolver turns on one stop until one is green or the run's budget is spent. Undefined: the run failed. */
async function resolveStop(f: RunFrame, ctx: RunContext, stop: ResolverStop): Promise<GateReport | undefined> {
  const st = f.state!;
  let current = stop;
  let previous: string | undefined;
  for (;;) {
    const used = st.resolver_turns ?? 0;
    if (used >= MAX_RESOLVER_TURNS) return failRun(f, stop.reason, previous ?? `no resolver turn left (${used}/${MAX_RESOLVER_TURNS})`);
    st.resolver_turns = used + 1;
    f.save();
    const out = await resolverTurn(ctx, current, used + 1, previous);
    st.base_sha = ctx.baseSha;
    st.gate_count = ctx.gateCount;
    if (out.ok) {
      // The next review reads the resolver's account next to each finding it answered.
      const open = new Set((current.findings ?? []).map((f) => f.id));
      for (const finding of st.findings) {
        if (open.has(finding.id)) finding.response = { finding_id: finding.id, status: "fixed", response: `resolver: ${out.summary}`.slice(0, 2000) };
      }
      if (st.step === "implement") {
        // The resolver finished the failed packages; dependents that were skipped run next.
        for (const [id, status] of Object.entries(st.packages)) {
          if (status === "failed") st.packages[id] = "done";
          else if (status === "skipped") delete st.packages[id];
        }
        st.failures = {};
      } else if (st.step === "review" && st.reviewed_sha) {
        // Finalize reviews the resolver's commits as a delta; a fresh review loop would reset the round budget.
        st.step = "finalize";
      }
      f.save();
      return out.gates;
    }
    f.save();
    if (out.final) return failRun(f, stop.reason, out.reason);
    previous = out.reason;
    current = { ...current, ...(out.gates ? { gates: out.gates } : {}) };
  }
}

/** The run ends failed. Its PR is not left ready for review (the failure report closes it on an issue). */
async function failRun(f: RunFrame, stopReason: string, why: string): Promise<undefined> {
  f.events.emit({ step: "resolve", event: "progress", data: { failed: why.slice(0, 300) } });
  const draftError = await keepDraft(f);
  const reason = `${stopReason}; resolver: ${why}`;
  f.set({ result: "failed", reason: draftError ? `${reason}; ${draftError}` : reason, stop: undefined, pr: f.state?.pr ?? f.out.pr, rounds: f.state?.rounds ?? f.out.rounds });
  return undefined;
}

/**
 * A local stop must not leave the pull request ready for review. Closed PRs and `--no-pr` are left alone.
 * When conversion fails, the returned text is appended to the run reason.
 */
async function keepDraft(f: RunFrame): Promise<string | undefined> {
  const st = f.state;
  if (!st?.pr || st.no_pr || !st.worktree || !f.deps) return;
  try {
    const held = await ensurePrDraft(f.deps.github, st.worktree, { url: st.pr, draft: st.pr_draft ?? true });
    if (held.changed) {
      st.pr_draft = true;
      f.save();
      f.events.emit({ step: "resume", event: "progress", data: { pr_marked_draft: st.pr } });
    }
    return;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    f.events.emit({ step: "resume", event: "progress", data: { pr_draft_error: msg } });
    return `draft conversion failed: ${msg}`;
  }
}

/**
 * repo.yaml as committed at the base (`sha`), never the checkout or the run branch: the agent cannot
 * weaken the checks that judge its own change. Falls back to the checkout's file (with an event) only
 * when the base has none, e.g. a repo whose repo.yaml is not committed yet.
 */
export async function baseRepoConfig(repoDir: string, sha: string, checkout: RepoConfig, events: EventLog, step: string): Promise<RepoConfig> {
  const text = await git(repoDir, ["show", `${sha}:${REPO_CONFIG_PATH}`]).catch(() => undefined);
  if (text === undefined) {
    events.emit({ step, event: "progress", data: { repo_config: "not committed at base; using the checkout's file" } });
    return checkout;
  }
  const repo = parseRepoConfig(text);
  if (JSON.stringify(repo) !== JSON.stringify(checkout)) events.emit({ step, event: "progress", data: { repo_config: `checkout differs from base ${sha.slice(0, 8)}; using base` } });
  return repo;
}

/**
 * `factory resume <run-id>`: continue a stopped run (needs_human, failed, interrupted) after a human
 * fix. Re-validates first: commits the human's uncommitted changes, merges commits pushed to the PR
 * branch and the moved base (never a rebase or force-push), re-runs the gates (red → one fix
 * session), then continues from the saved step and updates the existing PR.
 */
export async function resumeFactory(runId: string, opts: ResumeOptions, deps: RunDeps): Promise<RunResult> {
  await flushNotifyOutbox(deps.factoryHome, { factoryHome: deps.factoryHome, fetch: deps.notifyFetch, sleep: deps.sleep, backoffMs: deps.notifyBackoffMs, signal: deps.signal }, START_FLUSH).catch(() => undefined);
  const runDir = join(deps.factoryHome, "runs", runId);
  const st = readState(runDir);
  // Persist an override before the lock check so a locked resume still wakes the named bot.
  if (opts.notifyTarget) {
    st.notify_target = opts.notifyTarget;
    st.updated_at = new Date().toISOString();
    writeFileSync(join(runDir, "state.json"), JSON.stringify(st, null, 2) + "\n");
    deps = { ...deps, notifyTarget: opts.notifyTarget };
  } else if (st.notify_target) {
    deps = { ...deps, notifyTarget: st.notify_target };
  }
  if (st.result === "abandoned") throw new Error(`run ${runId} was abandoned (${st.reason}); start a new run`);
  if (st.gc_at) throw new Error(`run ${runId} was cleaned up by factory gc at ${st.gc_at} (worktree removed); start a new run`);
  if (st.step === "intake" || !st.worktree || !st.branch || !st.base_sha) {
    throw new Error(`run ${runId} stopped before its worktree existed (${st.result ?? "running"}: ${st.reason}); start a new run`);
  }
  if (st.step === "finished" && !st.continuation) throw new Error(`run ${runId} is finished (${st.result}); nothing to resume`);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  if (deps.sandbox) events.emit({ step: "intake", event: "sandbox", data: { ...deps.sandbox } });
  const f = new RunFrame(runId, runDir, st.repo, events, startedAt, now, st.task.ref);
  f.deps = deps;
  f.set({ branch: st.branch, worktree: st.worktree, pr: st.pr, rounds: st.rounds });

  // Locked, or planned paths overlapping another run: report without touching this run's result.json.
  const checkout = loadRepoConfig(st.repo);
  const lock = await takeRepoLock(deps, st.repo, runId, events, opts.wait ?? false, checkout.concurrency.max_runs);
  if (!lock.release) {
    f.state = st;
    const draftError = await keepDraft(f);
    const locked: RunResult = {
      run_id: runId, repo: st.repo, task: st.task.ref, type: null, lane: "standard", result: draftError ? "needs_human" : "locked", risk: null, merge_policy: null,
      pr: st.pr, rounds: st.rounds, minutes: 0, cost_usd: 0, reason: draftError ? `${lock.reason}; ${draftError}` : lock.reason, branch: st.branch, worktree: st.worktree, run_dir: runDir,
    };
    await notifyFinished(locked, deps, events);
    return locked;
  }
  f.release = lock.release;
  f.lockSlot = lock.release.slot;
  f.maxRuns = checkout.concurrency.max_runs;
  let plan: Plan;
  try {
    plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
  } catch (e) {
    f.release();
    f.release = undefined;
    throw e;
  }
  try {
    if (!(await ensurePathClaim(f, deps, st.repo, runId, events, plan, checkout.concurrency.exclusive_paths, opts.wait ?? false))) {
      f.state = st;
      const draftError = await keepDraft(f);
      const queryFailed = f.out.result === "needs_human";
      const reason = draftError ? `${f.out.reason}; ${draftError}` : f.out.reason;
      const locked: RunResult = {
        run_id: runId, repo: st.repo, task: st.task.ref, type: plan.type, lane: "standard", result: queryFailed || draftError ? "needs_human" : "locked", risk: null, merge_policy: null,
        pr: st.pr, rounds: st.rounds, minutes: 0, cost_usd: 0, reason, branch: st.branch, worktree: st.worktree, run_dir: runDir,
      };
      await notifyFinished(locked, deps, events);
      return locked;
    }
  } catch (e) {
    f.release?.();
    f.release = undefined;
    throw e;
  }
  f.state = st;
  // This attempt now owns the outcome: the previous attempt's result.json (e.g. `failed`) must not be read
  // as current while it runs; finish() writes the new one (every exit path, errors included).
  const previous = st.result;
  rmSync(join(runDir, "result.json"), { force: true });
  const attempt = nextAttempt(st.attempts);
  if (attempt !== null) st.attempts = attempt;
  const recovery = writeRecoveryNote(
    runDir,
    { previous_result: previous, attempts: attempt, branch: st.branch, checkpoint: st.step },
    events.secrets,
  );
  events.emit({
    step: "resume",
    event: "progress",
    data: { recovery: { previous_result: recovery.previous_result, attempts: recovery.attempts, checkpoint: recovery.checkpoint, plan_kept: recovery.plan_kept } },
  });

  return f.execute(async () => {
    // Before continuation bookkeeping and post-CI fixStep. A queued resume must not edit product
    // while the pause marker exists; only a human clearing it may continue.
    if (await stopIfPaused(f)) return;
    events.emit({ step: "resume", event: "step_started", data: { from: st.step, previous_result: previous } });
    const continuation = st.continuation;
    if (continuation) {
      if ((st.continuation_attempts ?? 0) >= continuationLimit(st.continuation_extra)) {
        delete st.continuation;
        return f.set({ result: "needs_human", reason: `post-push repair exhausted (${st.continuation_attempts ?? 0}/${continuationLimit(st.continuation_extra)})`, stop: stopFor("budget_exhausted") });
      }
      st.continuation_attempts = (st.continuation_attempts ?? 0) + 1;
      if (st.continuation_attempts > continuationLimit(0)) st.continuation_extra = 0;
      delete st.continuation;
      if (st.step === "finished") st.step = "review";
      delete st.approved_sha;
      f.save();
      if (st.pr) await deps.github.disableAutoMerge(st.repo, st.pr);
      if (st.task.issue !== undefined) {
        const issue = await deps.github.getIssue(st.repo, st.task.issue);
        const block = admissionBlock(issue);
        if (block || st.task.text !== `# ${issue.title}\n\n${issue.body}`) {
          return f.set({ result: "needs_human", reason: `automatic continuation refused: ${block ?? "issue text changed"}`, stop: stopFor("explicit_decision") });
        }
      }
      // Automatic recovery must not turn another person's uncommitted work into a bot commit.
      if ((await git(st.worktree!, ["status", "--porcelain"])).trim()) {
        return f.set({ result: "needs_human", reason: "automatic continuation refused: worktree has uncommitted changes", stop: stopFor("explicit_decision") });
      }
    }
    const repo = st.base_sha ? await baseRepoConfig(st.repo, st.base_sha, loadRepoConfig(st.repo), events, "resume") : loadRepoConfig(st.repo);
    f.provenanceRepo = repo;
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, st.repo, deps, "resume");
    if (!secrets) return;
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
    f.set({ type: plan.type, ...(plan.assumptions?.length ? { assumptions: plan.assumptions } : {}) });
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, st.repo);
    const budget = budgetFrom(st.repair);
    const ctx: RunContext = {
      deps, runId, runDir, repoDir: st.repo, repo, events, agentHome: prepareAgentHome(runDir), task: st.task, briefing: memoryBriefing,
      worktree: st.worktree!, branch: st.branch!, baseSha: st.base_sha!, plan, handoffs: st.handoffs, gateCount: st.gate_count, deadline, secrets,
      lockSlot: f.lockSlot,
      maxRuns: f.maxRuns,
      wait: st.wait ?? false,
      budget,
      persist: () => {
        st.repair = budgetTo(budget);
        f.save();
      },
    };
    bindLockWait(f, ctx);
    const services = (ctx.services = runServices(ctx));
    f.cleanups.push(() => services.stopAll());
    if (st.step === "implement") {
      for (const id of Object.keys(st.packages)) if (st.packages[id] !== "done") delete st.packages[id];
      st.failures = {};
    }
    const ready = await prepareResume(ctx, st, previous);
    delete st.transient;
    // Human changes are committed now: the previous outcome no longer describes the run.
    st.result = null;
    st.reason = "";
    st.base_sha = ctx.baseSha;
    st.gate_count = ctx.gateCount;
    f.save();
    if (continuation && st.step === "finalize") st.step = "review";
    if (!ready.ok && !ready.stop) {
      const draftError = await keepDraft(f);
      return f.set({ result: "needs_human", reason: draftError ? `${ready.reason}; ${draftError}` : ready.reason, ...(ready.cause ? { stop: stopFor(ready.cause) } : {}) });
    }
    // A red CI continuation needs no step of its own: finalize polls the PR head again and hands red
    // checks to the resolver with their logs.
    let gates = ready.ok ? ready.gates : ready.stop?.gates;
    let stop = ready.ok ? undefined : ready.stop;
    if (!stop && gates && !gates.green) {
      const fixed = await fixStep(ctx, "resume", { open: [], gates }, { gateFailures: 0 });
      if (fixed.ok) gates = fixed.gates;
      else stop = { reason: `resume: ${fixed.reason}`, gates };
    }
    events.emit({ step: "resume", event: "step_finished", data: { continue_at: st.step } });
    await drive(f, ctx, { noPr: opts.noPr ?? st.no_pr, startedAt, gates, ...(stop ? { stop } : {}) });
  });
}

/** `stop`: a technical problem the resolver takes over before the run continues. */
type Ready = { ok: true; gates?: GateReport } | { ok: false; reason: string; cause: StopCause; stop?: ResolverStop };

/** Re-validation before a resumed run continues. */
async function prepareResume(ctx: RunContext, st: RunState, previous: RunState["result"]): Promise<Ready> {
  const { worktree: wt, branch } = ctx;
  // Without a diagnosis the re-validation stop fails closed: unknown, no automatic recovery.
  const fail = (reason: string, cause: StopCause = "unknown"): Ready => ({ ok: false, reason: `resume: ${reason}`, cause });
  if (!existsSync(wt)) return fail(`worktree ${wt} is missing`);
  const head = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== branch) return fail(`worktree is on ${head}, expected ${branch}`);
  if (ctx.task.issue !== undefined) {
    let issue: { body: string };
    try {
      issue = await ctx.deps.github.getIssue(ctx.repoDir, ctx.task.issue);
    } catch (e) {
      return fail(`issue #${ctx.task.issue} could not be read (${(e as Error).message.slice(0, 160)}); kept the checkpoint plan`);
    }
    const missing = missingPlanQuotes(issue.body, ctx.plan);
    if (missing.length) return fail(`issue #${ctx.task.issue} dropped a planned quote (${missing[0]!.slice(0, 80)}); kept the checkpoint plan, not a new one`, "explicit_decision");
  }
  const openPr = st.pr ? await ctx.deps.github.findOpenPr(ctx.worktree, branch) : null;
  const prProblem = openPrProblem(st.pr, openPr, branch);
  if (prProblem) return fail(prProblem);
  for (const [ref, what] of [["MERGE_HEAD", "merge"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"]] as const) {
    if (await gitOk(wt, ["rev-parse", "-q", "--verify", ref])) return fail(`a ${what} is in progress in the worktree; finish or abort it first`);
  }
  if ((previous === "needs_human" || previous === "failed") && !st.transient) {
    // The run stopped for a human: whatever is uncommitted now is their fix.
    if (await commitAll(wt, "fix: human changes before resume", gitAuthor(ctx))) {
      ctx.events.emit({ step: "resume", event: "progress", data: { human_changes_committed: await headSha(wt) } });
    }
  } else if ((await git(wt, ["status", "--porcelain"])).trim() !== "") {
    // Interrupted/crashed/transient provider error: uncommitted changes are unvalidated agent leftovers; the step re-runs anyway.
    await discardChanges(wt);
    ctx.events.emit({ step: "resume", event: "progress", data: { discarded_uncommitted: true } });
  }
  // Commits a human pushed to the PR branch (e.g. a conflict resolved on GitHub).
  // A fetch timeout must stop the resume: skipping the merge would keep yesterday's branch.
  if (await remoteBranchExists(ctx.repoDir, branch)) {
    const remote = `refs/remotes/origin/${branch}`;
    const fetched = await gitOk(wt, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`]).catch((e: unknown) => {
      if (isCommandTimeout(e)) throw new Error(`${(e as Error).message}; refusing to continue on a stale origin/${branch}`, { cause: e });
      throw e;
    });
    if (fetched && !(await isAncestor(wt, remote))) {
      const merged = await mergeRef(wt, remote, `chore: merge origin/${branch}`, gitAuthor(ctx));
      if (!merged.ok) {
        const reason = `commits on origin/${branch} conflict with the worktree in ${merged.conflicts.join(", ") || merged.error.slice(0, 200)}`;
        return { ...(fail(reason, stopCauseForMergeFailure(merged.conflicts)) as Ready & { ok: false }), stop: { reason: `resume: ${reason}`, merge: { sha: await revParse(wt, remote), label: `origin/${branch}`, base: false } } };
      }
      ctx.events.emit({ step: "resume", event: "progress", data: { remote_branch_merged: await headSha(wt) } });
    }
  }
  const synced = await syncBase(ctx, "resume");
  if (!synced.ok) {
    const cause = stopCauseForSyncFailure(synced.failure, synced.gates);
    // A clean merge whose gates are red gets the usual fix session first. A conflict, an ambiguous
    // merge failure and an inconclusive timeout go to the resolver; none widens merge permission.
    if (synced.failure === "gates" && cause === "technical_repair" && synced.gates) return { ok: true, gates: synced.gates };
    const merge = synced.failure === "conflict" ? { sha: await revParse(ctx.repoDir, await baseRef(ctx.repoDir, ctx.repo.base_branch)), label: ctx.repo.base_branch, base: true } : undefined;
    const reason = `resume: ${synced.reason}`;
    return { ok: false, reason, cause, stop: { reason, ...(synced.gates ? { gates: synced.gates } : {}), ...(merge ? { merge } : {}) } };
  }
  if (synced.gates) return { ok: true, gates: synced.gates };
  const done = st.step === "implement" ? Object.keys(st.packages).filter((id) => st.packages[id] === "done") : ctx.plan.packages.map((p) => p.id);
  if (done.length === 0) return { ok: true };
  return { ok: true, gates: await runGates(ctx, "fast", done) };
}
