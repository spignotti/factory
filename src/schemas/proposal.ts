import { z } from "zod";
import { PlanSchema } from "./plan.js";
import { AuditTypeSchema, ImproveAspectSchema } from "./repo.js";

/**
 * Proposal contract. One `harden`, `audit` or `improve` aspect writes ONE ticket file with a ranked list
 * of up to `max_proposals` proposals; `adopt` writes a ticket with one (the baseline plan). The
 * ticket is `$FACTORY_HOME/memory/<repo>/proposals/<id>.json`; every proposal's plan sits next to it as
 * `<id>.<rank>.plan.json` (input for `factory run --plan`). `improve` also opens a GitHub issue per proposal.
 *
 * Lifecycle per proposal: `open` when written; the memory entries it references go `open → proposed`
 * (`ref` = the proposal id). A later improve that finds an open issue with the same marker updates this
 * record in place (id, plan path and run linkage stay). A merged factory PR makes it and its entries
 * `resolved`, including a PR that closes the proposal's issue no matter when the run started. An improve
 * issue closed without that PR, a closed unmerged PR, or no merged/open PR within `STALE_DAYS`, drops it
 * and puts its entries back to `open`.
 *
 * Audit tickets use the stem `<YYYY-MM-DD>-audit-<type>` and set `type`. Improve tickets use
 * `<YYYY-MM-DD>-improve-<aspect>` and set `aspect`.
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
    /** Set on improve proposals. */
    aspect: ImproveAspectSchema.optional(),
    /** Stable identity: `<aspect>:<sorted finding keys>`, or `<aspect>:<sha256 of sorted file paths>` when it resolves none. */
    key: z.string().min(1).optional(),
    /** GitHub issue opened for this proposal. Null until published; absent on older tickets. */
    issue: z.number().int().positive().nullable().optional(),
    plan: PlanSchema,
    plan_path: z.string(),
    /** Memory entry keys (`findings.json`) and checklist item texts the plan addresses. */
    references: z.object({ findings: z.array(z.string()), checklist: z.array(z.string()) }).strict(),
    resolution: z
      .object({
        at: z.string(),
        status: z.enum(["resolved", "dropped"]),
        reason: z.string(),
        run_id: z.string().nullable(),
        pr: z.string().nullable(),
        /** Present when a merged PR implemented the proposal. `confirmed` is the only proven effect. */
        effect: z.enum(["confirmed", "negative", "unclear"]).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const ProposalSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["harden", "adopt", "audit", "improve"]),
    /** File stem: `<YYYY-MM-DD>[-adopt|-audit-<type>|-improve-<aspect>][-n]`. */
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
    const aspects = new Set(t.proposals.map((p) => p.aspect));
    if (t.kind === "audit") {
      if (t.proposals.some((p) => p.type === undefined) || types.size !== 1) {
        ctx.addIssue({ code: "custom", message: "an audit ticket's proposals need one shared type" });
      }
    } else if ([...types].some((type) => type !== undefined)) {
      ctx.addIssue({ code: "custom", message: "type is only set on audit proposals" });
    }
    if (t.kind === "improve") {
      if (t.proposals.some((p) => p.aspect === undefined) || aspects.size !== 1) {
        ctx.addIssue({ code: "custom", message: "an improve ticket's proposals need one shared aspect" });
      }
    } else if ([...aspects].some((aspect) => aspect !== undefined)) {
      ctx.addIssue({ code: "custom", message: "aspect is only set on improve proposals" });
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
    lifecycle: z.array(z.object({ id: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), pr: z.string().nullable(), effect: z.enum(["confirmed", "negative", "unclear"]).optional() }).strict()),
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
    lifecycle: z.array(z.object({ id: z.string(), status: z.enum(["resolved", "dropped"]), reason: z.string(), pr: z.string().nullable(), effect: z.enum(["confirmed", "negative", "unclear"]).optional() }).strict()),
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

const LifecycleChangeSchema = z
  .object({
    id: z.string(),
    status: z.enum(["resolved", "dropped"]),
    reason: z.string(),
    pr: z.string().nullable(),
    effect: z.enum(["confirmed", "negative", "unclear"]).optional(),
  })
  .strict();

/** One GitHub issue written for an improve proposal. */
export const ImproveIssueSchema = z
  .object({
    proposal_id: z.string(),
    number: z.number().int().positive(),
    action: z.enum(["created", "updated"]),
  })
  .strict();
export type ImproveIssue = z.infer<typeof ImproveIssueSchema>;

export const ImproveAspectResultSchema = z
  .object({
    aspect: ImproveAspectSchema,
    signals: z.record(z.string(), z.unknown()),
    ticket: ProposalSchema.nullable(),
    path: z.string().nullable(),
    rejected: z.array(z.string()),
    issues: z.array(ImproveIssueSchema),
    error: z.string().nullable(),
  })
  .strict();
export type ImproveAspectResult = z.infer<typeof ImproveAspectResultSchema>;

/** `factory improve --json` (stdout). */
export const ImproveReportSchema = z
  .object({
    generated_at: z.string(),
    repo: z.string(),
    aspects: z.array(ImproveAspectSchema),
    warnings: z.array(z.string()),
    dry_run: z.boolean(),
    lifecycle: z.array(LifecycleChangeSchema),
    compaction: z.object({ merged: z.number().int(), error: z.string().nullable() }).strict(),
    results: z.array(ImproveAspectResultSchema),
    error: z.string().nullable(),
  })
  .strict();
export type ImproveReport = z.infer<typeof ImproveReportSchema>;
