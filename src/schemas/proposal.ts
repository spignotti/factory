import { z } from "zod";
import { PlanSchema } from "./plan.js";
import { AuditTypeSchema } from "./repo.js";

/**
 * Proposal contract. One `harden` or `audit` writes ONE ticket file with a ranked list
 * of up to `max_proposals` proposals; `adopt` writes a ticket with one (the baseline plan). The
 * ticket is `$FACTORY_HOME/memory/<repo>/proposals/<id>.json`; every proposal's plan sits next to it as
 * `<id>.<rank>.plan.json` (input for `factory run --plan`). The repo's bot decides what to do with them; each
 * proposal becomes its own factory run/PR and is tracked on its own.
 *
 * Lifecycle per proposal: `open` when written; the memory entries it references go `open → proposed`
 * (`ref` = the proposal id). A later `harden` or `audit` resolves it: a merged factory PR of it makes it and its
 * entries `resolved`; a closed unmerged PR, or no merged/open PR within `STALE_DAYS`, drops it and puts
 * its entries back to `open`, so they can be proposed again.
 *
 * Audit tickets use the stem `<YYYY-MM-DD>-audit-<type>` and set `type` on every proposal.
 */
export const ProposalStatusSchema = z.enum(["open", "resolved", "dropped"]);

export const ProposalItemSchema = z
  .object({
    /** 1 = most valuable. */
    rank: z.number().int().min(1),
    /** `<ticket id>.<rank>`; memory entries reference it in `ref`. */
    id: z.string().min(1),
    status: ProposalStatusSchema,
    rationale: z.string(),
    /** Set on audit proposals (`security`, `performance`, `refactor`, `simplify`). */
    type: AuditTypeSchema.optional(),
    plan: PlanSchema,
    plan_path: z.string(),
    /** Memory entry keys (`findings.json`) and checklist item texts the plan addresses. */
    references: z.object({ findings: z.array(z.string()), checklist: z.array(z.string()) }).strict(),
    resolution: z
      .object({ at: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), run_id: z.string().nullable(), pr: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const ProposalSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["harden", "adopt", "audit"]),
    /** File stem: `<YYYY-MM-DD>[-adopt|-audit-<type>][-n]`. */
    id: z.string().min(1),
    repo: z.string(),
    created_at: z.string(),
    /** Ranked, best first; ranks 1..n. */
    proposals: z.array(ProposalItemSchema).min(1),
    /** Signal summary the choice was made from (harden) or the detection summary (adopt). */
    signals: z.record(z.string(), z.unknown()),
    metrics: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const types = new Set(t.proposals.map((p) => p.type));
    if (t.kind === "audit") {
      if (t.proposals.some((p) => p.type === undefined) || types.size !== 1) {
        ctx.addIssue({ code: "custom", message: "an audit ticket's proposals need one shared type" });
      }
    } else if ([...types].some((type) => type !== undefined)) {
      ctx.addIssue({ code: "custom", message: "type is only set on audit proposals" });
    }
    t.proposals.forEach((p, i) => {
      if (p.rank !== i + 1) ctx.addIssue({ code: "custom", message: `proposal ${i + 1} has rank ${p.rank}` });
      if (p.id !== `${t.id}.${p.rank}`) ctx.addIssue({ code: "custom", message: `proposal id ${p.id} is not ${t.id}.${p.rank}` });
    });
  });
export type Proposal = z.infer<typeof ProposalSchema>;

export { DEFAULT_MAX_PROPOSALS, MAX_PROPOSALS_LIMIT } from "./repo.js";

/** A proposal without a merged or closed PR after this many days is dropped (entries reopen). */
export const STALE_DAYS = 28;

/** One line of `$FACTORY_HOME/memory/<repo>/metrics.jsonl`, one per `harden`. */
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
    /** Earlier proposals (ids `<ticket>.<rank>`) resolved or dropped by this run. */
    lifecycle: z.array(z.object({ id: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), pr: z.string().nullable() }).strict()),
    compaction: z.object({ merged: z.number().int(), error: z.string().nullable() }).strict(),
    signals: z.record(z.string(), z.unknown()),
    metrics: MetricsSchema,
    /** The ticket written by this run; null: no signals, or selection failed (`error`). */
    ticket: ProposalSchema.nullable(),
    path: z.string().nullable(),
    /** Proposals the model returned that stayed invalid after the retry (dropped, with the reason). */
    rejected: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();
export type HardenReport = z.infer<typeof HardenReportSchema>;

/** One open audit proposal, as `factory status` and `factory stats` list them. */
export const OpenAuditTicketSchema = z
  .object({
    repo: z.string(),
    id: z.string(),
    type: AuditTypeSchema,
    rank: z.number().int().min(1),
    goal: z.string(),
    plan_path: z.string(),
  })
  .strict();
export type OpenAuditTicket = z.infer<typeof OpenAuditTicketSchema>;

/** `factory audit --json` (stdout). */
export const AuditReportSchema = z
  .object({
    generated_at: z.string(),
    repo: z.string(),
    type: AuditTypeSchema,
    /** Earlier proposals (ids `<ticket>.<rank>`) resolved or dropped by this run. */
    lifecycle: z.array(z.object({ id: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), pr: z.string().nullable() }).strict()),
    /** Open findings, the latest metrics line, and (performance only) the CI audit. */
    signals: z.record(z.string(), z.unknown()),
    /** The ticket written by this run; null when the type is disabled or selection failed (`error`). */
    ticket: ProposalSchema.nullable(),
    path: z.string().nullable(),
    /** Proposals the model returned that stayed invalid after the retry (dropped, with the reason). */
    rejected: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();
export type AuditReport = z.infer<typeof AuditReportSchema>;
