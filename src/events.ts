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
  // Same-model retry of a provider stream abort (the current agent call, not the whole run).
  "step_retry",
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
  /**
   * Last max_diff_lines split when `limits.diff_count_tests` is false.
   * Copied onto result.json. Unset keeps the historical result shape (tests still count).
   */
  diffCount?: { counted_lines: number; excluded_test_lines: number };
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

export const RESULTS = ["done", "needs_human", "needs_input", "failed", "base_red", "locked", "abandoned"] as const;
export type RunResultKind = (typeof RESULTS)[number];

/**
 * Machine-readable cause of a stopped run, persisted next to the free-text diagnostics.
 * Readers (worker, status) decide recovery from this cause, never from the reason text.
 * - `technical_repair`: a classified, mechanical failure; the checkpoint and bounded repair state stay usable
 * - `transient_retry`: provider/network/capacity drop after retries; retry the same run without a product edit
 * - `provider_window_wait`: an explicit usage-window reset is required before another attempt. Generic 429/capacity
 *   is `transient_retry`. #179 does not schedule a reset; #177 supplies the window metadata
 * - `explicit_decision`: only an answer from a person moves this run on (questions, changed issue text, a real merge conflict)
 * - `human_approval`: a human authority action is required (pause, protected config, env setup). Not granted by recovery
 * - `budget_exhausted`: a bounded retry/repair budget is spent. Budgets are not reset. The action is a human decision
 *   (an explicit grant is #188, not an automatic restart)
 * - `unknown`: not classified (legacy or ambiguous); readers fail closed — no automatic recovery, no merge permission
 */
export const STOP_CAUSES = ["technical_repair", "transient_retry", "provider_window_wait", "explicit_decision", "human_approval", "budget_exhausted", "unknown"] as const;
export type StopCause = (typeof STOP_CAUSES)[number];

/** The one recovery action permitted for a stop cause. Never a merge permission, never a silent budget reset. */
export const RECOVERY_ACTIONS = ["repair", "retry", "wait", "decide", "approve", "none"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/** Canonical cause/action pairs. A stored pair outside this list is malformed and must fail closed. */
export const STOP_ACTION: Record<StopCause, RecoveryAction> = {
  technical_repair: "repair",
  transient_retry: "retry",
  provider_window_wait: "wait",
  explicit_decision: "decide",
  human_approval: "approve",
  budget_exhausted: "decide",
  unknown: "none",
};

/**
 * Stored per finished attempt on `state.json` and `result.json`. Optional: absent on stops written before #179.
 * Present metadata must be one canonical pair. Identity, checkpoint and budgets stay on the run, not on this object.
 */
export const StopSchema = z.discriminatedUnion("cause", [
  z.object({ cause: z.literal("technical_repair"), action: z.literal("repair") }).strict(),
  z.object({ cause: z.literal("transient_retry"), action: z.literal("retry") }).strict(),
  z.object({ cause: z.literal("provider_window_wait"), action: z.literal("wait") }).strict(),
  z.object({ cause: z.literal("explicit_decision"), action: z.literal("decide") }).strict(),
  z.object({ cause: z.literal("human_approval"), action: z.literal("approve") }).strict(),
  z.object({ cause: z.literal("budget_exhausted"), action: z.literal("decide") }).strict(),
  z.object({ cause: z.literal("unknown"), action: z.literal("none") }).strict(),
]);
export type RunStop = z.infer<typeof StopSchema>;

/**
 * Stored per finished attempt. `merged: "no"` is a coding result, not a confirmed merge.
 * Absent on results written before outcomes existed; readers leave those unknown.
 */
export const OutcomeSchema = z.object({
  /** Issue number, or null when the task is known to have no ticket. */
  ticket: z.number().int().positive().nullable(),
  /** Attempts on this checkpoint, or null when the checkpoint did not record a count. */
  attempts: z.number().int().min(0).nullable(),
  delivered_pr: z.string().nullable(),
  merged: z.enum(["no", "confirmed", "unknown"]),
  ended_without_merge: z.boolean(),
  open_decision: z.boolean(),
});
export type RunOutcome = z.infer<typeof OutcomeSchema>;

/** How this attempt was produced. Check commands and secret values are not stored. */
export const ProvenanceSchema = z.object({
  factory_version: z.string(),
  factory_commit: z.string(),
  prompt_revision: z.string(),
  model: z.string(),
  effort: z.string(),
  config_fingerprint: z.string(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  checks: z.array(z.object({ name: z.string(), version: z.string() })),
});
export type RunProvenance = z.infer<typeof ProvenanceSchema>;

export const ResultSchema = z.object({
  run_id: z.string(),
  repo: z.string(),
  task: z.string(),
  type: z.enum(["feature", "bug", "chore"]).nullable(),
  /** Always `standard`. `fast` remains so older result.json files still parse. */
  lane: z.enum(["standard", "fast"]),
  result: z.enum(RESULTS),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  /**
   * Why `riskClass` rated the diff (paths, diff size, protected files). Empty when nothing raised
   * the rating. Omitted on results written before this field. Not the review-exit `reason`.
   */
  risk_reasons: z.array(z.string()).optional(),
  merge_policy: z.enum(["auto", "bot_review", "human_review"]).nullable(),
  pr: z.string().nullable(),
  rounds: z.number().int().min(0),
  minutes: z.number().min(0),
  /** USD of metered providers only; subscription usage (see profile `billing`) is reported in tokens. */
  cost_usd: z.number().min(0),
  reason: z.string(),
  /**
   * Machine-readable stop cause and the one canonical recovery action for a stopped attempt.
   * Omitted on a `done` run and on results written before this field. A present value that is not a
   * canonical pair is malformed: readers fail closed and must not guess from the reason text.
   */
  stop: StopSchema.optional(),
  /** Separate counters. Omitted on results written before this field. A `done` run is not a merge. */
  outcome: OutcomeSchema.optional(),
  /** Factory version, prompts, model, effort, sanitized config, base/head, check versions. No secrets. */
  provenance: ProvenanceSchema.optional(),
  /**
   * Security gates that did not scan because the binary was missing (`baseline.require_tools` off).
   * Omitted when none were skipped. A missing binary with `require_tools` on is a failing gate.
   */
  skipped_gates: z.array(z.string()).optional(),
  /** Lines counted toward `limits.max_diff_lines`. Set only when `limits.diff_count_tests` is false. */
  counted_lines: z.number().int().min(0).optional(),
  /** Test-file lines left out of that limit. Set only when `limits.diff_count_tests` is false. */
  excluded_test_lines: z.number().int().min(0).optional(),
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
