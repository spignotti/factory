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
