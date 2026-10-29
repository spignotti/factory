import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  // Amendment d: liveness signals from agent sessions.
  "heartbeat",
  "progress",
  // Per agent call, so usage is recorded on success and on error (Amendment c).
  "agent_finished",
  "agent_error",
  "model_retry",
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

export class EventLog {
  readonly path: string;
  private readonly listeners: ((e: FactoryEvent) => void)[] = [];
  readonly totals = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

  constructor(
    runDir: string,
    readonly runId: string,
    private readonly now: Clock = Date.now,
  ) {
    this.path = join(runDir, "events.jsonl");
    mkdirSync(runDir, { recursive: true });
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
    this.totals.tokens_in += event.tokens_in;
    this.totals.tokens_out += event.tokens_out;
    this.totals.cost_usd += event.cost_usd;
    appendFileSync(this.path, JSON.stringify(event) + "\n");
    for (const l of this.listeners) l(event);
    return event;
  }
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
  cost_usd: z.number().min(0),
  reason: z.string(),
  questions: z.array(z.string()).optional(),
});
export type RunResult = z.infer<typeof ResultSchema>;

/** Writes `result.json` as a single line (GrokBot's interface). */
export function writeResult(path: string, result: RunResult): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ResultSchema.parse(result)) + "\n");
}
