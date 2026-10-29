import { DEPENDENCY_GLOBS, MIGRATION_GLOBS } from "../paths.js";
import { isProtected, matchesAny } from "../schemas/plan.js";
import type { RepoConfig, Risk } from "../schemas/repo.js";
import type { RunResultKind } from "../events.js";

export type MergePolicy = "auto" | "bot_review" | "human_review";


/** Risk reason of every run that changes `human_only_paths`: never auto, always a human's OK. */
export const PROTECTED_REASON = "changes protected config (CI / factory): human approval required, never auto-merged";

export interface RiskAssessment {
  risk: Risk;
  reasons: string[];
}

/** Risk classification, in code. */
export function riskClass(input: { changed: string[]; diffLines: number; repo: RepoConfig; laneEscalated?: boolean }): RiskAssessment {
  const { changed, diffLines, repo } = input;
  const hits = (globs: string[]) => changed.filter((f) => matchesAny(f, globs));
  const humanOnly = changed.filter((f) => isProtected(f, repo.human_only_paths));
  if (humanOnly.length) {
    return { risk: "high", reasons: [`human_only_paths: ${humanOnly.join(", ")}`, PROTECTED_REASON] };
  }
  const reasons: string[] = [];
  const sensitive = hits(repo.sensitive_paths);
  if (sensitive.length) reasons.push(`sensitive_paths: ${sensitive.join(", ")}`);
  const deps = hits(DEPENDENCY_GLOBS);
  if (deps.length) reasons.push(`dependencies: ${deps.join(", ")}`);
  const migrations = hits(MIGRATION_GLOBS);
  if (migrations.length) reasons.push(`migrations: ${migrations.join(", ")}`);
  if (diffLines > repo.merge.low_max_diff_lines) reasons.push(`diff ${diffLines} lines > ${repo.merge.low_max_diff_lines}`);
  if (input.laneEscalated) reasons.push("fast-lane escalation");
  return reasons.length ? { risk: "medium", reasons } : { risk: "low", reasons: [] };
}

const RANK: Record<Risk | "none", number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Merge policy: `auto` only when risk <= `auto_merge_max_risk` (never for high);
 * otherwise `merge.policy[risk]`. A result other than `done` always forces `human_review`.
 */
export function mergePolicy(risk: Risk, result: RunResultKind, merge: RepoConfig["merge"]): MergePolicy {
  if (result !== "done") return "human_review";
  if (risk === "high") return "human_review";
  if (RANK[risk] <= RANK[merge.auto_merge_max_risk]) return "auto";
  return merge.policy[risk];
}
