import { changedFiles, diffTotals, repoDiffStat } from "../git.js";
import { DEPENDENCY_GLOBS, MIGRATION_GLOBS } from "../paths.js";
import { isProtected, matchesAny } from "../schemas/plan.js";
import type { RunContext } from "./context.js";

/** Fast lane → standard lane triggers after implement, on the whole change since base. */
export async function fastLaneEscalation(ctx: Pick<RunContext, "worktree" | "baseSha" | "repo">): Promise<string[]> {
  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const lines = diffTotals(await repoDiffStat(ctx.worktree, ctx.baseSha, ctx.repo)).counted;
  const reasons: string[] = [];
  const max = ctx.repo.fast_lane.max_diff_lines;
  if (lines > max) reasons.push(`diff ${lines} lines > fast_lane.max_diff_lines ${max}`);
  const hits = (label: string, globs: string[]) => {
    const files = changed.filter((f) => matchesAny(f, globs));
    if (files.length) reasons.push(`${label}: ${files.join(", ")}`);
  };
  hits("dependencies", DEPENDENCY_GLOBS);
  hits("sensitive_paths", ctx.repo.sensitive_paths);
  const guarded = changed.filter((f) => isProtected(f, ctx.repo.human_only_paths));
  if (guarded.length) reasons.push(`human_only_paths: ${guarded.join(", ")}`);
  hits("migrations", MIGRATION_GLOBS);
  return reasons;
}
