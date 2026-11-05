import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadLayers } from "../config.js";

/** Retention knobs for `factory gc` (built-in and user profile only). */
export const GcRetentionSchema = z
  .object({
    dry_run: z.boolean().default(true),
    home_hours: z.number().min(0).default(24),
    worktree_failed_days: z.number().min(0).default(7),
    worktree_resume_days: z.number().min(0).default(14),
    metadata_days: z.number().min(0).default(90),
    metadata_failed_days: z.number().min(0).default(180),
    metadata_min_per_repo: z.number().int().min(0).default(20),
    archive_tarball_days: z.number().min(0).default(180),
  })
  .strict();
export type GcRetention = z.infer<typeof GcRetentionSchema>;

// Only the `gc` key is read here; the rest of the layer (roles, providers, ...) is validated by the profile loader.
// Not `.strict()` at the top level: a profile layer always carries other keys, and a strict parse would fail and
// silently drop the user's `gc.retention` overrides.
const GcBlockSchema = z.object({ gc: z.object({ retention: GcRetentionSchema.partial().optional() }).optional() });

/** Paths under `$FACTORY_HOME` that gc must never touch. */
export const GC_PROTECTED_TOP = new Set([
  "keys",
  "secrets",
  "memory",
  "profile.yaml",
  "notify.yaml",
  "gc.log",
]);

export function isProtectedFactoryPath(factoryHome: string, absPath: string): boolean {
  const root = factoryHome.endsWith("/") ? factoryHome.slice(0, -1) : factoryHome;
  if (absPath !== root && !absPath.startsWith(`${root}/`)) return false;
  const rel = absPath.slice(root.length).replace(/^\//, "");
  const parts = rel.split("/");
  const top = parts[0] ?? "";
  if (GC_PROTECTED_TOP.has(top)) return true;
  if (top === "archive" && (parts[1] === "keys" || parts[1] === "memory")) return true;
  if (top === "archive" && parts[1]?.startsWith("notify.yaml")) return true;
  if (parts.some((p) => p.endsWith(".bak"))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (base === "profile.yaml" || base.startsWith("notify.yaml")) return true;
  return false;
}

function mergeRetention(layers: ReturnType<typeof loadLayers>): GcRetention {
  let out: GcRetention = GcRetentionSchema.parse({});
  for (const layer of layers) {
    if (layer.name !== "built-in" && layer.name !== "user") continue;
    // parse (not safeParse): an invalid gc block fails closed instead of falling back to defaults.
    const block = GcBlockSchema.parse(layer.data);
    if (block.gc?.retention) out = { ...out, ...block.gc.retention };
  }
  return GcRetentionSchema.parse(out);
}

/** Effective retention settings from built-in and user profiles. */
export function loadGcRetention(factoryHome: string): GcRetention {
  return mergeRetention(loadLayers({ factoryHome }));
}

/**
 * True when deploy-self's `once` holds `flock` on `.deploy.lock`.
 * The flock is on that process's fd and is released when the process exits, including a crash.
 * A leftover lock file with no holder does not count, and the daemon's `.daemon.lock` is a different
 * file, so a finished deploy cannot skip the daily gc permanently. A missing `flock` binary fails closed.
 */
export function deploySelfBusy(env: NodeJS.ProcessEnv = process.env): boolean {
  const rel = env.FACTORY_RELEASES ?? join(homedir(), ".local/share/factory-releases");
  const lock = join(rel, ".deploy.lock");
  if (!existsSync(lock)) return false;
  // Non-blocking flock: exit 1 when the lock is held by deploy-self. Any other failure (flock missing,
  // lock unreadable) counts as busy, so gc fails closed.
  try {
    execFileSync("flock", ["-n", lock, "true"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}
