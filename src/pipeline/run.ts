import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareAgentHome } from "../agents/env.js";
import { InvalidOutputError } from "../agents/models.js";
import { EventLog, type RunResult, type RunResultKind, secretValues, writeResult } from "../events.js";
import { sh, tail } from "../exec.js";
import { baseRef, git, gitOk, revParse } from "../git.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
import { finalize } from "../steps/finalize.js";
import { runChecks } from "../steps/gates.js";
import { implementPackages } from "../steps/implement.js";
import { obtainPlan, type PlanEffort, readTask, resolvePlanEffort, type TaskInput } from "../steps/intake.js";
import { agentEnv, type RunContext, type RunDeps, type Task, WallTimeExceeded, writeJson } from "./context.js";
import { acquireTaskLock } from "./lock.js";
import { reviewLoop } from "./loop.js";
import { WatchdogAbort } from "./watchdog.js";

export interface RunOptions extends TaskInput {
  repo: string;
  lane?: "standard" | "fast";
  planEffort?: PlanEffort;
  noPr?: boolean;
}

function newRunId(now: number): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${d}-${randomBytes(3).toString("hex")}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

async function repoId(repoDir: string): Promise<string> {
  const url = await git(repoDir, ["remote", "get-url", "origin"]).catch(() => "");
  return url.trim() || repoDir;
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
}

/** `factory run`: intake → plan → implement → review loop → finalize. Always writes `result.json`. */
export async function runFactory(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const runId = newRunId(startedAt);
  const runDir = join(deps.factoryHome, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const events = new EventLog(runDir, runId, now, secretValues(deps.parentEnv ?? process.env));
  const repoDir = resolve(opts.repo);
  const lane = opts.lane ?? "standard";
  let taskRef = opts.issue !== undefined ? `#${opts.issue}` : (opts.planFile ?? opts.textFile ?? "");
  let out: Outcome = { result: "failed", reason: "", type: null, risk: null, merge_policy: null, pr: null, rounds: 0 };
  let release: (() => void) | undefined;

  try {
    if (lane === "fast") throw new Error("--lane fast is not available in M1");
    events.emit({ step: "intake", event: "step_started" });
    const repo: RepoConfig = loadRepoConfig(repoDir);
    const task: Task = await readTask(opts, repoDir, deps.github);
    taskRef = task.ref;
    release = acquireTaskLock(deps.factoryHome, await repoId(repoDir), task.ref);
    if (!release) {
      out = { ...out, result: "locked", reason: `task ${task.ref} is locked by another run` };
      return finish();
    }
    const agentHome = prepareAgentHome(runDir);
    const base = { deps, runId, runDir, repoDir, repo, events, agentHome, task };

    const planned = await obtainPlan(base, resolvePlanEffort(opts.planEffort, task.labels));
    if (planned.kind === "needs_input") {
      out = { ...out, result: "needs_input", reason: "plan needs input", questions: planned.questions };
      return finish();
    }
    if (planned.kind === "failed") {
      out = { ...out, result: "failed", reason: planned.reason };
      return finish();
    }
    const plan = planned.plan;
    out.type = plan.type;
    writeJson(base, "plan.json", plan);
    events.emit({ step: "intake", event: "step_finished", data: { plan_source: planned.source, packages: plan.packages.length } });

    // Base check (SPEC §6.1 step 6) and worktree (step 7).
    const ref = await baseRef(repoDir, repo.base_branch);
    const baseSha = await revParse(repoDir, ref);
    const status = await deps.github.baseStatus(repoDir, baseSha);
    if (status === "red" || status === "pending") {
      out = { ...out, result: "base_red", reason: `CI on ${repo.base_branch} (${baseSha.slice(0, 8)}) is ${status}, not green` };
      return finish();
    }
    if (plan.type === "bug" && !repo.tests.run) {
      out = { ...out, result: "needs_human", reason: "repo.yaml tests.run is required for the red-green proof of bug plans" };
      return finish();
    }
    let branch = `factory/${task.issue ?? "task"}-${slug(plan.goal)}`;
    if (await gitOk(repoDir, ["rev-parse", "--verify", `refs/heads/${branch}`])) branch += `-${runId.slice(-6)}`;
    const worktree = join(runDir, "worktree");
    await git(repoDir, ["worktree", "add", "-q", "-b", branch, worktree, baseSha]);
    const deadline = Date.now() - (now() - startedAt) + repo.limits.max_wall_minutes * 60_000;
    const ctx: RunContext = { ...base, worktree, branch, baseSha, plan, handoffs: [], gateCount: 0, deadline };
    const env = agentEnv(ctx);

    if (repo.setup) {
      const setup = await sh(repo.setup, { cwd: worktree, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
      if (setup.code !== 0) {
        out = { ...out, result: "needs_human", reason: `setup failed (env_missing?): ${tail(setup.output, 5)}` };
        return finish();
      }
    }
    if (status === "none") {
      const fast = repo.checks.filter((c) => c.tier === "fast");
      const results = await runChecks(fast, { cwd: worktree, env, envCommand: repo.env_command, deadline });
      for (const r of results) events.emit({ step: "intake", event: "gate_result", data: { base: true, check: r.name, status: r.status } });
      const red = results.filter((r) => r.status === "fail").map((r) => r.name);
      if (red.length) {
        out = { ...out, result: "base_red", reason: `fast checks red on base: ${red.join(", ")}` };
        return finish();
      }
    }

    const impl = await implementPackages(ctx);
    if (impl.needsInput) {
      out = { ...out, result: "needs_input", reason: "bug without failing repro", questions: impl.needsInput };
      return finish();
    }
    const failed = [...impl.status].filter(([, s]) => s !== "done").map(([id, s]) => `${id} ${s}${impl.failures[id] ? `: ${impl.failures[id]}` : ""}`);
    const loop = failed.length || !impl.lastGates
      ? { result: "needs_human" as const, reason: `packages not done: ${failed.join("; ")}`, rounds: 0, findings: [], gates: impl.lastGates }
      : await reviewLoop(ctx, impl.lastGates);

    const fin = await finalize(ctx, { ...loop, packages: impl.status, failures: impl.failures, noPr: opts.noPr ?? false, startedAt });
    out = { ...out, result: fin.result, reason: fin.reason, risk: fin.risk.risk, merge_policy: fin.mergePolicy, pr: fin.pr, rounds: loop.rounds };
    return finish();
  } catch (e) {
    const reason = (e as Error).message;
    if (e instanceof WatchdogAbort || e instanceof InvalidOutputError || e instanceof WallTimeExceeded) out = { ...out, result: "needs_human", reason };
    else out = { ...out, result: "failed", reason };
    return finish();
  } finally {
    release?.();
  }

  function finish(): RunResult {
    const result: RunResult = {
      run_id: runId,
      repo: repoDir,
      task: taskRef,
      type: out.type,
      lane,
      result: out.result,
      risk: out.risk,
      merge_policy: out.merge_policy,
      pr: out.pr,
      rounds: out.rounds,
      minutes: Math.round(((now() - startedAt) / 60_000) * 10) / 10,
      cost_usd: Math.round(events.totals.cost_usd * 10_000) / 10_000,
      reason: out.reason,
      ...(out.questions ? { questions: out.questions } : {}),
    };
    events.emit({ step: "run", event: "run_finished", data: { result: result.result, reason: result.reason } });
    return writeResult(join(runDir, "result.json"), result, events.secrets);
  }
}
