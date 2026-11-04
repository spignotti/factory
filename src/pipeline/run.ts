import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BaseStatus } from "../gh.js";
import { prepareAgentHome } from "../agents/env.js";
import { realSleep } from "../agents/fake-runner.js";
import { InvalidOutputError, TransientAgentError } from "../agents/models.js";
import { type Clock, EventLog, type RunResult, type RunResultKind, secretValues, writeResult } from "../events.js";
import { sh, tail } from "../exec.js";
import { baseRef, commitAll, discardChanges, git, gitOk, headSha, isAncestor, mergeRef, withBaseWorktree, originUrl, remoteBranchExists, repoLockId, revParse } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { PlanSchema, type Plan } from "../schemas/plan.js";
import { loadRepoConfig, parseRepoConfig, REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import { withRepoModels } from "../config.js";
import { briefing, canonicalRepoId, flushMemory, loadMemory, observations } from "../memory.js";
import { finalize, syncBase } from "../steps/finalize.js";
import { type GateReport, runChecks, runGates } from "../steps/gates.js";
import { gitAuthor, implementPackages } from "../steps/implement.js";
import { obtainFastPlan, obtainPlan, type PlanEffort, type PlanOutcome, readTask, resolvePlanEffort, type TaskInput } from "../steps/intake.js";
import { planStep } from "../steps/plan.js";
import { fastLaneEscalation } from "./lane.js";
import { EnvMissing } from "../services.js";
import { redactTree, type ResolvedSecrets, resolveSecrets, SecretsError } from "../secrets.js";
import { WallBudget } from "./budget.js";
import { pollCommitCi } from "./ci-wait.js";
import { agentEnv, checkDeadline, commandEnv, jailFor, type Lane, runServices, type RunContext, type RunDeps, type Task, throwIfInterrupted, WallTimeExceeded, writeJson } from "./context.js";
import { acquireRepoLockWithRetry, decidePathClaim, lockRepoKey, repoLockHolder, waitForRepoLock, type LockRelease } from "./lock.js";
import { planPaths, touchesExclusive } from "./overlap.js";
import { fixStep, type LoopOutcome, reviewLoop } from "./loop.js";
import { newState, readState, type RunState, saveState } from "./state.js";
import { WatchdogAbort } from "./watchdog.js";
import { notifyRunFinished, flushNotifyOutbox, START_FLUSH } from "../notify.js";
import { listRuns } from "../runs.js";

export interface RunOptions extends TaskInput {
  repo: string;
  lane?: "standard" | "fast";
  planEffort?: PlanEffort;
  noPr?: boolean;
  /** Repo locked by another run: wait in a queue instead of returning `locked`. */
  wait?: boolean;
  /** Named notify.yaml target (`factory run --notify`). Stored on the run; the name only. */
  notifyTarget?: string;
}

export interface ResumeOptions {
  wait?: boolean;
  /** Overrides the original run's --no-pr. */
  noPr?: boolean;
  /** Overrides the stored notify target (`factory resume --notify`). Omitted: keep the stored name. */
  notifyTarget?: string;
}

function newRunId(now: number): string {
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

/** Fast lane → standard lane: logged, reported in result.json and the PR. */
function escalate(f: RunFrame, events: EventLog, step: string, reasons: string[]): void {
  f.lane = "standard";
  if (f.state) f.state.lane = "standard";
  events.emit({ step, event: "lane_escalated", data: { from: "fast", to: "standard", reasons } });
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
  const raw = await repoLockId(repoDir);
  const id = lockRepoKey(raw);
  const release = await acquireRepoLockWithRetry(deps.factoryHome, raw, runId, { maxRuns, signal: deps.signal });
  if (release) return { release, reason: "" };
  const holder = repoLockHolder(deps.factoryHome, raw);
  const by = holder ? `run ${holder.runId ?? "?"} (pid ${holder.pid})` : "another run";
  if (!wait) return { reason: `repo ${id} is locked by ${by}` };
  events.emit({ step: "intake", event: "queued", data: { repo: id, holder_run_id: holder?.runId ?? null, holder_pid: holder?.pid ?? null, waiter_pid: process.pid } });
  const queuedAt = Date.now();
  const got = await waitForRepoLock(deps.factoryHome, raw, runId, { pollMs: deps.lockPollMs ?? 15_000, signal: deps.signal, maxRuns });
  events.emit({ step: "intake", event: "progress", data: { lock_acquired: { waited_ms: Date.now() - queuedAt } } });
  return { release: got, reason: "" };
}

/**
 * After the plan names files: keep the slot only when those paths do not overlap another live run.
 * A conflict releases the slot before waiting, so two runs cannot each hold a slot and wait.
 * Returns false when the run is `locked` (the lock is already released).
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
  for (;;) {
    const slot = f.release?.slot;
    if (slot === undefined) return false;
    const decision = decidePathClaim(deps.factoryHome, raw, slot, runId, { paths, exclusive });
    if (decision.ok) return true;
    if (decision.kind === "busy") {
      await realSleep(poll, deps.signal);
      continue;
    }
    const reason = `planned paths overlap active runs: ${decision.conflicts.join("; ")}`;
    if (!wait) {
      f.release?.();
      f.release = undefined;
      f.set({ result: "locked", reason });
      return false;
    }
    events.emit({ step: "intake", event: "queued", data: { repo: key, overlap: decision.conflicts, waiter_pid: process.pid } });
    f.release?.();
    f.release = undefined;
    await realSleep(poll, deps.signal);
    const again = await takeRepoLock(deps, repoDir, runId, events, true, f.maxRuns);
    if (!again.release) {
      f.set({ result: "locked", reason: again.reason || reason });
      return false;
    }
    f.release = again.release;
    f.lockSlot = again.release.slot;
  }
}

interface Outcome {
  result: RunResultKind;
  reason: string;
  type: RunResult["type"];
  risk: RunResult["risk"];
  merge_policy: RunResult["merge_policy"];
  pr: string | null;
  rounds: number;
  questions?: string[];
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

  constructor(
    readonly runId: string,
    readonly runDir: string,
    readonly repoDir: string,
    public lane: Lane,
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
      if (e instanceof Interrupted) this.set({ result: "failed", reason });
      else if (e instanceof TransientAgentError) {
        // Provider timeout/drop/capacity, retries used up: the run is fine, the provider was not. Resumable;
        // the uncommitted leftovers are the agent's (not a human fix), so resume discards them.
        if (this.state) this.state.transient = true;
        this.set({ result: "needs_human", reason: `${reason}; factory resume ${this.runId}` });
      } else if (e instanceof WallTimeExceeded) {
        // The work so far stays in the worktree; resume re-runs the gates over it and continues.
        this.set({ result: "needs_human", reason: this.state?.worktree ? `${reason}; factory resume ${this.runId}` : reason });
      } else if (e instanceof WatchdogAbort || e instanceof InvalidOutputError || e instanceof EnvMissing) {
        this.set({ result: "needs_human", reason });
      } else this.set({ result: "failed", reason });
    }
    for (const cleanup of this.cleanups.splice(0)) await cleanup().catch(() => undefined);
    // Service logs and browser captures are written by child processes: redact them in place.
    if (this.events.secrets.length) redactTree(this.runDir, (t) => this.events.redact(t), ["worktree", "home", "plan-base", "eval-base"]);
    let result: RunResult;
    try {
      result = this.finish();
    } finally {
      this.release?.();
    }
    // After the lock is released: the woken bot may start the next run right away.
    if (this.deps) await notifyFinished(result, this.deps, this.events);
    return result;
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

  private finish(): RunResult {
    const { out } = this;
    const result: RunResult = {
      run_id: this.runId,
      repo: this.repoDir,
      task: this.taskRef,
      type: out.type,
      lane: this.lane,
      result: out.result,
      risk: out.risk,
      merge_policy: out.merge_policy,
      pr: out.pr,
      rounds: out.rounds,
      minutes: Math.round(((this.now() - this.startedAt) / 60_000) * 10) / 10,
      cost_usd: Math.round(this.events.totals.cost_usd * 10_000) / 10_000,
      reason: out.reason,
      ...(this.events.diffCount ?? {}),
      ...(out.questions ? { questions: out.questions } : {}),
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
    f.set({ result: "needs_human", reason: `secrets: ${e.message}` });
    return undefined;
  }
  f.events.addSecrets(s.redact);
  f.events.emit({ step, event: "progress", data: { secrets: { provider: repo.secrets.provider, resolved: Object.keys(s.env).length, missing: s.missing } } });
  if (s.missing.length) {
    f.set({ result: "needs_human", reason: `secrets not resolved: ${s.missing.join(", ")} (see factory doctor --repo)` });
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
  const runId = newRunId(startedAt);
  const runDir = join(deps.factoryHome, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  if (deps.sandbox) events.emit({ step: "intake", event: "sandbox", data: { ...deps.sandbox } });
  const repoDir = resolve(opts.repo);
  const lane = opts.lane ?? "standard";
  const ref = opts.issue !== undefined ? `#${opts.issue}` : (opts.planFile ?? opts.textFile ?? "");
  const f = new RunFrame(runId, runDir, repoDir, lane, events, startedAt, now, ref);
  f.deps = deps;

  return f.execute(async () => {
    events.emit({ step: "intake", event: "step_started" });
    const checkout: RepoConfig = loadRepoConfig(repoDir);
    const task: Task = await readTask(opts, repoDir, deps.github);
    f.taskRef = task.ref;
    // Persist the starter's target before the lock, so a locked run still records who to wake.
    const st = (f.state = newState({ runId, repo: repoDir, task, noPr: opts.noPr ?? false, lane, wait: opts.wait ?? false, notifyTarget: opts.notifyTarget }));
    f.save();
    const lock = await takeRepoLock(deps, repoDir, runId, events, opts.wait ?? false, checkout.concurrency.max_runs);
    if (!lock.release) return f.set({ result: "locked", reason: lock.reason });
    f.release = lock.release;
    f.lockSlot = lock.release.slot;
    f.maxRuns = checkout.concurrency.max_runs;
    // The base is fixed before planning: planner and plan_normalize read a clean detached worktree at
    // it, never the user's checkout (untracked files such as `.env` stay out of agent reach).
    const baseSha = await revParse(repoDir, await baseRef(repoDir, checkout.base_branch));
    // Checks, policies and secrets come from the base commit: a change to repo.yaml on the branch
    // (a protected change) takes effect only after a human merged it.
    const repo = await baseRepoConfig(repoDir, baseSha, checkout, events, "intake");
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, repoDir, deps, "intake");
    if (!secrets) return;

    const agentHome = prepareAgentHome(runDir);
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, repoDir);
    const base = { deps, runId, runDir, repoDir, repo, events, agentHome, task, deadline, briefing: memoryBriefing, secrets };

    const escalation: string[] = [];
    const planned: PlanOutcome = await withBaseWorktree(repoDir, baseSha, join(runDir, "plan-base"), async (planDir) => {
      const pctx = { ...base, repoDir: planDir };
      if (lane !== "fast") return obtainPlan(pctx, resolvePlanEffort(opts.planEffort, task.labels));
      const fast = await obtainFastPlan(pctx);
      let p: PlanOutcome;
      if (fast.kind === "escalate") {
        escalation.push(fast.reason);
        p = await planStep(pctx, "medium");
      } else p = fast;
      if (p.kind === "plan" && p.plan.packages.length > 1) escalation.push(`${p.plan.packages.length} packages (fast lane takes 1)`);
      return p;
    });
    if (escalation.length) escalate(f, events, "intake", escalation);
    if (planned.kind === "needs_input") return f.set({ result: "needs_input", reason: "plan needs input", questions: planned.questions });
    if (planned.kind === "failed") return f.set({ result: "failed", reason: planned.reason });
    const plan = planned.plan;
    f.set({ type: plan.type });
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
    await beginWork(f, base, plan, baseSha, status, escalation, { noPr: opts.noPr ?? false, startedAt });
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
  },
  plan: Plan,
  baseSha: string,
  ciStatus: BaseStatus,
  escalation: string[],
  opts: { noPr: boolean; startedAt: number },
): Promise<void> {
  const { deps, events, repo, deadline, repoDir, runDir, runId, task } = base;
  const st = f.state!;
  if (plan.type === "bug" && !repo.tests.run) {
    return f.set({ result: "needs_human", reason: "repo.yaml tests.run is required for the red-green proof of bug plans: the repo's bot adds tests.run (and tests.globs) to .factory/repo.yaml in a config PR, then re-runs after the merge" });
  }
  const stem = `factory/${task.issue ?? "task"}-${slug(plan.goal)}`;
  const slot = f.lockSlot;
  let branch = f.maxRuns > 1 ? `${stem}-${runId.slice(-6)}-s${slot}` : stem;
  const taken = (b: string) =>
    gitOk(repoDir, ["rev-parse", "--verify", `refs/heads/${b}`]).then(async (local) => local || remoteBranchExists(repoDir, b));
  if (await taken(branch)) branch = f.maxRuns > 1 ? `${stem}-${runId}-s${slot}` : `${branch}-${runId.slice(-6)}`;
  const worktree = join(runDir, "worktree");
  const add = (b: string) => git(repoDir, ["worktree", "add", "-q", "-b", b, worktree, baseSha]);
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
  const ctx: RunContext = { ...base, worktree, branch, baseSha, plan, handoffs: [], gateCount: 0, deadline, lane: f.lane, laneEscalation: [...escalation], lockSlot: f.lockSlot, maxRuns: f.maxRuns, wait: f.state?.wait ?? false };
  const services = (ctx.services = runServices(ctx));
  f.cleanups.push(() => services.stopAll());
  const env = agentEnv(ctx);

  if (repo.setup) {
    const setup = await sh(repo.setup, { cwd: worktree, env, timeoutMs: Math.max(1000, deadline.at - Date.now()), jail: jailFor(ctx, worktree) });
    checkDeadline(ctx);
    if (setup.code !== 0) return f.set({ result: "needs_human", reason: `setup failed (env_missing?): ${tail(setup.output, 5)}` });
  }
  if (ciStatus === "none") {
    const fast = repo.checks.filter((c) => c.tier === "fast");
    const results = await runChecks(fast, { cwd: worktree, env: commandEnv(ctx), envCommand: repo.env_command, gateTimeoutMinutes: repo.limits.gate_timeout_minutes, deadline, jail: jailFor(ctx, worktree), services });
    throwIfInterrupted(deps);
    for (const r of results) events.emit({ step: "intake", event: "gate_result", data: { base: true, check: r.name, status: r.status } });
    const red = results.filter((r) => r.status === "fail").map((r) => r.name);
    if (red.length) return f.set({ result: "base_red", reason: `fast checks red on base: ${red.join(", ")}` });
  }
  await advance(f, ctx, { noPr: opts.noPr, startedAt: opts.startedAt });
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
  const f = new RunFrame(runId, runDir, st.repo, st.lane ?? "standard", events, startedAt, now, st.task.ref);
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
    f.set({ type: plan.type });
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, st.repo);
    const base = { deps, runId, runDir, repoDir: st.repo, repo, events, agentHome: prepareAgentHome(runDir), task: st.task, deadline, briefing: memoryBriefing, secrets };
    await beginWork(f, base, plan, st.base_sha!, ci, st.lane_escalation ?? [], { noPr: st.no_pr, startedAt });
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
 * implement → review loop → finalize, starting at `state.step`, persisting state.json after every
 * package, round and step. Shared by run and resume.
 */
async function advance(f: RunFrame, ctx: RunContext, opts: { noPr: boolean; startedAt: number; gates?: GateReport }): Promise<void> {
  const st = f.state!;
  const sync = () => {
    st.lane = ctx.lane;
    st.lane_escalation = ctx.laneEscalation;
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
    if (impl.needsInput) return f.set({ result: "needs_input", reason: "bug without failing repro", questions: impl.needsInput });
    gates = impl.lastGates ?? gates;
    const failed = [...impl.status].filter(([, s]) => s !== "done").map(([id, s]) => `${id} ${s}${impl.failures[id] ? `: ${impl.failures[id]}` : ""}`);
    if (failed.length || !gates) {
      loop = { result: "needs_human", reason: `packages not done: ${failed.join("; ")}`, rounds: st.rounds, findings: [], gates };
    } else {
      st.step = "review";
      if (ctx.lane === "fast") {
        const reasons = await fastLaneEscalation(ctx);
        if (reasons.length) {
          escalate(f, ctx.events, "implement", reasons);
          ctx.lane = "standard";
          ctx.laneEscalation.push(...reasons);
        }
      }
      sync();
    }
  }
  if (st.step === "review") {
    loop = await reviewLoop(ctx, gates!, {
      firstRound: st.rounds + 1,
      onRound: (round, findings) => {
        st.rounds = round;
        st.findings = findings;
        sync();
      },
    });
    if (loop.result === "done") {
      st.step = "finalize";
      sync();
    }
  }
  loop ??= { result: "done", reason: "", rounds: st.rounds, findings: st.findings, gates };

  const fin = await finalize(ctx, {
    ...loop,
    packages: new Map(Object.entries(st.packages)),
    failures: st.failures,
    noPr: opts.noPr,
    startedAt: opts.startedAt,
    existingPr: st.pr ? { url: st.pr, draft: st.pr_draft ?? true } : undefined,
  });
  st.pr = fin.pr;
  st.pr_draft = fin.draft;
  if (st.step === "finalize" && fin.result === "done") st.step = "finished";
  sync();
  f.set({ result: fin.result, reason: fin.reason, risk: fin.risk.risk, merge_policy: fin.mergePolicy, pr: fin.pr, rounds: st.rounds, ...(fin.skipped_gates?.length ? { skipped_gates: fin.skipped_gates } : {}) });
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
  if (st.step === "finished") throw new Error(`run ${runId} is finished (${st.result}); nothing to resume`);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  if (deps.sandbox) events.emit({ step: "intake", event: "sandbox", data: { ...deps.sandbox } });
  const f = new RunFrame(runId, runDir, st.repo, st.lane ?? "standard", events, startedAt, now, st.task.ref);
  f.deps = deps;
  f.set({ branch: st.branch, worktree: st.worktree, pr: st.pr, rounds: st.rounds });

  // Locked, or planned paths overlapping another run: report without touching this run's result.json.
  const checkout = loadRepoConfig(st.repo);
  const lock = await takeRepoLock(deps, st.repo, runId, events, opts.wait ?? false, checkout.concurrency.max_runs);
  if (!lock.release) {
    const locked: RunResult = {
      run_id: runId, repo: st.repo, task: st.task.ref, type: null, lane: st.lane ?? "standard", result: "locked", risk: null, merge_policy: null,
      pr: st.pr, rounds: st.rounds, minutes: 0, cost_usd: 0, reason: lock.reason, branch: st.branch, worktree: st.worktree, run_dir: runDir,
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
      const locked: RunResult = {
        run_id: runId, repo: st.repo, task: st.task.ref, type: plan.type, lane: st.lane ?? "standard", result: "locked", risk: null, merge_policy: null,
        pr: st.pr, rounds: st.rounds, minutes: 0, cost_usd: 0, reason: f.out.reason, branch: st.branch, worktree: st.worktree, run_dir: runDir,
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

  return f.execute(async () => {
    events.emit({ step: "resume", event: "step_started", data: { from: st.step, previous_result: previous } });
    const repo = st.base_sha ? await baseRepoConfig(st.repo, st.base_sha, loadRepoConfig(st.repo), events, "resume") : loadRepoConfig(st.repo);
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, st.repo, deps, "resume");
    if (!secrets) return;
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
    f.set({ type: plan.type });
    const deadline = wallBudget(f, events, repo);
    const memoryBriefing = await openMemory(f, deps, st.repo);
    const ctx: RunContext = {
      deps, runId, runDir, repoDir: st.repo, repo, events, agentHome: prepareAgentHome(runDir), task: st.task, briefing: memoryBriefing,
      lane: st.lane ?? "standard", laneEscalation: st.lane_escalation ?? [],
      worktree: st.worktree!, branch: st.branch!, baseSha: st.base_sha!, plan, handoffs: st.handoffs, gateCount: st.gate_count, deadline, secrets,
      lockSlot: f.lockSlot,
      maxRuns: f.maxRuns,
      wait: st.wait ?? false,
    };
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
    if (!ready.ok) return f.set({ result: "needs_human", reason: ready.reason });
    let gates = ready.gates;
    if (gates && !gates.green) {
      const fixed = await fixStep(ctx, "resume", { open: [], gates }, { gateFailures: 0 });
      if (!fixed.ok) return f.set({ result: "needs_human", reason: `resume: ${fixed.reason}` });
      gates = fixed.gates;
    }
    events.emit({ step: "resume", event: "step_finished", data: { continue_at: st.step } });
    await advance(f, ctx, { noPr: opts.noPr ?? st.no_pr, startedAt, gates });
  });
}

type Ready = { ok: true; gates?: GateReport } | { ok: false; reason: string };

/** Re-validation before a resumed run continues. */
async function prepareResume(ctx: RunContext, st: RunState, previous: RunState["result"]): Promise<Ready> {
  const { worktree: wt, branch } = ctx;
  const fail = (reason: string): Ready => ({ ok: false, reason: `resume: ${reason}` });
  if (!existsSync(wt)) return fail(`worktree ${wt} is missing`);
  const head = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== branch) return fail(`worktree is on ${head}, expected ${branch}`);
  for (const [ref, what] of [["MERGE_HEAD", "merge"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"]] as const) {
    if (await gitOk(wt, ["rev-parse", "-q", "--verify", ref])) return fail(`a ${what} is in progress in the worktree; finish or abort it first`);
  }
  if (previous === "needs_human" && !st.transient) {
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
  if (await remoteBranchExists(ctx.repoDir, branch)) {
    const remote = `refs/remotes/origin/${branch}`;
    if (await gitOk(wt, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`]) && !(await isAncestor(wt, remote))) {
      const merged = await mergeRef(wt, remote, `chore: merge origin/${branch}`, gitAuthor(ctx));
      if (!merged.ok) return fail(`commits on origin/${branch} conflict with the worktree in ${merged.conflicts.join(", ") || merged.error.slice(0, 200)}`);
      ctx.events.emit({ step: "resume", event: "progress", data: { remote_branch_merged: await headSha(wt) } });
    }
  }
  const synced = await syncBase(ctx, "resume");
  if (!synced.ok && !synced.gates) return fail(synced.reason);
  if (synced.gates) return { ok: true, gates: synced.gates };
  const done = st.step === "implement" ? Object.keys(st.packages).filter((id) => st.packages[id] === "done") : ctx.plan.packages.map((p) => p.id);
  if (done.length === 0) return { ok: true };
  return { ok: true, gates: await runGates(ctx, "fast", done) };
}
