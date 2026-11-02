import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const GcBlockSchema = z.object({ gc: z.object({ retention: GcRetentionSchema.partial().optional() }).optional() }).strict();

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
  if (!absPath.startsWith(root)) return false;
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
    const block = GcBlockSchema.safeParse(layer.data);
    if (block.success && block.data.gc?.retention) {
      out = { ...out, ...GcRetentionSchema.partial().parse(block.data.gc.retention) };
    }
  }
  return GcRetentionSchema.parse(out);
}

/** Effective retention settings from built-in and user profiles. */
export function loadGcRetention(factoryHome: string): GcRetention {
  return mergeRetention(loadLayers({ factoryHome }));
}

/** True when deploy-self holds its deploy lock (build/switch in progress). */
export function deploySelfBusy(env: NodeJS.ProcessEnv = process.env): boolean {
  const rel = env.FACTORY_RELEASES ?? join(homedir(), ".local/share/factory-releases");
  const lock = join(rel, ".deploy.lock");
  if (!existsSync(lock)) return false;
  try {
    readFileSync(lock, "utf8");
  } catch {
    return false;
  }
  // Non-blocking flock: exit 1 when the lock is held by deploy-self.
  try {
    execFileSync("flock", ["-n", lock, "true"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}
