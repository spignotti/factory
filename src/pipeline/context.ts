import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "../agents/env.js";
import type { Sleep } from "../agents/fake-runner.js";
import { callModel, type ModelRequest, type ModelResponse } from "../agents/models.js";
import type { AgentRunner } from "../agents/runner.js";
import type { Clock, EventLog } from "../events.js";
import type { GitHub } from "../gh.js";
import type { Handoff } from "../schemas/handoff.js";
import type { Plan } from "../schemas/plan.js";
import { type Profile, profileRoleOf } from "../schemas/profile.js";
import type { RepoConfig } from "../schemas/repo.js";
import { supervise, WatchdogAbort } from "./watchdog.js";

export interface RunDeps {
  runner: AgentRunner;
  github: GitHub;
  profile: Profile;
  /** Root for runs and locks (default `~/.factory`). */
  factoryHome: string;
  /** Environment the allowlist reads from (default `process.env`). */
  parentEnv?: NodeJS.ProcessEnv;
  sleep?: Sleep;
  now?: Clock;
  watchdogPollMs?: number;
  /** Aborted on SIGINT/SIGTERM (reason: Interrupted). */
  signal?: AbortSignal;
}

export interface Task {
  /** `#12`, a file path, or `text`. */
  ref: string;
  issue?: number;
  title: string;
  text: string;
  labels: string[];
}

export interface RunContext {
  deps: RunDeps;
  runId: string;
  runDir: string;
  repoDir: string;
  repo: RepoConfig;
  events: EventLog;
  agentHome: string;
  task: Task;
  worktree: string;
  branch: string;
  baseSha: string;
  plan: Plan;
  handoffs: Handoff[];
  gateCount: number;
  /** `max_wall_minutes` outer limit (epoch ms), enforced between steps and inside agent calls. */
  deadline: number;
}

export class WallTimeExceeded extends Error {
  constructor(minutes: number) {
    super(`max_wall_minutes (${minutes}) exceeded`);
    this.name = "WallTimeExceeded";
  }
}

export function checkDeadline(ctx: Pick<RunContext, "deadline" | "repo" | "deps">): void {
  throwIfInterrupted(ctx.deps);
  if (Date.now() > ctx.deadline) throw new WallTimeExceeded(ctx.repo.limits.max_wall_minutes);
}

export function throwIfInterrupted(deps: Pick<RunDeps, "signal">): void {
  if (deps.signal?.aborted) throw deps.signal.reason instanceof Error ? deps.signal.reason : new Error("interrupted");
}

/** Writes a run artifact, redacted like the event log. */
export function writeJson(ctx: Pick<RunContext, "runDir" | "events">, name: string, data: unknown): void {
  writeRunFile(ctx, name, JSON.stringify(data, null, 2) + "\n");
}

export function writeRunFile(ctx: Pick<RunContext, "runDir" | "events">, name: string, text: string): void {
  writeFileSync(join(ctx.runDir, name), ctx.events.redact(text));
}

/** Allowlisted env for agent tool processes and checks of this run (Amendment b). */
export function agentEnv(ctx: Pick<RunContext, "deps" | "repo" | "agentHome">, role?: string): Record<string, string> {
  const roleEnv = role ? (ctx.deps.profile.env[profileRoleOf(role)] ?? []) : [];
  return buildAgentEnv(ctx.deps.parentEnv ?? process.env, { home: ctx.agentHome, extra: [...ctx.repo.agent_env, ...roleEnv] });
}

export type AgentCall = Omit<ModelRequest, "env" | "signal" | "onActivity" | "agentDir">;

/** One supervised agent call: model chain with backoff/fallback, heartbeat events, watchdog. */
export async function callAgent(
  ctx: Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "deadline">,
  step: string,
  req: AgentCall,
): Promise<ModelResponse> {
  const { deps, events } = ctx;
  try {
    return await supervise(
      events,
      {
        windowMs: ctx.repo.limits.stall_minutes * 60_000,
        now: deps.now,
        pollMs: deps.watchdogPollMs,
        deadline: { at: ctx.deadline, error: () => new WallTimeExceeded(ctx.repo.limits.max_wall_minutes) },
        signal: deps.signal,
      },
      (signal) =>
        callModel({ runner: deps.runner, profile: deps.profile, events, sleep: deps.sleep }, step, {
          ...req,
          env: agentEnv(ctx, req.role),
          agentDir: join(deps.factoryHome, "pi"),
          signal,
          onActivity: (a) => void events.emit({ step, event: a.kind, role: req.role, data: a.detail ? { detail: a.detail } : {} }),
        }),
    );
  } catch (e) {
    if (e instanceof WatchdogAbort) {
      events.emit({ step, event: "watchdog_abort", role: req.role, data: { silent_ms: e.silentMs } });
    } else if (e instanceof WallTimeExceeded) {
      events.emit({ step, event: "progress", role: req.role, data: { aborted: "max_wall_minutes" } });
    }
    throw e;
  }
}
