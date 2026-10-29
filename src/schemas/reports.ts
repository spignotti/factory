import { z } from "zod";

/**
 * Output contracts of `status`, `stats`, `gc` and `doctor` (`--json`). Strict: a field added in code
 * without the schema fails the contract tests. JSON Schema copies live in `schemas/` (`pnpm schemas`).
 */
const nullableStr = z.string().nullable();

export const StatusReportSchema = z.strictObject({
  generated_at: z.string(),
  running: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), step: z.string(), lane: z.enum(["standard", "fast"]),
      pid: z.number().int(), minutes: z.number(), branch: nullableStr, pr: nullableStr,
    }),
  ),
  waiting: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), result: z.enum(["needs_human", "needs_input"]), reason: z.string(),
      questions: z.array(z.string()), pr: nullableStr, branch: nullableStr, worktree: nullableStr,
    }),
  ),
  interrupted: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), task: z.string(), step: z.string() })),
  prs: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), task: z.string(), pr: z.string(), state: z.enum(["open", "unknown"]), draft: z.boolean().nullable(),
      merge_policy: nullableStr, risk: nullableStr, result: nullableStr, error: z.string().optional(),
    }),
  ),
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
  auto_merged: z.number().int(),
  reverted: z.null(),
});

export const StatsReportSchema = z.strictObject({
  generated_at: z.string(),
  since: z.string(),
  repo: nullableStr,
  current: StatsPeriodSchema,
  previous: StatsPeriodSchema,
  delta: z.strictObject({ runs: z.number().int(), done_rate: z.number().nullable(), cost_usd: z.number(), subscription_tokens: z.number(), median_rounds: z.number().nullable() }),
});

export const GcReportSchema = z.strictObject({
  dry_run: z.boolean(),
  cleaned: z.array(
    z.strictObject({
      run_id: z.string(), repo: z.string(), pr: z.string(), pr_state: z.enum(["merged", "closed"]),
      worktree_removed: z.boolean(), branch_deleted: z.boolean(), remote_branch_deleted: z.boolean(), notes: z.array(z.string()),
    }),
  ),
  skipped: z.array(z.strictObject({ run_id: z.string(), repo: z.string(), pr: nullableStr, reason: z.string() })),
  // Amendment x: evidence-branch retention per repository (folders removed, or why not).
  evidence: z.array(z.strictObject({ repo: z.string(), removed: z.array(z.string()), note: z.string().optional() })).default([]),
});

export const DoctorReportSchema = z.strictObject({
  ok: z.boolean(),
  checks: z.array(z.strictObject({ name: z.string(), status: z.enum(["ok", "warn", "fail", "info"]), detail: z.string() })),
  models: z.array(z.strictObject({ role: z.string(), models: z.array(z.string()), layer: z.string() })),
  providers: z.strictObject({ allow: z.array(z.string()), deny: z.array(z.string()) }).optional(),
  providers_in_use: z.array(z.string()),
});
