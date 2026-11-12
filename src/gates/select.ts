import picomatch from "picomatch";
import { DEPENDENCY_GLOBS } from "../paths.js";
import type { Check, Tier } from "../schemas/repo.js";

/**
 * A change here can affect a check whose `paths` do not name the file: dependencies, shared
 * config, fixtures, and package entrypoints. The effect is unclear, so the tier runs wide.
 */
export const WIDEN_GLOBS = [
  ...DEPENDENCY_GLOBS,
  "**/.factory/repo.yaml",
  "**/tsconfig.json",
  "**/tsconfig.*.json",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/pytest.ini",
  "**/conftest.py",
  "**/tox.ini",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/testdata/**",
  "**/index.ts",
  "**/index.js",
  "**/index.mjs",
  "**/__init__.py",
];

const matches = (globs: string[], file: string): boolean => picomatch(globs, { dot: true })(file);

/** True when path filters must not drop a check of this tier. */
export function selectionWidens(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => matches(WIDEN_GLOBS, file));
}

/**
 * Deterministic check selection, the same code for the pipeline and CI (`factory gates --select`).
 * - `fast`: fast checks (after every package and fix round);
 * - `full`: fast + full checks (finalize, CI on pull requests);
 * - `manual`: manual checks only (CI `workflow_dispatch`), regardless of paths. The pipeline never asks for it.
 * A check with `paths` runs only if a changed file matches; no `paths` = always.
 * A widened diff (dependency, shared config, fixture, entrypoint) selects every check of the tier.
 * `all` ignores paths: a tag or `workflow_dispatch` has an empty diff against the base (the tag
 * is a commit already on that base), and a deploy still has to run every check of the tier.
 */
export function selectChecks(checks: Check[], tier: Tier, changedFiles: string[], opts?: { all?: boolean }): Check[] {
  if (tier === "manual") return checks.filter((c) => c.tier === "manual");
  const tiers: Tier[] = tier === "fast" ? ["fast"] : ["fast", "full"];
  const widen = opts?.all !== true && selectionWidens(changedFiles);
  return checks.filter((c) => {
    if (!tiers.includes(c.tier)) return false;
    if (opts?.all || widen || !c.paths || c.paths.length === 0) return true;
    return changedFiles.some((f) => matches(c.paths!, f));
  });
}

/**
 * One command runs once per gate. A later check with the same `run` keeps the first check's result.
 * Local gates and CI stay independent of each other; this only collapses one phase.
 */
export function dedupeChecks(checks: Check[]): { checks: Check[]; sameCommand: { name: string; sameAs: string }[] } {
  const byRun = new Map<string, string>();
  const kept: Check[] = [];
  const sameCommand: { name: string; sameAs: string }[] = [];
  for (const check of checks) {
    const key = check.run.trim();
    const first = byRun.get(key);
    if (first) {
      sameCommand.push({ name: check.name, sameAs: first });
      continue;
    }
    byRun.set(key, check.name);
    kept.push(check);
  }
  return { checks: kept, sameCommand };
}

/** Baseline gates whose name already ran as a repo check. The repo check is the one result. */
export function omitRepeatedNames<T extends { name: string }>(incoming: T[], already: readonly string[]): T[] {
  const have = new Set(already);
  return incoming.filter((item) => !have.has(item.name));
}
