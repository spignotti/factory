import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "../agents/env.js";
import type { Sleep } from "../agents/fake-runner.js";
import { callModel, type ModelRequest, type ModelResponse } from "../agents/models.js";
import { type Context7Client, docsTools } from "../docs/context7.js";
import type { AgentRunner } from "../agents/runner.js";
import type { Clock, EventLog } from "../events.js";
import type { GitHub } from "../gh.js";
import type { Handoff } from "../schemas/handoff.js";
import type { Plan } from "../schemas/plan.js";
import { type DocsStep, type Profile, profileRoleOf } from "../schemas/profile.js";
import type { RepoConfig } from "../schemas/repo.js";
import { supervise, WatchdogAbort } from "./watchdog.js";
import { gitCommonDir, type Jail, type Sandbox } from "../sandbox/sandbox.js";
import { Services } from "../services.js";
import type { ResolvedSecrets } from "../secrets.js";
import type { FactoryTools } from "../agents/runner.js";
import type { Fetch } from "../notify.js";

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
  /** Poll interval while queued for the repo lock (default 15 s). */
  lockPollMs?: number;
  /** Aborted on SIGINT/SIGTERM (reason: Interrupted). */
  signal?: AbortSignal;
  /** Process sandbox for agents and repo commands; absent = none (tests). */
  sandbox?: Sandbox;
  /** Role prompt replacements by name (`roles/<name>.md`), from an eval profile. */
  prompts?: Partial<Record<string, string>>;
  /** Context7 client behind the `docs_lookup` tool; absent = no docs tool (tests). */
  docs?: Context7Client;
  /** Run-end webhook transport (tests inject one); the hooks come from `$FACTORY_HOME/notify.yaml`. */
  notifyFetch?: Fetch;
  /** Backoff between notification attempts (tests: short). */
  notifyBackoffMs?: number[];
  /** Poll interval while CI on the base commit is pending (default 30 s). */
  baseCiPollMs?: number;
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
  /** Findings memory briefing: top open recurring findings, or "". */
  briefing: string;
  /** Effective lane: `fast` until escalated. */
  lane: Lane;
  /** Why a fast-lane run moved to the standard lane (empty = not escalated). */
  laneEscalation: string[];
  /** Services of this run, stopped at run end. */
  services?: Services;
  /** repo.yaml `secrets:` resolved for this run (commands only, never agents); absent = none. */
  secrets?: ResolvedSecrets;
}

export type Lane = "standard" | "fast";

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

/** Allowlisted env for agent tool processes of this run (never a repo secret, even if listed in agent_env). */
export function agentEnv(ctx: Pick<RunContext, "deps" | "repo" | "agentHome" | "secrets">, role?: string): Record<string, string> {
  const roleEnv = role ? (ctx.deps.profile.env[profileRoleOf(role)] ?? []) : [];
  const exclude = [...(ctx.repo.secrets?.names ?? []), ...(ctx.secrets?.names ?? [])];
  return buildAgentEnv(ctx.deps.parentEnv ?? process.env, { home: ctx.agentHome, extra: [...ctx.repo.agent_env, ...roleEnv], exclude });
}

/** Env for repo commands the factory runs itself (checks, red-green tests, services, the ui, flows): agentEnv plus the repo secrets. */
export function commandEnv(ctx: Pick<RunContext, "deps" | "repo" | "agentHome" | "secrets">): Record<string, string> {
  return { ...agentEnv(ctx), ...(ctx.secrets?.env ?? {}) };
}

/**
 * Jail for agent bash and repo commands with `cwd` writable (worktree or a temp base worktree), the
 * agent HOME writable and the main repo git dir read-only. Undefined when the sandbox is off.
 */
export function jailFor(ctx: Pick<RunContext, "deps" | "agentHome" | "secrets">, cwd: string): Jail | undefined {
  const sandbox = ctx.deps.sandbox;
  if (!sandbox || sandbox.mode === "off") return undefined;
  const common = gitCommonDir(cwd);
  return { sandbox, rw: [cwd, ctx.agentHome], ro: common ? [common] : [], hide: [ctx.deps.factoryHome, ...(ctx.secrets?.files ?? [])] };
}

export type AgentCall = Omit<ModelRequest, "env" | "signal" | "onActivity" | "agentDir" | "jail" | "docs">;

/** Whether an agent step gets `docs_lookup`: repo.yaml `docs_lookup.roles`, else the profile's. */
export function docsEnabled(ctx: Pick<RunContext, "deps" | "repo">, step: string): boolean {
  const roles: string[] = ctx.repo.docs_lookup?.roles ?? ctx.deps.profile.docs_lookup.roles;
  return ctx.deps.docs !== undefined && roles.includes(step as DocsStep);
}

/** One supervised agent call: model chain with backoff/fallback, heartbeat events, watchdog. */
/** Tool results redacted before they reach the model (an app page or doc could echo a secret). */
function redactedTools(tools: FactoryTools | undefined, redact: (s: string) => string): FactoryTools | undefined {
  if (!tools) return undefined;
  return {
    specs: tools.specs,
    call: async (name, args) => {
      const r = await tools.call(name, args);
      return { ...r, text: redact(r.text) };
    },
  };
}

export async function callAgent(
  ctx: Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "deadline" | "secrets">,
  step: string,
  req: AgentCall,
): Promise<ModelResponse> {
  const { deps, events } = ctx;
  const docs = deps.docs && docsEnabled(ctx, step)
    ? docsTools(deps.docs, (call) => void events.emit({ step, event: "docs_lookup", role: req.role, data: { ...call } }))
    : undefined;
  let suspends = 0;
  try {
    return await supervise(
      events,
      {
        windowMs: ctx.repo.limits.stall_minutes * 60_000,
        now: deps.now,
        pollMs: deps.watchdogPollMs,
        deadline: { at: ctx.deadline, error: () => new WallTimeExceeded(ctx.repo.limits.max_wall_minutes) },
        signal: deps.signal,
        onSuspend: (frozenMs) => {
          suspends++;
          events.emit({ step, event: "progress", role: req.role, data: { suspended_ms: frozenMs } });
        },
      },
      (signal) =>
        callModel({ runner: deps.runner, profile: deps.profile, events, sleep: deps.sleep, suspends: () => suspends }, step, {
          ...req,
          // Prompts carry gate output and app text: exact-match redaction of every secret value.
          system: events.redact(req.system),
          prompt: events.redact(req.prompt),
          ...(req.browser ? { browser: redactedTools(req.browser, (t) => events.redact(t)) } : {}),
          env: agentEnv(ctx, req.role),
          jail: jailFor(ctx, req.cwd),
          commandTimeoutMs: ctx.repo.limits.command_timeout_minutes * 60_000,
          agentDir: join(deps.factoryHome, "pi"),
          ...(docs ? { docs: redactedTools(docs, (t) => events.redact(t)) } : {}),
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

/** Services of a run in its worktree, with the run's env and jail; events as `service`. */
export function runServices(ctx: Pick<RunContext, "deps" | "repo" | "agentHome" | "runId" | "runDir" | "events" | "worktree" | "secrets">): Services {
  return new Services(ctx.repo, {
    runId: ctx.runId,
    logDir: join(ctx.runDir, "services"),
    cwd: ctx.worktree,
    env: commandEnv(ctx),
    factoryHome: ctx.deps.factoryHome,
    jail: jailFor(ctx, ctx.worktree),
    onEvent: (action, data) => void ctx.events.emit({ step: "gates", event: "service", data: { action, ...data } }),
  });
}
