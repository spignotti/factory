import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Provider policy. Built-in default: every provider except `opencode` — that is
 * OpenCode Zen, billed pay-per-use and one typo away from `opencode-go`. A user profile may pin the
 * list (Silas: `allow: [opencode-go, openai]`); repo.yaml cannot change it. `deny` wins over `allow`;
 * `*` in `allow` means any provider.
 */
const ZEN = "opencode";

export const DEFAULT_PROVIDERS = { allow: ["*"], deny: ["opencode"] };

export const ProvidersSchema = z.object({
  allow: z.array(z.string().min(1)).min(1).default(["*"]),
  deny: z.array(z.string().min(1)).default(["opencode"]),
});
export type Providers = z.infer<typeof ProvidersSchema>;

export function providerIssue(model: string, providers: Providers): string | undefined {
  const provider = providerOf(model);
  // Zen is never allowed through `*`: only an explicit `allow: [opencode]` (and no deny) opts in, the
  // same rule `doctor` applies.
  const wildcard = providers.allow.includes("*") && provider !== ZEN;
  const allowed = (wildcard || providers.allow.includes(provider)) && !providers.deny.includes(provider);
  if (allowed) return undefined;
  if (provider === "opencode") return `provider "opencode" is OpenCode Zen (pay-per-use) and not allowed; use opencode-go/* (${model})`;
  return `provider "${provider}" is not allowed (allow: ${providers.allow.join(", ")}; deny: ${providers.deny.join(", ") || "none"}) (${model})`;
}

export function providerOf(model: string): string {
  return model.slice(0, model.indexOf("/"));
}

/**
 * How a provider bills: `subscription` (flat plan, e.g. OpenCode Go, OpenAI via the ChatGPT login)
 * or `metered` (per-use USD). Usage on a subscription is reported in tokens, never in USD: the
 * catalog price Pi reports would be wrong there. Providers not listed are metered.
 */
export const BillingKindSchema = z.enum(["subscription", "metered"]);
export type BillingKind = z.infer<typeof BillingKindSchema>;
export const DEFAULT_BILLING: Record<string, BillingKind> = { "opencode-go": "subscription", openai: "subscription" };
export const BillingSchema = z.record(z.string().min(1), BillingKindSchema);
export type Billing = z.infer<typeof BillingSchema>;

export function billingOf(model: string, billing: Billing): BillingKind {
  return billing[providerOf(model)] ?? "metered";
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const ModelEntrySchema = z.object({
  model: z
    .string()
    .regex(/^[^/\s]+\/\S+$/, "model must be <provider>/<model>"),
  thinking: z.enum(THINKING_LEVELS).optional(),
  /** Model family; derived from the model id when absent (e.g. `deepseek`, `gpt`). */
  family: z.string().optional(),
  /**
   * Only used after the previous entries failed with a capacity error and their same-model retries
   * are exhausted. Required for a cross-family `implement` backup.
   */
  capacity_only: z.boolean().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

const Chain = z.array(ModelEntrySchema).min(1);

/** Reviewer roles; each reviewer has its own model chain. */
export const REVIEW_ROLES = ["review_plan", "review_simplicity", "review_security", "review_checklist"] as const;

export const PROFILE_ROLES = [
  "plan_high",
  "plan_medium",
  "plan_normalize",
  "implement",
  ...REVIEW_ROLES,
  "evaluate",
  "pr_writer",
  "harden",
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** Model id -> family: leading name token of the model part, e.g. `opencode-go/deepseek-v4-pro` -> `deepseek`. */
export function familyOf(entry: ModelEntry): string {
  if (entry.family) return entry.family;
  const name = entry.model.slice(entry.model.indexOf("/") + 1).toLowerCase();
  return /^[a-z<>_]+/.exec(name)?.[0] ?? name;
}

export const RetrySchema = z.object({
  base_ms: z.number().min(0).default(2000),
  max_ms: z.number().min(0).default(60_000),
  attempts: z.number().int().min(1).default(4),
});

const RolesSchema = z.object(Object.fromEntries(PROFILE_ROLES.map((r) => [r, Chain])) as Record<ProfileRole, typeof Chain>);

/**
 * Safety rules on a complete set of role chains. Also applied after the
 * layered merge (config.ts), so no layer can switch them off.
 */
export function chainIssues(roles: Partial<Record<ProfileRole, ModelEntry[]>>): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  for (const [role, chain] of Object.entries(roles) as [ProfileRole, ModelEntry[]][]) {
    if (chain[0]?.capacity_only) issues.push({ path: ["roles", role, "0"], message: `${role}: the first entry cannot be capacity_only` });
  }
  const implement = roles.implement;
  if (!implement?.length) return issues;
  const primary = familyOf(implement[0]!);
  implement.forEach((e, i) => {
    if (familyOf(e) !== primary && !e.capacity_only) {
      issues.push({
        path: ["roles", "implement", String(i)],
        message: `implement entry ${e.model} is another model family than ${implement[0]!.model}; a cross-family backup must be capacity_only: true`,
      });
    }
  });
  const implementFamilies = new Set(implement.map(familyOf));
  for (const role of REVIEW_ROLES) {
    for (const e of roles[role] ?? []) {
      if (implementFamilies.has(familyOf(e))) {
        issues.push({
          path: ["roles", role],
          message: `${role} model ${e.model} is in an implement model family (${familyOf(e)}); reviewers must differ from the implementer`,
        });
      }
    }
  }
  return issues;
}

/** Every safety rule on resolved roles: provider policy and the chain rules. */
export function profileIssues(
  roles: Partial<Record<ProfileRole, ModelEntry[]>>,
  providers: Providers,
): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  for (const [role, chain] of Object.entries(roles)) {
    chain.forEach((e, i) => {
      const msg = providerIssue(e.model, providers);
      if (msg) issues.push({ path: ["roles", role, String(i)], message: msg });
    });
  }
  return [...issues, ...chainIssues(roles)];
}

export const SandboxModeSchema = z.enum(["required", "preferred", "off"]);

/**
 * Agent steps that get the `docs_lookup` tool (Context7): `plan` (plan_high/plan_medium), `implement`,
 * `fix` (the implementer in review and gate fix rounds), `review`, `evaluate`.
 */
export const DOCS_STEPS = ["plan", "implement", "fix", "review", "evaluate"] as const;
export type DocsStep = (typeof DOCS_STEPS)[number];
export const DEFAULT_DOCS_STEPS: DocsStep[] = ["plan", "implement", "fix"];
export const DocsLookupSchema = z.object({ roles: z.array(z.enum(DOCS_STEPS)) }).strict();
export type DocsLookup = z.infer<typeof DocsLookupSchema>;

export const ProfileSchema = z
  .object({
    roles: RolesSchema,
    providers: ProvidersSchema.default(DEFAULT_PROVIDERS),
    /** Billing kind per provider (subscription → tokens in reports, metered → USD). */
    billing: BillingSchema.default({ ...DEFAULT_BILLING }),
    /** Process sandbox for agents and repo commands. */
    sandbox: SandboxModeSchema.default("preferred"),
    /** Same-model exponential backoff on capacity errors before falling back. */
    retry: RetrySchema.default({ base_ms: 2000, max_ms: 60_000, attempts: 4 }),
    /** Extra env var names per role for agent tool processes. */
    env: z.record(z.string(), z.array(z.string())).default({}),
    /** Which agent steps get the `docs_lookup` tool; `roles: []` turns it off. */
    docs_lookup: DocsLookupSchema.default({ roles: [...DEFAULT_DOCS_STEPS] }),
  })
  .superRefine((p, ctx) => {
    for (const issue of profileIssues(p.roles, p.providers)) ctx.addIssue({ code: "custom", ...issue });
  });
export type Profile = z.infer<typeof ProfileSchema> & {
  /** Which config layer each role's chain came from (set by config.ts). */
  sources?: Partial<Record<ProfileRole, string>>;
};

export function parseProfile(text: string): Profile {
  return ProfileSchema.parse(parse(text));
}

export function loadProfile(nameOrPath: string): Profile {
  const path = nameOrPath.includes("/") || nameOrPath.endsWith(".yaml")
    ? nameOrPath
    : new URL(`../../profiles/${nameOrPath}.yaml`, import.meta.url);
  return parseProfile(readFileSync(path, "utf8"));
}

/** Logical runner role -> profile role. */
export function profileRoleOf(role: string): ProfileRole {
  if (!(PROFILE_ROLES as readonly string[]).includes(role)) throw new Error(`unknown role ${role}`);
  return role as ProfileRole;
}

/** Partial role → chain map: a layer replaces whole chains, role by role. */
export const RoleOverridesSchema = z.object(
  Object.fromEntries(PROFILE_ROLES.map((r) => [r, Chain.optional()])) as Record<ProfileRole, z.ZodOptional<typeof Chain>>,
).strict();
export type RoleOverrides = z.infer<typeof RoleOverridesSchema>;

/** One config layer: built-in default, user profile (`~/.factory/profile.yaml`) or `--profile`. */
export const ProfileLayerSchema = z
  .object({
    roles: RoleOverridesSchema.optional(),
    retry: RetrySchema.partial().optional(),
    env: z.record(z.string(), z.array(z.string())).optional(),
    providers: ProvidersSchema.partial().optional(),
    billing: BillingSchema.optional(),
    sandbox: SandboxModeSchema.optional(),
    docs_lookup: DocsLookupSchema.optional(),
  })
  .strict();
export type ProfileLayer = z.infer<typeof ProfileLayerSchema>;
