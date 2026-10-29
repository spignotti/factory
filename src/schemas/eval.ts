import { z } from "zod";
import { RESULTS } from "../events.js";
import { ProfileLayerSchema } from "./profile.js";
import { RepoConfigSchema } from "./repo.js";

/** Full commit id: tasks are fetched by sha (`git fetch --depth 1 <repo> <sha>`), so no abbreviations. */
const Sha = z.string().regex(/^[0-9a-f]{40}$/, "a full 40-hex commit sha");
const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.startsWith("-"), "a relative path inside the repo");

/**
 * Eval task (`evals/tasks/<id>.yaml`). Beyond the basic format: `repo_config` (the repo.yaml the
 * run uses; public repos have none), `exclude` (setup artifacts kept out of diffs), `license` and
 * `source` (provenance; tasks are third-party code).
 */
export const EvalTaskSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._-]+$/),
    /** Clone URL (https) or a local path (tests). */
    repo: z.string().min(1),
    base: Sha,
    task: z.string().min(1),
    plan_effort: z.enum(["none", "medium", "high"]).default("medium"),
    hidden: z.object({
      /** Commit the hidden test files are copied from (fetched only after the run: agents never see it). */
      from_commit: Sha,
      paths: z.array(RelPath).min(1),
      /** Runs in the run's worktree after the copy; exit 0 = pass. */
      check: z.string().min(1),
    }),
    timeout_min: z.number().int().min(1).max(600).default(30),
    /** `.factory/repo.yaml` for the run, committed on top of `base`; else the repo's own file at `base`. */
    repo_config: z.record(z.string(), z.unknown()).optional(),
    /** Added to `.git/info/exclude` of the eval clone (setup output such as a venv). */
    exclude: z.array(z.string().min(1)).default([".venv/", "node_modules/"]),
    /** SPDX id of the task repo's license. */
    license: z.string().min(1),
    /** Where the task comes from, e.g. `SWE-bench Verified django__django-16485` or a PR URL. */
    source: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.repo_config) {
      const r = RepoConfigSchema.safeParse(t.repo_config);
      if (!r.success) {
        for (const i of r.error.issues) ctx.addIssue({ code: "custom", path: ["repo_config", ...i.path.map(String)], message: i.message });
      }
    }
  });
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/** Role prompts a variant may replace (`roles/<name>.md`). */
export const PROMPT_NAMES = [
  "plan",
  "plan_normalize",
  "implement",
  "pr_writer",
  "review-plan",
  "review-simplicity",
  "review-security",
  "review-checklist",
  "review-common",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

/**
 * Eval profile (`profiles/<name>.yaml` or a file): a model layer like `--profile` (roles, retry,
 * env; provider policy and sandbox stay with the user profile) plus role prompt replacements and
 * run flags. A variant for `factory experiment` is one of these.
 */
export const EvalProfileSchema = ProfileLayerSchema.omit({ providers: true, sandbox: true })
  .extend({
    description: z.string().optional(),
    /** Prompt name → file (relative to the profile file) replacing `roles/<name>.md`. */
    prompts: z.partialRecord(z.enum(PROMPT_NAMES), z.string().min(1)).optional(),
    flags: z
      .object({
        /** Overrides the lane of every task (default: standard). */
        lane: z.enum(["standard", "fast"]).optional(),
        /** Overrides each task's `plan_effort`. */
        plan_effort: z.enum(["none", "medium", "high"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvalProfile = z.infer<typeof EvalProfileSchema>;

const Usage = z.object({ role: z.string(), model: z.string(), calls: z.number().int(), errors: z.number().int(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), billing: z.enum(["subscription", "metered"]).optional() });

/** One line of `evals/results/<date>.jsonl`: one task × profile × repeat. */
export const EvalRecordSchema = z
  .object({
    version: z.literal(1),
    started_at: z.string(),
    task: z.string(),
    profile: z.string(),
    repeat: z.number().int().min(1),
    run_id: z.string().nullable(),
    /** Run result, or `error` when the harness failed (clone, setup, crash) before or around the run. */
    result: z.enum([...RESULTS, "error"]),
    reason: z.string(),
    hidden_pass: z.boolean(),
    hidden_output: z.string(),
    rounds: z.number().int().min(0),
    /** Red non-flaky checks over all gate runs of the run (base checks excluded). */
    gate_failures: z.number().int().min(0),
    /** Findings with severity `bug` raised by any reviewer. */
    bug_findings: z.number().int().min(0),
    /** Real findings: bug findings whose fix turned a check red → green. */
    real_findings: z.number().int().min(0),
    tokens_in: z.number().min(0),
    tokens_out: z.number().min(0),
    cost_usd: z.number().min(0),
    usage: z.array(Usage),
    wall_s: z.number().min(0),
    timed_out: z.boolean(),
  })
  .strict();
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

export const ProfileSummarySchema = z
  .object({
    profile: z.string(),
    runs: z.number().int(),
    passes: z.number().int(),
    pass_rate: z.number().nullable(),
    mean_cost_usd: z.number().nullable(),
    mean_tokens: z.number().nullable(),
    mean_wall_s: z.number().nullable(),
    mean_rounds: z.number().nullable(),
    gate_failures: z.number().int(),
    bug_findings: z.number().int(),
    real_findings: z.number().int(),
    errors: z.number().int(),
    /** Share of tasks whose repeats agree on hidden pass and result; null below 2 repeats. */
    determinism_ratio: z.number().nullable(),
  })
  .strict();
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

/** `factory experiment` output. */
export const VerdictSchema = z
  .object({
    version: z.literal(1),
    base: z.string(),
    variant: z.string(),
    tasks: z.array(z.string()),
    repeat: z.number().int().min(2),
    verdict: z.enum(["win", "loss", "tie"]),
    /** Which profile to keep: the variant only on a win (ties keep the simpler one, the base). */
    keep: z.enum(["base", "variant"]),
    reasons: z.array(z.string()),
    /** Which cost measure the rule compared (USD, or tokens when both sides report 0 USD). */
    cost_measure: z.enum(["usd", "tokens"]),
    summaries: z.object({ base: ProfileSummarySchema, variant: ProfileSummarySchema }).strict(),
    results_file: z.string().nullable(),
    table: z.string(),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;
