import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RoleOverridesSchema } from "./profile.js";

export const TierSchema = z.enum(["fast", "full", "manual"]);
export type Tier = z.infer<typeof TierSchema>;

export const CheckSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  tier: TierSchema,
  paths: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

// Amendment a: `auto` is only reachable through `auto_merge_max_risk`, so the per-risk map holds the
// non-auto policies only.
const NonAutoPolicySchema = z.enum(["bot_review", "human_review"]);

const VerifyAreaSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string()).default([]),
  guide: z.string().optional(),
  flows: z.array(z.string()).default([]),
});

export const RepoConfigSchema = z
  .object({
    base_branch: z.string().default("main"),
    setup: z.string().default(""),
    checks: z.array(CheckSchema).default([]),
    env_command: z.string().default(""),
    tests: z
      .object({
        globs: z.array(z.string()).default([]),
        // Command that runs specific test files; `{files}` is replaced by the space-separated paths.
        // Used for the red-green proof of bug plans.
        run: z.string().optional(),
      })
      .default({ globs: [] }),
    sensitive_paths: z.array(z.string()).default([]),
    human_only_paths: z.array(z.string()).default([]),
    review: z
      .object({
        max_rounds: z.number().int().min(1).default(2),
        checklist: z.boolean().default(true),
        skip_paths: z.array(z.string()).default([]),
        max_nits: z.number().int().min(0).default(5),
        per_package: z.boolean().default(false),
      })
      .default({ max_rounds: 2, checklist: true, skip_paths: [], max_nits: 5, per_package: false }),
    merge: z
      .object({
        auto_merge_max_risk: z.enum(["none", "low", "medium"]).default("none"),
        policy: z
          .object({
            low: NonAutoPolicySchema.default("human_review"),
            medium: NonAutoPolicySchema.default("human_review"),
            high: z.literal("human_review").default("human_review"),
          })
          .default({ low: "human_review", medium: "human_review", high: "human_review" }),
        low_max_diff_lines: z.number().int().min(0).default(300),
      })
      .default({
        auto_merge_max_risk: "none",
        policy: { low: "human_review", medium: "human_review", high: "human_review" },
        low_max_diff_lines: 300,
      }),
    limits: z
      .object({
        max_diff_lines: z.number().int().min(1).default(1500),
        max_wall_minutes: z.number().positive().default(90),
        stall_minutes: z.number().positive().default(15),
        forbidden_paths: z.array(z.string()).default([]),
      })
      .default({ max_diff_lines: 1500, max_wall_minutes: 90, stall_minutes: 15, forbidden_paths: [] }),
    ui: z.object({ start: z.string(), url: z.string(), paths: z.array(z.string()).default([]) }).loose().optional(),
    verify: z.object({ areas: z.array(VerifyAreaSchema).default([]) }).default({ areas: [] }),
    git: z
      .object({ author: z.string().default("factory"), email: z.string().optional() })
      .default({ author: "factory" }),
    // Names of extra environment variables passed to agent tool processes and checks (Amendment b).
    agent_env: z.array(z.string()).default([]),
    // Per-repo model overrides, role → chain (Amendment i); validated again after the merge.
    models: RoleOverridesSchema.optional(),
  })
  .loose()
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    for (const check of cfg.checks) {
      if (names.has(check.name)) ctx.addIssue({ code: "custom", message: `duplicate check name: ${check.name}` });
      names.add(check.name);
    }
  });
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const REPO_CONFIG_PATH = ".factory/repo.yaml";

export function parseRepoConfig(text: string): RepoConfig {
  return RepoConfigSchema.parse(parse(text) ?? {});
}

export function loadRepoConfig(repoDir: string): RepoConfig {
  return parseRepoConfig(readFileSync(join(repoDir, REPO_CONFIG_PATH), "utf8"));
}
