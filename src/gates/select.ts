import picomatch from "picomatch";
import type { Check, Tier } from "../schemas/repo.js";

/**
 * Deterministic check selection, the same code for the pipeline and CI.
 * - `fast`: fast checks (after every package and fix round);
 * - `full`: fast + full checks (finalize, CI on pull requests);
 * - `manual`: manual checks only (CI `workflow_dispatch`), regardless of paths. The pipeline never asks for it.
 * A check with `paths` runs only if a changed file matches; no `paths` = always.
 * `all` ignores paths: a tag or `workflow_dispatch` has an empty diff against the base (the tag
 * is a commit already on that base), and a deploy still has to run every check of the tier.
 */
export function selectChecks(checks: Check[], tier: Tier, changedFiles: string[], opts?: { all?: boolean }): Check[] {
  if (tier === "manual") return checks.filter((c) => c.tier === "manual");
  const tiers: Tier[] = tier === "fast" ? ["fast"] : ["fast", "full"];
  return checks.filter((c) => {
    if (!tiers.includes(c.tier)) return false;
    if (opts?.all || !c.paths || c.paths.length === 0) return true;
    const match = picomatch(c.paths, { dot: true });
    return changedFiles.some((f) => match(f));
  });
}
