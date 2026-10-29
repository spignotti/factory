import { changedFiles, diffStat } from "../git.js";
import { DEPENDENCY_GLOBS, MIGRATION_GLOBS } from "../paths.js";
import { matchesAny } from "../schemas/plan.js";
import type { RunContext } from "./context.js";

/** Fast lane → standard lane triggers after implement, on the whole change since base. */
export async function fastLaneEscalation(ctx: Pick<RunContext, "worktree" | "baseSha" | "repo">): Promise<string[]> {
  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const lines = [...(await diffStat(ctx.worktree, ctx.baseSha)).values()].reduce((a, b) => a + b, 0);
  const reasons: string[] = [];
  const max = ctx.repo.fast_lane.max_diff_lines;
  if (lines > max) reasons.push(`diff ${lines} lines > fast_lane.max_diff_lines ${max}`);
  const hits = (label: string, globs: string[]) => {
    const files = changed.filter((f) => matchesAny(f, globs));
    if (files.length) reasons.push(`${label}: ${files.join(", ")}`);
  };
  hits("dependencies", DEPENDENCY_GLOBS);
  hits("sensitive_paths", ctx.repo.sensitive_paths);
  hits("human_only_paths", ctx.repo.human_only_paths);
  hits("migrations", MIGRATION_GLOBS);
  return reasons;
}
