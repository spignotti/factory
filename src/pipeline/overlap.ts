import { matchesAny } from "../schemas/plan.js";
import type { Plan } from "../schemas/plan.js";

const GLOB = /[*?[\]{}]/;

/** Slash-normalized path without a leading `./` or a trailing slash. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Two planned paths (or a path and a glob) cover the same file. A directory covers its children
 * (`src/auth` and `src/auth/login.ts`); a shared prefix that is not a directory does not
 * (`src/auth` and `src/authz`).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
  if (!GLOB.test(x) && !GLOB.test(y)) return false;
  try {
    return matchesAny(x, [y]) || matchesAny(y, [x]);
  } catch {
    return false;
  }
}

export interface PathClaim {
  paths: string[];
  exclusive: boolean;
}

/** Two claims cannot run together: both exclusive, or any path pair overlaps. */
export function claimsConflict(a: PathClaim, b: PathClaim): boolean {
  if (a.exclusive && b.exclusive) return true;
  return a.paths.some((p) => b.paths.some((q) => pathsOverlap(p, q)));
}

/** Whether a plan's paths touch a repo's `exclusive_paths` globs (migrations, for example). */
export function touchesExclusive(paths: string[], globs: string[]): boolean {
  if (!globs.length || !paths.length) return false;
  return paths.some((p) => globs.some((g) => pathsOverlap(p, g)));
}

/** Files the plan says it will change. */
export function planPaths(plan: Plan): string[] {
  return [...new Set(plan.packages.flatMap((p) => p.files))];
}
