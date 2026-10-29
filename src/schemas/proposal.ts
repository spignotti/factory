import { z } from "zod";
import { PlanSchema } from "./plan.js";

/**
 * Proposal contract (SPEC §11, §12): at most one per `harden`, one per `adopt` (the baseline plan).
 * Written to `$FACTORY_HOME/memory/<repo>/proposals/<id>.json` with its plan next to it as
 * `<id>.plan.json` (input for `factory run --plan`). GrokBot decides what to do with it.
 *
 * Lifecycle: the proposal is `open` when written. The memory entries it references go `open → proposed`.
 * A later `harden` resolves it: a merged factory PR whose plan lists the entries in `resolves_findings`
 * makes them `resolved` (proposal `resolved`); a closed unmerged PR, or no run within `STALE_DAYS`,
 * puts them back to `open` (proposal `dropped`), so they can be proposed again.
 */
export const ProposalStatusSchema = z.enum(["open", "resolved", "dropped"]);

export const ProposalSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["harden", "adopt"]),
    /** File stem: `<YYYY-MM-DD>[-adopt][-n]`. */
    id: z.string().min(1),
    repo: z.string(),
    created_at: z.string(),
    status: ProposalStatusSchema,
    rationale: z.string(),
    plan: PlanSchema,
    plan_path: z.string(),
    /** Memory entry keys (`findings.json`) and checklist item texts the plan addresses. */
    references: z.object({ findings: z.array(z.string()), checklist: z.array(z.string()) }).strict(),
    /** Signal summary the choice was made from (harden) or the detection summary (adopt). */
    signals: z.record(z.string(), z.unknown()),
    metrics: z.record(z.string(), z.unknown()).nullable(),
    resolution: z
      .object({ at: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), run_id: z.string().nullable(), pr: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

/** A proposal without a merged or closed PR after this many days is dropped (entries reopen). */
export const STALE_DAYS = 28;

/** One line of `$FACTORY_HOME/memory/<repo>/metrics.jsonl` (SPEC §11 step 2), one per `harden`. */
export const MetricsSchema = z
  .object({
    ts: z.string(),
    repo: z.string(),
    /** Deterministic checks / (checks + unmarked checklist items + open checkable findings); null with nothing to count. */
    determinism_ratio: z.number().min(0).max(1).nullable(),
    deterministic_checks: z.number().int(),
    llm_verified_items: z.number().int(),
    open_findings: z.number().int(),
    ci_minutes_per_week: z.number().nullable(),
    flaky_rate: z.number().nullable(),
    done_rate: z.number().nullable(),
    median_rounds: z.number().nullable(),
    /** Reverted factory PRs / factory PRs of the window; null without factory PRs. */
    revert_rate: z.number().nullable(),
  })
  .strict();
export type Metrics = z.infer<typeof MetricsSchema>;

/** `factory harden --json` (stdout). */
export const HardenReportSchema = z
  .object({
    generated_at: z.string(),
    repo: z.string(),
    /** Earlier proposals resolved or dropped by this run. */
    lifecycle: z.array(z.object({ id: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), pr: z.string().nullable() }).strict()),
    compaction: z.object({ merged: z.number().int(), error: z.string().nullable() }).strict(),
    signals: z.record(z.string(), z.unknown()),
    metrics: MetricsSchema,
    /** null: no signals, or selection failed (`error`). */
    proposal: ProposalSchema.nullable(),
    path: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type HardenReport = z.infer<typeof HardenReportSchema>;
