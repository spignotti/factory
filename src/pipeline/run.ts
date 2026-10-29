import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareAgentHome } from "../agents/env.js";
import { InvalidOutputError } from "../agents/models.js";
import { type Clock, EventLog, type RunResult, type RunResultKind, secretValues, writeResult } from "../events.js";
import { sh, tail } from "../exec.js";
import { baseRef, commitAll, discardChanges, git, gitOk, headSha, isAncestor, mergeRef, withBaseWorktree, originUrl, remoteBranchExists, repoLockId, revParse } from "../git.js";
import { Interrupted } from "../interrupt.js";
import { PlanSchema } from "../schemas/plan.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
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
import { agentEnv, checkDeadline, commandEnv, jailFor, type Lane, runServices, type RunContext, type RunDeps, type Task, throwIfInterrupted, WallTimeExceeded, writeJson } from "./context.js";
import { acquireRepoLock, repoLockHolder, waitForRepoLock } from "./lock.js";
import { fixStep, type LoopOutcome, reviewLoop } from "./loop.js";
import { newState, readState, type RunState, saveState } from "./state.js";
import { WatchdogAbort } from "./watchdog.js";

export interface RunOptions extends TaskInput {
  repo: string;
  lane?: "standard" | "fast";
  planEffort?: PlanEffort;
  noPr?: boolean;
  /** Repo locked by another run: wait in a queue instead of returning `locked`. */
  wait?: boolean;
}

export interface ResumeOptions {
  wait?: boolean;
  /** Overrides the original run's --no-pr. */
  noPr?: boolean;
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

/** One factory process per repository (runs and resumes); `wait` queues instead of `locked`. */
export async function takeRepoLock(
  deps: RunDeps,
  repoDir: string,
  runId: string,
  events: EventLog,
  wait: boolean,
): Promise<{ release?: () => void; reason: string }> {
  const id = await repoLockId(repoDir);
  const release = acquireRepoLock(deps.factoryHome, id, runId);
  if (release) return { release, reason: "" };
  const holder = repoLockHolder(deps.factoryHome, id);
  const by = holder ? `run ${holder.runId ?? "?"} (pid ${holder.pid})` : "another run";
  if (!wait) return { reason: `repo ${id} is locked by ${by}` };
  events.emit({ step: "intake", event: "queued", data: { repo: id, holder_run_id: holder?.runId ?? null, holder_pid: holder?.pid ?? null } });
  const queuedAt = Date.now();
  const got = await waitForRepoLock(deps.factoryHome, id, runId, { pollMs: deps.lockPollMs ?? 15_000, signal: deps.signal });
  events.emit({ step: "intake", event: "progress", data: { lock_acquired: { waited_ms: Date.now() - queuedAt } } });
  return { release: got, reason: "" };
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
  branch: string | null;
  worktree: string | null;
}

/** Shared frame of `run` and `resume`: error → result kind, result.json + state.json, lock release. */
class RunFrame {
  out: Outcome = { result: "failed", reason: "", type: null, risk: null, merge_policy: null, pr: null, rounds: 0, branch: null, worktree: null };
  state?: RunState;
  release?: () => void;
  /** Set once the repo lock is held: findings memory to flush at the end. */
  memory?: { factoryHome: string; repoId: string };

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
      else if (e instanceof WatchdogAbort || e instanceof InvalidOutputError || e instanceof WallTimeExceeded || e instanceof EnvMissing) {
        this.set({ result: "needs_human", reason });
      } else this.set({ result: "failed", reason });
    }
    for (const cleanup of this.cleanups.splice(0)) await cleanup().catch(() => undefined);
    // Service logs and browser captures are written by child processes: redact them in place.
    if (this.events.secrets.length) redactTree(this.runDir, (t) => this.events.redact(t), ["worktree", "home", "plan-base", "eval-base"]);
    try {
      return this.finish();
    } finally {
      this.release?.();
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
      ...(out.questions ? { questions: out.questions } : {}),
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

  return f.execute(async () => {
    events.emit({ step: "intake", event: "step_started" });
    const repo: RepoConfig = loadRepoConfig(repoDir);
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, repoDir, deps, "intake");
    if (!secrets) return;
    const task: Task = await readTask(opts, repoDir, deps.github);
    f.taskRef = task.ref;
    const lock = await takeRepoLock(deps, repoDir, runId, events, opts.wait ?? false);
    if (!lock.release) return f.set({ result: "locked", reason: lock.reason });
    f.release = lock.release;
    const st = (f.state = newState({ runId, repo: repoDir, task, noPr: opts.noPr ?? false, lane }));
    f.save();

    const agentHome = prepareAgentHome(runDir);
    const deadline = Date.now() + repo.limits.max_wall_minutes * 60_000;
    const memoryBriefing = await openMemory(f, deps, repoDir);
    const base = { deps, runId, runDir, repoDir, repo, events, agentHome, task, deadline, briefing: memoryBriefing, secrets };

    // The base is fixed before planning: planner and plan_normalize read a clean detached worktree at
    // it, never the user's checkout (untracked files such as `.env` stay out of agent reach).
    const baseSha = await revParse(repoDir, await baseRef(repoDir, repo.base_branch));
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

    // Base check, then the worktree.
    checkDeadline(base);
    const status = await deps.github.baseStatus(repoDir, baseSha);
    if (status === "red" || status === "pending") {
      return f.set({ result: "base_red", reason: `CI on ${repo.base_branch} (${baseSha.slice(0, 8)}) is ${status}, not green` });
    }
    if (plan.type === "bug" && !repo.tests.run) {
      return f.set({ result: "needs_human", reason: "repo.yaml tests.run is required for the red-green proof of bug plans" });
    }
    let branch = `factory/${task.issue ?? "task"}-${slug(plan.goal)}`;
    const taken = (b: string) =>
      gitOk(repoDir, ["rev-parse", "--verify", `refs/heads/${b}`]).then(async (local) => local || remoteBranchExists(repoDir, b));
    if (await taken(branch)) branch += `-${runId.slice(-6)}`;
    const worktree = join(runDir, "worktree");
    await git(repoDir, ["worktree", "add", "-q", "-b", branch, worktree, baseSha]);
    f.set({ branch, worktree });
    Object.assign(st, { branch, worktree, base_sha: baseSha, step: "implement" });
    f.save();
    const ctx: RunContext = { ...base, worktree, branch, baseSha, plan, handoffs: [], gateCount: 0, deadline, lane: f.lane, laneEscalation: [...escalation] };
    const services = (ctx.services = runServices(ctx));
    f.cleanups.push(() => services.stopAll());
    const env = agentEnv(ctx);

    if (repo.setup) {
      const setup = await sh(repo.setup, { cwd: worktree, env, timeoutMs: Math.max(1000, deadline - Date.now()), jail: jailFor(ctx, worktree) });
      checkDeadline(ctx);
      if (setup.code !== 0) return f.set({ result: "needs_human", reason: `setup failed (env_missing?): ${tail(setup.output, 5)}` });
    }
    if (status === "none") {
      const fast = repo.checks.filter((c) => c.tier === "fast");
      const results = await runChecks(fast, { cwd: worktree, env: commandEnv(ctx), envCommand: repo.env_command, deadline, jail: jailFor(ctx, worktree), services });
      throwIfInterrupted(deps);
      for (const r of results) events.emit({ step: "intake", event: "gate_result", data: { base: true, check: r.name, status: r.status } });
      const red = results.filter((r) => r.status === "fail").map((r) => r.name);
      if (red.length) return f.set({ result: "base_red", reason: `fast checks red on base: ${red.join(", ")}` });
    }
    await advance(f, ctx, { noPr: opts.noPr ?? false, startedAt });
  });
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
  f.set({ result: fin.result, reason: fin.reason, risk: fin.risk.risk, merge_policy: fin.mergePolicy, pr: fin.pr, rounds: st.rounds });
}

/**
 * `factory resume <run-id>`: continue a stopped run (needs_human, failed, interrupted) after a human
 * fix. Re-validates first: commits the human's uncommitted changes, merges commits pushed to the PR
 * branch and the moved base (never a rebase or force-push), re-runs the gates (red → one fix
 * session), then continues from the saved step and updates the existing PR.
 */
export async function resumeFactory(runId: string, opts: ResumeOptions, deps: RunDeps): Promise<RunResult> {
  const runDir = join(deps.factoryHome, "runs", runId);
  const st = readState(runDir);
  if (st.step === "intake" || !st.worktree || !st.branch || !st.base_sha) {
    throw new Error(`run ${runId} stopped before its worktree existed (${st.result ?? "running"}: ${st.reason}); start a new run`);
  }
  if (st.step === "finished") throw new Error(`run ${runId} is finished (${st.result}); nothing to resume`);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  if (deps.sandbox) events.emit({ step: "intake", event: "sandbox", data: { ...deps.sandbox } });
  const f = new RunFrame(runId, runDir, st.repo, st.lane ?? "standard", events, startedAt, now, st.task.ref);
  f.set({ branch: st.branch, worktree: st.worktree, pr: st.pr, rounds: st.rounds });

  // Locked: report without touching this run's result.json/state.json (they describe the run, not this attempt).
  const lock = await takeRepoLock(deps, st.repo, runId, events, opts.wait ?? false);
  if (!lock.release) {
    return {
      run_id: runId, repo: st.repo, task: st.task.ref, type: null, lane: st.lane ?? "standard", result: "locked", risk: null, merge_policy: null,
      pr: st.pr, rounds: st.rounds, minutes: 0, cost_usd: 0, reason: lock.reason, branch: st.branch, worktree: st.worktree, run_dir: runDir,
    };
  }
  f.release = lock.release;
  f.state = st;

  return f.execute(async () => {
    events.emit({ step: "resume", event: "step_started", data: { from: st.step, previous_result: st.result } });
    const repo = loadRepoConfig(st.repo);
    deps = { ...deps, profile: withRepoModels(deps.profile, repo.models) };
    const secrets = await openSecrets(f, repo, st.repo, deps, "resume");
    if (!secrets) return;
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")));
    f.set({ type: plan.type });
    const deadline = Date.now() + repo.limits.max_wall_minutes * 60_000;
    const memoryBriefing = await openMemory(f, deps, st.repo);
    const ctx: RunContext = {
      deps, runId, runDir, repoDir: st.repo, repo, events, agentHome: prepareAgentHome(runDir), task: st.task, briefing: memoryBriefing,
      lane: st.lane ?? "standard", laneEscalation: st.lane_escalation ?? [],
      worktree: st.worktree!, branch: st.branch!, baseSha: st.base_sha!, plan, handoffs: st.handoffs, gateCount: st.gate_count, deadline, secrets,
    };
    const services = (ctx.services = runServices(ctx));
    f.cleanups.push(() => services.stopAll());
    if (st.step === "implement") {
      for (const id of Object.keys(st.packages)) if (st.packages[id] !== "done") delete st.packages[id];
      st.failures = {};
    }
    const ready = await prepareResume(ctx, st);
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
async function prepareResume(ctx: RunContext, st: RunState): Promise<Ready> {
  const { worktree: wt, branch } = ctx;
  const fail = (reason: string): Ready => ({ ok: false, reason: `resume: ${reason}` });
  if (!existsSync(wt)) return fail(`worktree ${wt} is missing`);
  const head = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (head !== branch) return fail(`worktree is on ${head}, expected ${branch}`);
  for (const [ref, what] of [["MERGE_HEAD", "merge"], ["REBASE_HEAD", "rebase"], ["CHERRY_PICK_HEAD", "cherry-pick"]] as const) {
    if (await gitOk(wt, ["rev-parse", "-q", "--verify", ref])) return fail(`a ${what} is in progress in the worktree; finish or abort it first`);
  }
  if (st.result === "needs_human") {
    // The run stopped for a human: whatever is uncommitted now is their fix.
    if (await commitAll(wt, "fix: human changes before resume", gitAuthor(ctx))) {
      ctx.events.emit({ step: "resume", event: "progress", data: { human_changes_committed: await headSha(wt) } });
    }
  } else if ((await git(wt, ["status", "--porcelain"])).trim() !== "") {
    // Interrupted/crashed: uncommitted changes are unvalidated agent leftovers; the step re-runs anyway.
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
