import { z } from "zod";
import { OpenAuditTicketSchema } from "./proposal.js";

/**
 * Output contracts of `status`, `stats`, `gc` and `doctor` (`--json`). Strict: a field added in code
 * without the schema fails the contract tests. JSON Schema copies live in `schemas/` (`pnpm schemas`).
 */
const nullableStr = z.string().nullable();

/** Latest provider-stream retry still in flight (`factory status`). */
const StepRetrySchema = z.strictObject({
  class: z.string(),
  attempt: z.number().int(),
  max: z.number().int(),
  package: z.string().nullable(),
});

export const StatusReportSchema = z.strictObject({
  generated_at: z.string(),
  running: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), step: z.string(), lane: z.enum(["standard", "fast"]),
      pid: z.number().int(), minutes: z.number(), branch: nullableStr, pr: nullableStr,
      /** Sandboxed check in flight (`null` when the run is not inside a check). */
      check: z.string().nullable(),
      /** Stream-abort retry of the current agent call (`null` once that call finished). */
      retry: StepRetrySchema.nullable(),
    }),
  ),
  waiting: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), result: z.enum(["needs_human", "needs_input"]), reason: z.string(),
      questions: z.array(z.string()), pr: nullableStr, branch: nullableStr, worktree: nullableStr,
    }),
  ),
  interrupted: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), task: z.string(), step: z.string() })),
  queued: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), holder_run_id: nullableStr, holder_pid: z.number().int().nullable(),
      minutes: z.number(),
    }),
  ),
  orphaned: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), task: z.string(), step: z.string() })),
  stalled: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), step: z.string(), lane: z.enum(["standard", "fast"]),
      pid: z.number().int(), minutes: z.number(), silent_minutes: z.number(), branch: nullableStr, pr: nullableStr,
      check: z.string().nullable(),
      retry: StepRetrySchema.nullable(),
    }),
  ),
  prs: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), pr: z.string(), state: z.enum(["open", "unknown"]), draft: z.boolean().nullable(),
      merge_policy: nullableStr, risk: nullableStr, result: nullableStr, error: z.string().optional(),
    }),
  ),
  /**
   * Open factory drafts whose newer of head commit time and `updatedAt` is at least
   * `limits.stale_draft_days` old, and whose branch no live run holds. They do not block the queue.
   * Close the PR or resume the run.
   */
  stale_drafts: z.array(
    z.strictObject({
      repo: z.string(),
      pr: z.number().int(),
      branch: z.string(),
      days_unchanged: z.number(),
    }),
  ),
  /** Open audit proposals, one row per proposal, across every repo in `$FACTORY_HOME`. */
  audit_tickets: z.array(OpenAuditTicketSchema),
  /**
   * Issue queues (`$FACTORY_HOME/queue`). Pending / running / parked counts and the next
   * non-done entries. Empty when no queue file exists.
   */
  queues: z.array(
    z.strictObject({
      repo: z.string(),
      pending: z.number().int().min(0),
      running: z.number().int().min(0),
      parked: z.number().int().min(0),
      next: z.array(
        z.strictObject({
          issue: z.number().int(),
          status: z.enum(["pending", "running", "parked"]),
          run_id: z.string().nullable(),
          reason: z.string().nullable(),
        }),
      ),
    }),
  ),
  /**
   * Finished runs in `factory status --since`. Null when the flag is omitted.
   * Built from `result.json` (mtime is the finish time) plus live PR state, not from `events.jsonl`.
   */
  since: z
    .strictObject({
      since: z.string(),
      from: z.string(),
      merged: z.array(
        z.strictObject({
          run_id: z.string(),
          repo: z.string(),
          task: z.string(),
          pr: z.string(),
          pr_state: z.enum(["merged", "closed"]),
          result: z.string(),
        }),
      ),
      /** Open, CI green, not behind or conflicting, `merge_policy` human_review. `none` and a missing rollup are not green. */
      human_review: z.array(
        z.strictObject({
          run_id: z.string(),
          repo: z.string(),
          task: z.string(),
          pr: z.string(),
          risk: z.enum(["low", "medium", "high"]).nullable(),
          /** `risk`, `diff size`, `protected paths`, plus the `risk_reasons` they came from. Not the review-exit `reason`. */
          review_reasons: z.array(z.string()),
        }),
      ),
      /**
       * Blocked by draft, CI, behind/conflicting, or a needs_human result.
       * A thrown `prStatus` is also here (`pr status unknown` plus `error`) and is not a confirmed open PR.
       */
      blocked: z.array(
        z.strictObject({
          run_id: z.string(),
          repo: z.string(),
          task: z.string(),
          pr: nullableStr,
          blockers: z.array(z.string()),
          reason: z.string(),
          /** `prStatus` failure text. Present only when the live state could not be read. */
          error: z.string().optional(),
        }),
      ),
      failed: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), task: z.string(), reason: z.string(), pr: nullableStr })),
      base_red: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), task: z.string(), reason: z.string() })),
      needs_input: z.array(
        z.strictObject({
          run_id: z.string(),
          repo: z.string(),
          task: z.string(),
          reason: z.string(),
          questions: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
});

const quantiles = z.strictObject({ median: z.number().nullable(), p90: z.number().nullable() });
const counts = z.record(z.string(), z.number().int());
const usage = { calls: z.number().int(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number() };

export const StatsPeriodSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  runs: z.number().int(),
  by_result: counts,
  by_lane: counts,
  by_type: counts,
  by_repo: counts,
  done_rate: z.number().min(0).max(1).nullable(),
  rounds: quantiles,
  minutes: quantiles,
  gate_failures: counts,
  flaky_checks: counts,
  reasons: z.array(z.strictObject({ result: z.string(), reason: z.string(), count: z.number().int() })),
  providers: z.record(
    z.string(),
    z.strictObject({ ...usage, billing: z.enum(["subscription", "metered"]), errors: z.number().int(), fallbacks: z.number().int(), capacity_errors: z.number().int(), limit_errors: z.number().int() }),
  ),
  roles: z.record(z.string(), z.strictObject(usage)),
  /** USD of metered providers only; subscription usage is counted in subscription_tokens. */
  cost_usd: z.number(),
  subscription_tokens: z.strictObject({ tokens_in: z.number(), tokens_out: z.number() }),
  lane_escalations: z.number().int(),
  watchdog_aborts: z.number().int(),
  merge_policy: counts,
  /**
   * Confirmed merges whose stored policy was `auto`. A delivered unmerged PR is not counted.
   * Older results without `outcome.merged: "confirmed"` stay out of this number.
   */
  auto_merged: z.number().int(),
  reverted: z.null(),
  /**
   * Separate outcome counters for the period. `*_unknown` counts runs that did not store the field.
   * An empty period is zeros, not unknowns. Attempts are a sum; the other known fields count runs.
   */
  outcomes: z.strictObject({
    tickets: z.number().int().min(0),
    tickets_unknown: z.number().int().min(0),
    attempts: z.number().int().min(0),
    attempts_unknown: z.number().int().min(0),
    delivered_prs: z.number().int().min(0),
    delivered_prs_unknown: z.number().int().min(0),
    confirmed_merges: z.number().int().min(0),
    merges_unknown: z.number().int().min(0),
    ended_without_merge: z.number().int().min(0),
    ended_without_merge_unknown: z.number().int().min(0),
    open_decisions: z.number().int().min(0),
    open_decisions_unknown: z.number().int().min(0),
  }),
});

export const StatsReportSchema = z.strictObject({
  generated_at: z.string(),
  since: z.string(),
  repo: nullableStr,
  current: StatsPeriodSchema,
  previous: StatsPeriodSchema,
  delta: z.strictObject({ runs: z.number().int(), done_rate: z.number().nullable(), cost_usd: z.number(), subscription_tokens: z.number(), median_rounds: z.number().nullable() }),
  /** Open audit proposals. With `--repo`, only that repository. */
  audit_tickets: z.array(OpenAuditTicketSchema),
});

export const GcReportSchema = z.strictObject({
  dry_run: z.boolean(),
  cleaned: z.array(
    z.strictObject({
      // pr_state "none": a run without a PR whose worktree went after the retention.
      run_id: z.string(), repo: z.string(), pr: nullableStr, pr_state: z.enum(["merged", "closed", "none"]),
      worktree_removed: z.boolean(), branch_deleted: z.boolean(), remote_branch_deleted: z.boolean(), notes: z.array(z.string()),
    }),
  ),
  skipped: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), pr: nullableStr, reason: z.string() })),
  // Terminal runs: dependency folders removed anywhere under the worktree.
  stripped: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), pr: nullableStr, removed: z.array(z.string()) })).default([]),
  // Evidence-branch retention per repository (folders removed, or why not).
  evidence: z.array(z.strictObject({ repo: z.string(), removed: z.array(z.string()), note: z.string().optional() })).default([]),
  // needs_input left unanswered for the working-day timeout: abandoned, lock released, worktree removed.
  abandoned: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), reason: z.string(), notified: z.boolean() })).default([]),
  /** Sandbox agent homes removed from terminal runs. */
  home_removed: z
    .array(z.strictObject({ run_id: z.string(), repo: z.string(), bytes: z.number().int().min(0), reason: z.string() }))
    .default([]),
  /** Published `evidence/` and `services/` logs removed from terminal runs (also on dry-run). */
  run_dirs_removed: z
    .array(z.strictObject({ run_id: z.string(), repo: z.string(), pr: nullableStr, removed: z.array(z.enum(["evidence/", "services/"])) }))
    .default([]),
  worktree_pruned: z.array(z.strictObject({ repo: z.string() })).default([]),
  log_path: z.string().optional(),
});

export const DoctorReportSchema = z.strictObject({
  ok: z.boolean(),
  checks: z.array(z.strictObject({ name: z.string(), status: z.enum(["ok", "warn", "fail", "info"]), detail: z.string() })),
  models: z.array(z.strictObject({ role: z.string(), models: z.array(z.string()), layer: z.string() })),
  providers: z.strictObject({ allow: z.array(z.string()), deny: z.array(z.string()) }).optional(),
  providers_in_use: z.array(z.string()),
});
