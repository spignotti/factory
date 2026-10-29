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

const ServiceNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "service names use letters, digits, - and _");

/** A service a check needs (§6.12). Placeholders: `{run_id}`, `{port_offset}`, `{port:<name>}`, `{port:<number>}`. */
export const ServiceSchema = z.object({
  name: ServiceNameSchema,
  /** Started in the run worktree; in the sandbox it must stay in the foreground and listen on 0.0.0.0. */
  start: z.string().min(1),
  stop: z.string().optional(),
  /** Passed to the service and to every check that needs it. */
  env: z.record(z.string(), z.string()).default({}),
  /** Readiness command (exit 0 = ready); default: every port the service names accepts and holds a connection. */
  ready: z.string().optional(),
  ready_timeout_s: z.number().positive().default(120),
  /** Run on the host, outside the sandbox (e.g. Docker-based like `supabase start`). Residual risk, doctor warns. */
  host: z.boolean().default(false),
});
export type Service = z.infer<typeof ServiceSchema>;

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
  /** Pages of this area (paths under `ui.url`) screenshotted base vs HEAD when the area is touched. */
  pages: z.array(z.string()).default([]),
});

/** Default and upper bound of proposals per harden ticket (Amendment w). */
export const DEFAULT_MAX_PROPOSALS = 5;
export const MAX_PROPOSALS_LIMIT = 10;

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
      })
      .default({ max_rounds: 2, checklist: true, skip_paths: [], max_nits: 5 }),
    fast_lane: z.object({ max_diff_lines: z.number().int().min(1).default(150) }).default({ max_diff_lines: 150 }),
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
    services: z.array(ServiceSchema).default([]),
    ui: z
      .object({
        start: z.string().min(1),
        url: z.string().min(1),
        ready_timeout_s: z.number().positive().default(120),
        paths: z.array(z.string()).default([]),
        services: z.array(z.string()).default([]),
        // Amendment x (M4): Playwright device names the evaluator emulates on Chromium; the first one is
        // the LLM session's device. Mobile apps are evaluated through their web build (Expo / React
        // Native Web) with a phone device: viewport, user agent, touch.
        devices: z.array(z.string().min(1)).min(1).default(["Desktop Chrome"]),
        // Pages (paths under `url`) screenshotted base vs HEAD and checked for console/network errors.
        pages: z.array(z.string()).default(["/"]),
      })
      .loose()
      .optional(),
    verify: z
      .object({
        areas: z.array(VerifyAreaSchema).default([]),
        // Runs recorded flow files of affected areas; `{files}` = the flow paths. Default: `tests.run`.
        run: z.string().optional(),
      })
      .default({ areas: [] }),
    // Amendment w: ranked proposals per harden ticket (`--max` overrides).
    harden: z
      .object({ max_proposals: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).default(DEFAULT_MAX_PROPOSALS) })
      .default({ max_proposals: DEFAULT_MAX_PROPOSALS }),
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
    const services = new Set<string>();
    for (const svc of cfg.services) {
      if (svc.name === "ui") ctx.addIssue({ code: "custom", message: "service name ui is reserved for the ui app" });
      if (services.has(svc.name)) ctx.addIssue({ code: "custom", message: `duplicate service name: ${svc.name}` });
      services.add(svc.name);
    }
    const unknown = (where: string, list: string[] | undefined) => {
      for (const n of list ?? []) if (!services.has(n)) ctx.addIssue({ code: "custom", message: `${where}: unknown service ${n}` });
    };
    for (const check of cfg.checks) unknown(`check ${check.name}`, check.services);
    unknown("ui", cfg.ui?.services);
    for (const issue of placeholderIssues(cfg)) ctx.addIssue({ code: "custom", message: issue });
  });
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** Every text of repo.yaml that may carry service placeholders, with where it comes from. */
export function placeholderTexts(cfg: Pick<RepoConfig, "services" | "checks" | "ui"> & { verify?: { run?: string } }): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const s of cfg.services) {
    for (const [k, v] of Object.entries({ start: s.start, stop: s.stop, ready: s.ready })) if (v) out.push({ where: `service ${s.name} ${k}`, text: v });
    for (const [k, v] of Object.entries(s.env)) out.push({ where: `service ${s.name} env ${k}`, text: v });
  }
  for (const c of cfg.checks) out.push({ where: `check ${c.name}`, text: c.run });
  if (cfg.ui) out.push({ where: "ui start", text: cfg.ui.start }, { where: "ui url", text: cfg.ui.url });
  if (cfg.verify?.run) out.push({ where: "verify run", text: cfg.verify.run });
  return out;
}

/** Highest per-run port offset (§6.12 port scheme): numeric `{port:N}` must stay below 65536 with it. */
export const MAX_PORT_OFFSET = 9900;
export const MAX_NAMED_PORTS = 100;
const PLACEHOLDER = /\{(run_id|port_offset|port:[A-Za-z0-9_-]+)\}/g;

function placeholderIssues(cfg: Parameters<typeof placeholderTexts>[0]): string[] {
  const issues: string[] = [];
  const named = new Set<string>();
  for (const { where, text } of placeholderTexts(cfg)) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const ref = m[1]!;
      if (!ref.startsWith("port:")) continue;
      const arg = ref.slice(5);
      if (/^\d+$/.test(arg)) {
        const n = Number(arg);
        if (n < 1 || n + MAX_PORT_OFFSET > 65535) issues.push(`${where}: {port:${arg}} must be 1..${65535 - MAX_PORT_OFFSET}`);
      } else named.add(arg);
    }
  }
  if (named.size > MAX_NAMED_PORTS) issues.push(`more than ${MAX_NAMED_PORTS} named ports`);
  return issues;
}

export const REPO_CONFIG_PATH = ".factory/repo.yaml";

export function parseRepoConfig(text: string): RepoConfig {
  return RepoConfigSchema.parse(parse(text) ?? {});
}

export function loadRepoConfig(repoDir: string): RepoConfig {
  return parseRepoConfig(readFileSync(join(repoDir, REPO_CONFIG_PATH), "utf8"));
}
