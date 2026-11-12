import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** `diff_exclude` globs that would switch the diff limits off entirely. */
const CATCH_ALL = new Set(["*", "**", "**/*", "**/**", "*/**"]);
import { DocsLookupSchema, RoleOverridesSchema, THINKING_LEVELS } from "./profile.js";

/** Actions `runs-on` label. No `${{ }}`: the value is pasted into the workflow. */
export const CI_RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_CI_RUNNER = "ubuntu-latest";

export const TierSchema = z.enum(["fast", "full", "manual"]);
export type Tier = z.infer<typeof TierSchema>;

export const CheckSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  tier: TierSchema,
  /**
   * Wall-clock cap in seconds. Overrides `timeout_minutes` and `limits.gate_timeout_minutes`.
   * The process tree is killed and the check is `timeout`, not a pass.
   */
  timeout_s: z.number().positive().optional(),
  /** Killed after this many minutes when `timeout_s` is unset (default `limits.gate_timeout_minutes`). */
  timeout_minutes: z.number().positive().optional(),
  paths: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  /**
   * Runs only in factory runs and local `factory gates`, never in CI (`gates --select` drops it when `CI`
   * is set): for checks that need a host-side stack CI does not have. Setting it is a loosening (config_guard).
   */
  local_only: z.boolean().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

/**
 * A justified gap against the tool baseline. Adding an entry is a loosening (config_guard): the
 * reason is required so a silent ignore cannot land in a factory PR.
 */
export const ToolExceptionSchema = z
  .object({
    tool: z.string().trim().min(1),
    rule: z.string().trim().min(1),
    reason: z.string().trim().min(1, "tool_exceptions.reason is required"),
  })
  .strict();
export type ToolException = z.infer<typeof ToolExceptionSchema>;

const ServiceNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "service names use letters, digits, - and _");

/** A service a check needs. Placeholders: `{run_id}`, `{port_offset}`, `{port:<name>}`, `{port:<number>}`. */
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
  /**
   * `host: true` only: fixed host loopback ports the service listens on (e.g. a Docker stack with ports from
   * its own config). Checks that need the service reach exactly these ports through the sandbox; the ready
   * probe waits on them. Not shifted per run: one instance per box (a claim under `$FACTORY_HOME/ports/`).
   */
  ports: z.array(z.number().int().min(1).max(65535)).optional(),
  /**
   * `host: true` only: after the service is ready, `command` runs on the host and prints `KEY=VALUE` lines
   * (dotenv); `map` is target env name → printed key. The values go only to the checks (and recorded flows)
   * that need the service, never to agents, and are redacted like secrets.
   */
  env_from: z
    .object({
      command: z.string().min(1),
      map: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names use letters, digits and _"), z.string().min(1)).refine((m) => Object.keys(m).length > 0, "env_from.map needs at least one entry"),
    })
    .strict()
    .optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

// `auto` is only reachable through `auto_merge_max_risk`, so the per-risk map holds the
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

const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names use letters, digits and _");
/** Names a secrets provider may not set: the factory controls them for every command. */
export const RESERVED_SECRET_NAMES = ["PATH", "HOME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GH_CONFIG_DIR"];
const SecretNamesSchema = z
  .array(EnvNameSchema)
  .min(1)
  .refine((names) => names.every((n) => !RESERVED_SECRET_NAMES.includes(n)), { message: `secrets.names may not include ${RESERVED_SECRET_NAMES.join(", ")}` });

/**
 * Per-repo secrets for checks, services and the evaluated app (never agents). `env_file`: a dotenv file
 * outside the repo [`$FACTORY_HOME/secrets/<repo name>.env`, the repo name from the origin URL]. `command`: a wrapper prefix that runs a
 * command with the secrets in its env (e.g. a secrets manager CLI); `credentials` is a dotenv file with the
 * wrapper's own auth variables, passed only to the wrapper.
 */
export const SecretsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("env_file"), path: z.string().min(1).optional(), names: SecretNamesSchema }).strict(),
  z.object({ provider: z.literal("command"), command: z.string().min(1), credentials: z.string().min(1).optional(), names: SecretNamesSchema }).strict(),
]);
export type SecretsConfig = z.infer<typeof SecretsSchema>;

/** Default and upper bound of proposals per harden or audit ticket. */
export const DEFAULT_MAX_PROPOSALS = 5;
export const MAX_PROPOSALS_LIMIT = 10;

/** Dimensions `factory audit` can judge. A repo enables a subset in `audit.types`. */
export const AUDIT_TYPES = ["security", "performance", "refactor", "simplify"] as const;
export const AuditTypeSchema = z.enum(AUDIT_TYPES);
export type AuditType = z.infer<typeof AuditTypeSchema>;

/**
 * Aspects `factory improve` runs. `refactor` and `simplify` are one aspect (`structure`).
 * `ci` and `tests` are signal functions plus `roles/improve-<aspect>.md` (same proposal flow).
 */
export const IMPROVE_ASPECTS = ["findings", "security", "performance", "structure", "ci", "tests"] as const;
export const ImproveAspectSchema = z.enum(IMPROVE_ASPECTS);
export type ImproveAspect = z.infer<typeof ImproveAspectSchema>;

/** Reasoning level per aspect when `improve.thinking` omits a key. */
export const DEFAULT_IMPROVE_THINKING = {
  findings: "medium",
  security: "high",
  performance: "high",
  structure: "medium",
  ci: "high",
  tests: "medium",
} as const;

/** Reasoning level per audit type when `audit.thinking` omits a key. */
export const DEFAULT_AUDIT_THINKING = {
  security: "high",
  performance: "high",
  refactor: "medium",
  simplify: "medium",
} as const;

const AuditThinkingSchema = z
  .object({
    security: z.enum(THINKING_LEVELS).default(DEFAULT_AUDIT_THINKING.security),
    performance: z.enum(THINKING_LEVELS).default(DEFAULT_AUDIT_THINKING.performance),
    refactor: z.enum(THINKING_LEVELS).default(DEFAULT_AUDIT_THINKING.refactor),
    simplify: z.enum(THINKING_LEVELS).default(DEFAULT_AUDIT_THINKING.simplify),
  })
  .strict()
  .default({ ...DEFAULT_AUDIT_THINKING });

/** Upper bound of one `audit.focus.<type>` note, after a bullet list is joined. */
export const AUDIT_FOCUS_MAX = 2_000;

/**
 * `audit.focus.<type>`: a short string, or a list of bullet points joined into one.
 * Empty and unknown keys are rejected. The result is what that type's prompt receives.
 */
function auditFocusText(v: unknown): unknown {
  if (typeof v === "string") return v.trim();
  if (!Array.isArray(v)) return v;
  const lines: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return v;
    const text = item.trim();
    if (!text) return v;
    lines.push(text.startsWith("- ") ? text : `- ${text}`);
  }
  return lines.join("\n");
}

const FocusNoteSchema = z.preprocess(auditFocusText, z.string().min(1).max(AUDIT_FOCUS_MAX));
const AuditFocusTextSchema = FocusNoteSchema;

const AuditFocusSchema = z
  .object({
    security: AuditFocusTextSchema.optional(),
    performance: AuditFocusTextSchema.optional(),
    refactor: AuditFocusTextSchema.optional(),
    simplify: AuditFocusTextSchema.optional(),
  })
  .strict()
  .default({});

const ImproveThinkingSchema = z
  .object({
    findings: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.findings),
    security: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.security),
    performance: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.performance),
    structure: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.structure),
    ci: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.ci),
    tests: z.enum(THINKING_LEVELS).default(DEFAULT_IMPROVE_THINKING.tests),
  })
  .strict()
  .default({ ...DEFAULT_IMPROVE_THINKING });

const ImproveFocusSchema = z
  .object({
    findings: FocusNoteSchema.optional(),
    security: FocusNoteSchema.optional(),
    performance: FocusNoteSchema.optional(),
    structure: FocusNoteSchema.optional(),
    ci: FocusNoteSchema.optional(),
    tests: FocusNoteSchema.optional(),
  })
  .strict()
  .default({});

/** `improve:` in repo.yaml. Absent: `harden:` and `audit:` are a deprecated fallback, not this default. */
export const ImproveConfigSchema = z
  .object({
    aspects: z.array(ImproveAspectSchema).min(1),
    max_proposals: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).default(DEFAULT_MAX_PROPOSALS),
    thinking: ImproveThinkingSchema,
    focus: ImproveFocusSchema,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (new Set(cfg.aspects).size !== cfg.aspects.length) ctx.addIssue({ code: "custom", message: "improve.aspects has a duplicate" });
  });
export type ImproveConfig = z.infer<typeof ImproveConfigSchema>;

const ToolchainVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._*/+-]{0,39}$/, "toolchain versions use letters, digits and . _ * / + -");

/**
 * Toolchains the CI stub installs before the checks (`factory gates --toolchains`). Unset: detected from
 * the repo's files. `true` = install (default version), `false` = never, a string = that version.
 */
export const CiToolchainsSchema = z
  .object({
    node: ToolchainVersionSchema.optional(),
    python: z.union([ToolchainVersionSchema, z.literal(false)]).optional(),
    pnpm: z.union([ToolchainVersionSchema, z.boolean()]).optional(),
    uv: z.union([ToolchainVersionSchema, z.boolean()]).optional(),
  })
  .strict();

const SelectorSchema = z.string().refine((s) => s.trim().length > 0, "selector is empty");

/**
 * A credential is a name, never an inline value. `secret` is resolved by the repo's secrets provider;
 * `env` is a `NAME=value` line printed by `ui.auth.setup`.
 */
const AuthCredentialSchema = z.union(
  [z.object({ secret: EnvNameSchema }).strict(), z.object({ env: EnvNameSchema }).strict()],
  "credential must be { secret: NAME } or { env: NAME }, not an inline value",
);

const AuthSuccessSchema = z.union(
  [
    z
      .object({
        url: z.string().refine((s) => (s.startsWith("/") && !s.startsWith("//")) || s.includes("*"), "success url is a path (/dashboard) or a glob (**/dashboard)"),
      })
      .strict(),
    z.object({ selector: SelectorSchema }).strict(),
  ],
  "success check is { url } or { selector }",
);

/**
 * Deterministic login before the evaluator's browser session. Playwright fills the form; the model
 * never sees the password. `setup` (seed a test user, for example) runs first and is required when a
 * credential comes from its env.
 */
export const UiAuthSchema = z
  .object({
    login_path: z.string().regex(/^\/(?!\/)/, "login_path is a path on the app (starts with /)"),
    fields: z
      .object({
        user: SelectorSchema,
        password: SelectorSchema,
        submit: SelectorSchema,
      })
      .strict(),
    success: AuthSuccessSchema,
    credentials: z
      .object({
        user: AuthCredentialSchema,
        password: AuthCredentialSchema,
      })
      .strict(),
    setup: z
      .string()
      .refine((s) => s.trim().length > 0, "setup is empty")
      .optional(),
  })
  .strict()
  .superRefine((auth, ctx) => {
    const needsSetup = [auth.credentials.user, auth.credentials.password].some((c) => "env" in c);
    if (needsSetup && !auth.setup) ctx.addIssue({ code: "custom", path: ["setup"], message: "credentials from a setup env need setup" });
  });
export type UiAuth = z.infer<typeof UiAuthSchema>;

export const RepoConfigSchema = z
  .object({
    base_branch: z.string().default("main"),
    setup: z.string().default(""),
    checks: z.array(CheckSchema).default([]),
    /**
     * Justified gaps against the central tool baseline (`templates/baseline/`). `reason` is required.
     * Adding an entry is a loosening (config_guard).
     */
    tool_exceptions: z.array(ToolExceptionSchema).default([]),
    /**
     * `require_tools`: a baseline scanner that is not on PATH fails the gate instead of skipping.
     * Default false (a visible skip). Turning it off is a loosening (config_guard).
     */
    baseline: z
      .object({
        require_tools: z.boolean().default(false),
      })
      .strict()
      .default({ require_tools: false }),
    env_command: z.string().default(""),
    tests: z
      .object({
        globs: z.array(z.string()).default([]),
        // Command that runs specific test files; `{files}` is replaced by the space-separated paths.
        // Used for the red-green proof of bug plans.
        run: z.string().optional(),
        /**
         * Wall-clock cap for that command (base worktree and HEAD). Unset uses
         * `limits.gate_timeout_minutes`. A timeout on base is inconclusive, not a red repro.
         */
        timeout_s: z.number().positive().optional(),
        /**
         * Command that writes a coverage report (`coverage json`, vitest/jest `--coverage`, lcov).
         * Optional. `factory improve --aspect tests` reads it for uncovered critical paths.
         */
        coverage: z.string().trim().min(1).optional(),
      })
      .default({ globs: [] }),
    sensitive_paths: z.array(z.string()).default([]),
    human_only_paths: z.array(z.string()).default([]),
    review: z
      .object({
        max_rounds: z.number().int().min(1).default(2),
        /** Unmarked `.factory/standards.md` rules get the standards reviewer. Turning it off is a loosening. */
        checklist: z.boolean().default(true),
        skip_paths: z.array(z.string()).default([]),
        max_nits: z.number().int().min(0).default(5),
      })
      .default({ max_rounds: 2, checklist: true, skip_paths: [], max_nits: 5 }),
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
        max_wall_minutes: z.number().positive().default(240),
        stall_minutes: z.number().positive().default(15),
        // Per agent bash command: killed after this, the model gets "Command timed out" and goes on.
        // Below stall_minutes, so a hung command (dev server, watch mode) ends before the watchdog.
        command_timeout_minutes: z.number().positive().default(10),
        // Per gate check, base check and red-green proof: killed after this (600s) unless the check
        // sets timeout_s or timeout_minutes. Capped by the remaining wall budget.
        gate_timeout_minutes: z.number().positive().default(10),
        // CI on the base commit still running at the base check: wait up to this long for it to settle
        // (0 = no wait). Only red, or still pending after the wait, ends the run as base_red.
        base_ci_wait_minutes: z.number().min(0).max(120).default(20),
        // After a GitHub-CI base_red, resume the same run once that commit is green, for this many hours
        // (0 = do not resume). Checked by `factory gc` and at the start of `factory run`.
        base_red_resume_hours: z.number().min(0).max(168).default(48),
        // CI on the PR head after finalize pushes: none and pending are polled this long
        // (0 = one sample). Still none or pending does not fail the run and does not enable
        // auto-merge (an auto policy becomes human_review). Only green enables auto-merge.
        // Red ends the run as needs_human and marks the PR draft again.
        pr_ci_wait_minutes: z.number().min(0).max(120).default(20),
        forbidden_paths: z.array(z.string()).default([]),
        // Generated paths left out of the diff line limits (lockfiles and binaries already are).
        // Test files (`tests.globs`) always count; adding an entry is a loosening (config_guard).
        diff_exclude: z
          .array(z.string().min(1).refine((g) => !CATCH_ALL.has(g.replace(/^\.\//, "")), "diff_exclude must not match every file"))
          .default([]),
        // When false, files matching `tests.globs` (the test-gate classification) are left out of
        // `max_diff_lines` only. The merge line limit still counts them. Default true.
        // Turning it off is a loosening (config_guard).
        diff_count_tests: z.boolean().default(true),
        // Same-model retries after a provider stream abort (the current agent call only; earlier
        // packages stay). 0 disables. Auth, quota and invalid output are not retried this way.
        stream_retries: z.number().int().min(0).max(5).default(2),
        // Progress warning when one agent call's tokens_in reaches this. Does not fail the call.
        // 0 disables. A multi-million-token step is a common partner of a stream abort.
        step_token_warn: z.number().int().min(0).default(1_000_000),
        // Open factory drafts do not block another run once the newer of the head commit time and
        // PR updatedAt is this many days old, unless a live run still holds that branch. 0 disables.
        stale_draft_days: z.number().int().min(0).max(365).default(3),
      })
      .default({
        max_diff_lines: 1500,
        max_wall_minutes: 240,
        stall_minutes: 15,
        command_timeout_minutes: 10,
        gate_timeout_minutes: 10,
        base_ci_wait_minutes: 20,
        base_red_resume_hours: 48,
        pr_ci_wait_minutes: 20,
        forbidden_paths: [],
        diff_exclude: [],
        diff_count_tests: true,
        stream_retries: 2,
        step_token_warn: 1_000_000,
        stale_draft_days: 3,
      }),
    services: z.array(ServiceSchema).default([]),
    ui: z
      .object({
        start: z.string().min(1),
        url: z.string().min(1),
        ready_timeout_s: z.number().positive().default(120),
        paths: z.array(z.string()).default([]),
        services: z.array(z.string()).default([]),
        // Playwright device names the evaluator emulates on Chromium; the first one is
        // the LLM session's device. Mobile apps are evaluated through their web build (Expo / React
        // Native Web) with a phone device: viewport, user agent, touch.
        devices: z.array(z.string().min(1)).min(1).default(["Desktop Chrome"]),
        // Pages (paths under `url`) screenshotted base vs HEAD and checked for console/network errors.
        pages: z.array(z.string()).default(["/"]),
        // Playwright logs in before the evaluator session. Strict: a typo or an inline password fails the config.
        auth: UiAuthSchema.optional(),
      })
      // Unknown ui keys stay tolerated; `auth` itself is strict.
      .loose()
      .optional(),
    verify: z
      .object({
        areas: z.array(VerifyAreaSchema).default([]),
        // Runs recorded flow files of affected areas; `{files}` = the flow paths. Default: `tests.run`.
        run: z.string().optional(),
      })
      .default({ areas: [] }),
    // Deprecated: `factory harden` reads this only when `improve:` is absent.
    harden: z
      .object({ max_proposals: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).default(DEFAULT_MAX_PROPOSALS) })
      .default({ max_proposals: DEFAULT_MAX_PROPOSALS }),
    /**
     * `factory audit`. Absent (the default): no types are enabled and the command refuses without a model call.
     * `thinking` overrides the role chain's thinking level for that type. `--max` overrides `max_proposals`.
     * `focus.<type>` is an optional note injected only into that type's prompt. No secrets or customer data.
     * Deprecated: read only when `improve:` is absent (`refactor` and `simplify` map to `structure`).
     */
    audit: z
      .object({
        types: z.array(AuditTypeSchema).default([]),
        max_proposals: z.number().int().min(1).max(MAX_PROPOSALS_LIMIT).default(DEFAULT_MAX_PROPOSALS),
        thinking: AuditThinkingSchema,
        focus: AuditFocusSchema,
      })
      .strict()
      .default({ types: [], max_proposals: DEFAULT_MAX_PROPOSALS, thinking: { ...DEFAULT_AUDIT_THINKING }, focus: {} }),
    /**
     * `factory improve`. Absent: `harden:` and `audit:` are still read, with a deprecation warning.
     * Without `--aspect`, every listed aspect runs. `thinking` replaces that aspect's chain level.
     * `focus.<aspect>` is an optional note for that aspect's prompt only. No secrets or customer data.
     */
    improve: ImproveConfigSchema.optional(),
    git: z
      .object({ author: z.string().default("factory"), email: z.string().optional() })
      .default({ author: "factory" }),
    // Names of extra environment variables passed to agent tool processes and checks.
    agent_env: z.array(z.string()).default([]),
    // Secrets for checks, services and the ui app; never for agents.
    secrets: SecretsSchema.optional(),
    // Agent steps with the `docs_lookup` tool for this repo; replaces the profile's list.
    docs_lookup: DocsLookupSchema.optional(),
    // CI stub. `runner` is the Actions `runs-on` label, pasted into the workflow (no expressions).
    // Unset means ubuntu-latest. `toolchains` are what the stub installs; unset fields are detected.
    ci: z
      .object({
        runner: z.string().regex(CI_RUNNER_LABEL).optional(),
        toolchains: CiToolchainsSchema.optional(),
      })
      .strict()
      .optional(),
    // Per-repo model overrides, role → chain; validated again after the merge.
    models: RoleOverridesSchema.optional(),
    /**
     * How many factory runs may hold this repo at once. Default 1 keeps the single-run lock.
     * `exclusive_paths`: a plan that touches any of these globs runs alone (database migrations).
     * Read from the checkout's repo.yaml at the start of the run. Raising `max_runs` or removing
     * an exclusive path is a loosening (config_guard).
     */
    concurrency: z
      .object({
        max_runs: z.number().int().min(1).max(32).default(1),
        exclusive_paths: z.array(z.string().min(1)).default([]),
      })
      .default({ max_runs: 1, exclusive_paths: [] }),
    /**
     * PR body options. `host_steps_section` is the heading for manual production-host commands
     * (for example "Mac install steps"). Unset: the section is omitted. Read from the base commit.
     */
    pr: z
      .object({
        host_steps_section: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[^#\n\r]+$/, "pr.host_steps_section is a heading, without # or newlines")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .loose()
  .superRefine((cfg, ctx) => {
    const exceptions = new Set<string>();
    for (const entry of cfg.tool_exceptions) {
      const key = `${entry.tool} ${entry.rule}`;
      if (exceptions.has(key)) ctx.addIssue({ code: "custom", message: `duplicate tool exception: ${key}` });
      exceptions.add(key);
    }
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
      if (!svc.host && svc.ports) ctx.addIssue({ code: "custom", message: `service ${svc.name}: ports needs host: true (sandboxed services use {port:…} placeholders)` });
      if (!svc.host && svc.env_from) ctx.addIssue({ code: "custom", message: `service ${svc.name}: env_from needs host: true` });
      for (const name of Object.keys(svc.env_from?.map ?? {})) {
        if (RESERVED_SECRET_NAMES.includes(name)) ctx.addIssue({ code: "custom", message: `service ${svc.name}: env_from.map may not set ${name}` });
        if (cfg.agent_env.includes(name)) ctx.addIssue({ code: "custom", message: `service ${svc.name}: env_from.map sets ${name}, which agent_env passes to agents` });
      }
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
  if (cfg.ui?.auth?.setup) out.push({ where: "ui auth setup", text: cfg.ui.auth.setup });
  if (cfg.verify?.run) out.push({ where: "verify run", text: cfg.verify.run });
  return out;
}

/** Highest per-run port offset (port scheme): numeric `{port:N}` must stay below 65536 with it. */
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

/** True when the file still has a `fast_lane:` block. It parses and is ignored. */
export function repoConfigHasFastLane(text: string): boolean {
  const raw = parse(text);
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "fast_lane");
}

export function parseRepoConfig(text: string): RepoConfig {
  const cfg = RepoConfigSchema.parse(parse(text) ?? {});
  // `.loose()` keeps unknown keys; drop the removed block so nothing reads it.
  delete (cfg as { fast_lane?: unknown }).fast_lane;
  return cfg;
}

export function loadRepoConfig(repoDir: string): RepoConfig {
  return parseRepoConfig(readFileSync(join(repoDir, REPO_CONFIG_PATH), "utf8"));
}
