import { z } from "zod";
import { EVENT_TYPES, ResultSchema } from "../events.js";
import { MemoryFileSchema } from "../memory.js";
import { EvalProfileSchema, EvalRecordSchema, EvalTaskSchema, VerdictSchema as ExperimentVerdictSchema } from "./eval.js";
import { DoctorReportSchema, GcReportSchema, StatsReportSchema, StatusReportSchema } from "./reports.js";
import { HardenReportSchema, MetricsSchema, ProposalSchema } from "./proposal.js";
import { LeanOutputSchema, ReviewOutputSchema } from "./review.js";

/** One line of `events.jsonl`. `data` depends on the event. */
export const EventLineSchema = z.object({
  ts: z.string(),
  run_id: z.string(),
  step: z.string(),
  event: z.enum(EVENT_TYPES),
  role: z.string().nullable(),
  model: z.string().nullable(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.number(),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Contracts with GrokBot and other consumers, published as JSON Schema in `schemas/` (`pnpm schemas`;
 * a test fails when a file is out of date). `input` = what an agent may send (defaults optional).
 */
export const JSON_SCHEMAS: Record<string, { schema: z.ZodType; io: "input" | "output"; title: string }> = {
  "result.schema.json": { schema: ResultSchema, io: "output", title: "factory result.json" },
  "event.schema.json": { schema: EventLineSchema, io: "output", title: "factory events.jsonl line" },
  "status.schema.json": { schema: StatusReportSchema, io: "output", title: "factory status --json" },
  "stats.schema.json": { schema: StatsReportSchema, io: "output", title: "factory stats --json" },
  "gc.schema.json": { schema: GcReportSchema, io: "output", title: "factory gc --json" },
  "doctor.schema.json": { schema: DoctorReportSchema, io: "output", title: "factory doctor --json" },
  "memory.schema.json": { schema: MemoryFileSchema, io: "output", title: "findings memory ($FACTORY_HOME/memory/<repo>/findings.json)" },
  "proposal.schema.json": { schema: ProposalSchema, io: "output", title: "harden/adopt proposal ($FACTORY_HOME/memory/<repo>/proposals/<id>.json)" },
  "harden.schema.json": { schema: HardenReportSchema, io: "output", title: "factory harden --json" },
  "metrics.schema.json": { schema: MetricsSchema, io: "output", title: "harden metrics line ($FACTORY_HOME/memory/<repo>/metrics.jsonl)" },
  "review-output.schema.json": { schema: ReviewOutputSchema, io: "input", title: "reviewer output (one reviewer)" },
  "review-lean.schema.json": { schema: LeanOutputSchema, io: "input", title: "fast lane lean review output" },
  "eval-task.schema.json": { schema: EvalTaskSchema, io: "input", title: "eval task (evals/tasks/<id>.yaml)" },
  "eval-profile.schema.json": { schema: EvalProfileSchema, io: "input", title: "eval profile / experiment variant" },
  "eval-record.schema.json": { schema: EvalRecordSchema, io: "output", title: "eval result line (evals/results/<date>.jsonl)" },
  "verdict.schema.json": { schema: ExperimentVerdictSchema, io: "output", title: "factory experiment verdict" },
};

export function renderJsonSchema(name: string): string {
  const { schema, io, title } = JSON_SCHEMAS[name]!;
  const json = z.toJSONSchema(schema, { io, target: "draft-2020-12" }) as Record<string, unknown>;
  return JSON.stringify({ $id: `https://github.com/spignotti/factory/schemas/${name}`, title, ...json }, null, 2) + "\n";
}
