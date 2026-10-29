import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Providers the factory may call. Both are subscription-backed for us: `opencode-go` (OpenCode Go)
 * and `openai` (ChatGPT OAuth). Everything else is rejected at profile load, most importantly
 * `opencode/*` — that is OpenCode Zen, billed pay-per-use, and one typo away from `opencode-go/*`.
 */
export const ALLOWED_PROVIDERS = ["opencode-go", "openai"] as const;

export function providerOf(model: string): string {
  return model.slice(0, model.indexOf("/"));
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const ModelEntrySchema = z.object({
  model: z
    .string()
    .regex(/^[^/\s]+\/\S+$/, "model must be <provider>/<model>")
    .superRefine((m, ctx) => {
      const provider = providerOf(m);
      if ((ALLOWED_PROVIDERS as readonly string[]).includes(provider)) return;
      ctx.addIssue({
        code: "custom",
        message:
          provider === "opencode"
            ? `provider "opencode" is OpenCode Zen (pay-per-use) and not allowed; use opencode-go/* (${m})`
            : `provider "${provider}" is not allowed; allowed: ${ALLOWED_PROVIDERS.join(", ")} (${m})`,
      });
    }),
  thinking: z.enum(THINKING_LEVELS).optional(),
  /** Model family; derived from the model id when absent (e.g. `deepseek`, `gpt`). */
  family: z.string().optional(),
  /**
   * Only used after the previous entries failed with a capacity error and their same-model retries
   * are exhausted (Amendment c). Required for a cross-family `implement` backup.
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
 * Safety rules on a complete set of role chains (Amendment c, SPEC §8.2). Also applied after the
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

export const ProfileSchema = z
  .object({
    roles: RolesSchema,
    /** Same-model exponential backoff on capacity errors before falling back. */
    retry: RetrySchema.default({ base_ms: 2000, max_ms: 60_000, attempts: 4 }),
    /** Extra env var names per role for agent tool processes (Amendment b). */
    env: z.record(z.string(), z.array(z.string())).default({}),
  })
  .superRefine((p, ctx) => {
    for (const issue of chainIssues(p.roles)) ctx.addIssue({ code: "custom", ...issue });
  });
export type Profile = z.infer<typeof ProfileSchema>;

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
