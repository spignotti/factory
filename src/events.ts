import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const EVENT_TYPES = [
  "step_started",
  "step_finished",
  "gate_result",
  "model_fallback",
  "round_finished",
  "lane_escalated",
  "watchdog_abort",
  "run_finished",
  // Liveness signals from agent sessions.
  "heartbeat",
  "progress",
  // Per agent call, so usage is recorded on success and on error.
  "agent_finished",
  "agent_error",
  "model_retry",
  // Waiting for the per-repo lock (`--wait`).
  "queued",
  // Sandbox in effect for this run, with degradation warnings.
  "sandbox",
  // Services: data.action = ports | starting | ready | failed | stopped.
  "service",
  // One `docs_lookup` tool call (Context7): library, topic, estimated tokens, status.
  "docs_lookup",
  // Run-end webhook to the repo's bot: status sent | failed | skipped | error (never the URL or key).
  "notify",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface FactoryEvent {
  ts: string;
  run_id: string;
  step: string;
  event: EventType;
  role: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  data: Record<string, unknown>;
}

export interface EventInput {
  step: string;
  event: EventType;
  role?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  data?: Record<string, unknown>;
}

export type Clock = () => number;

/** Agent usage per role and model (PR stats, `stats`). Calls count successes and errors. */
export interface RoleUsage {
  role: string;
  model: string;
  calls: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  /** Subscription usage is reported in tokens only (its cost_usd is 0). */
  billing: "subscription" | "metered";
}

export class EventLog {
  readonly path: string;
  private readonly listeners: ((e: FactoryEvent) => void)[] = [];
  readonly totals = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  private readonly byRole = new Map<string, RoleUsage>();

  constructor(
    runDir: string,
    readonly runId: string,
    private readonly now: Clock = Date.now,
    /** Values that must never reach the log (defense in depth; nothing logs env on purpose). */
    readonly secrets: string[] = [],
  ) {
    this.path = join(runDir, "events.jsonl");
    mkdirSync(runDir, { recursive: true });
    // A resumed run appends to its log; totals (cost) continue from what is already there.
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.count(JSON.parse(line) as Partial<FactoryEvent>);
        } catch {
          // torn last line after a crash
        }
      }
    }
  }

  private count(e: Partial<FactoryEvent>): void {
    this.totals.tokens_in += e.tokens_in ?? 0;
    this.totals.tokens_out += e.tokens_out ?? 0;
    this.totals.cost_usd += e.cost_usd ?? 0;
    if ((e.event === "agent_finished" || e.event === "agent_error") && e.role && e.model) {
      const key = `${e.role}\0${e.model}`;
      const billing = e.data?.billing === "subscription" ? "subscription" : "metered";
      const u = this.byRole.get(key) ?? { role: e.role, model: e.model, calls: 0, errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, billing };
      u.calls += 1;
      if (e.event === "agent_error") u.errors += 1;
      u.tokens_in += e.tokens_in ?? 0;
      u.tokens_out += e.tokens_out ?? 0;
      u.cost_usd += e.cost_usd ?? 0;
      this.byRole.set(key, u);
    }
  }

  /** Usage per role and model, in first-use order (resumed runs include the earlier attempts). */
  usage(): RoleUsage[] {
    return [...this.byRole.values()].map((u) => ({ ...u }));
  }

  /** Adds values to redact (repo secrets resolved after the log was opened); longest first. */
  addSecrets(values: string[]): void {
    for (const v of values) if (v && !this.secrets.includes(v)) this.secrets.push(v);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  /** Redacts this run's secret values from any text that leaves the process (files, PR body). */
  redact(text: string): string {
    return redact(text, this.secrets);
  }

  onEvent(listener: (e: FactoryEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(input: EventInput): FactoryEvent {
    const event: FactoryEvent = {
      ts: new Date(this.now()).toISOString(),
      run_id: this.runId,
      step: input.step,
      event: input.event,
      role: input.role ?? null,
      model: input.model ?? null,
      tokens_in: input.tokens_in ?? 0,
      tokens_out: input.tokens_out ?? 0,
      cost_usd: input.cost_usd ?? 0,
      data: input.data ?? {},
    };
    this.count(event);
    appendFileSync(this.path, redact(JSON.stringify(event), this.secrets) + "\n");
    for (const l of this.listeners) l(event);
    return event;
  }
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH/i;

/** Values of secret-looking environment variables, for redaction. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= 6)
    .map(([, value]) => value as string);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join("[redacted]");
    const encoded = JSON.stringify(s).slice(1, -1);
    if (encoded !== s) out = out.split(encoded).join("[redacted]");
  }
  return out;
}

export const RESULTS = ["done", "needs_human", "needs_input", "failed", "base_red", "locked"] as const;
export type RunResultKind = (typeof RESULTS)[number];

export const ResultSchema = z.object({
  run_id: z.string(),
  repo: z.string(),
  task: z.string(),
  type: z.enum(["feature", "bug", "chore"]).nullable(),
  lane: z.enum(["standard", "fast"]),
  result: z.enum(RESULTS),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  merge_policy: z.enum(["auto", "bot_review", "human_review"]).nullable(),
  pr: z.string().nullable(),
  rounds: z.number().int().min(0),
  minutes: z.number().min(0),
  /** USD of metered providers only; subscription usage (see profile `billing`) is reported in tokens. */
  cost_usd: z.number().min(0),
  reason: z.string(),
  questions: z.array(z.string()).optional(),
  /** Where to find the work (null until created); needed to fix and `factory resume` a run. */
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  run_dir: z.string(),
});
export type RunResult = z.infer<typeof ResultSchema>;

/** Writes `result.json` as a single line (GrokBot's interface), redacted. Returns what was written. */
export function writeResult(path: string, result: RunResult, secrets: string[] = []): RunResult {
  mkdirSync(dirname(path), { recursive: true });
  const line = redact(JSON.stringify(ResultSchema.parse(result)), secrets);
  writeFileSync(path, line + "\n");
  return JSON.parse(line) as RunResult;
}
