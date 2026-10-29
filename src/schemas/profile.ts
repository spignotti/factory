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
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** Model family; derived from the model id when absent (e.g. `deepseek`, `grok`). */
  family: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

const Chain = z.array(ModelEntrySchema).min(1);

export const PROFILE_ROLES = ["plan_high", "plan_medium", "plan_normalize", "implement", "review", "pr_writer"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number] | "evaluate" | "harden";

/** Model id -> family: leading name token of the model part, e.g. `opencode-go/deepseek-v4-pro` -> `deepseek`. */
export function familyOf(entry: ModelEntry): string {
  if (entry.family) return entry.family;
  const name = entry.model.slice(entry.model.indexOf("/") + 1).toLowerCase();
  return /^[a-z<>_]+/.exec(name)?.[0] ?? name;
}

export const ProfileSchema = z
  .object({
    roles: z.object({
      plan_high: Chain,
      plan_medium: Chain,
      plan_normalize: Chain,
      implement: Chain,
      review: Chain,
      pr_writer: Chain,
      evaluate: Chain.optional(),
      harden: Chain.optional(),
    }),
    /** Same-model exponential backoff on capacity errors before falling back. */
    retry: z
      .object({
        base_ms: z.number().min(0).default(2000),
        max_ms: z.number().min(0).default(60_000),
        attempts: z.number().int().min(1).default(4),
      })
      .default({ base_ms: 2000, max_ms: 60_000, attempts: 4 }),
    /** Extra env var names per role for agent tool processes (Amendment b). */
    env: z.record(z.string(), z.array(z.string())).default({}),
  })
  .superRefine((p, ctx) => {
    // Amendment c: implement never falls back across model families.
    const families = new Set(p.roles.implement.map(familyOf));
    if (families.size > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["roles", "implement"],
        message: `implement fallback chain must stay in one model family, got ${[...families].join(", ")}`,
      });
    }
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

/** Logical runner role -> profile role (all reviewers share `review`). */
export function profileRoleOf(role: string): ProfileRole {
  return (role.startsWith("review_") ? "review" : role) as ProfileRole;
}
