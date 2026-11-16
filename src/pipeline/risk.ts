import { DEPENDENCY_GLOBS, MIGRATION_GLOBS } from "../paths.js";
import { isProtected, matchesAny } from "../schemas/plan.js";
import type { RepoConfig, Risk } from "../schemas/repo.js";
import type { RunResultKind } from "../events.js";

export type MergePolicy = "auto" | "bot_review" | "human_review";

/** Risk reason of every run that changes `human_only_paths`. Auto-merge stays off via `mergePolicy`. */
export const PROTECTED_REASON = "changes protected config (CI / factory)";

const DATA_GLOBS = [...MIGRATION_GLOBS, "**/migration/**", "**/*.sql", "**/schema.prisma"];
const AUTH_GLOBS = ["**/*auth*", "**/*auth*/**", "**/auth/**", "**/*permission*", "**/*rbac*", "**/*rls*", "**/policies/**", "**/*policies*"];
const SECRET_GLOBS = ["**/.env", "**/.env.*", "**/secrets/**", "**/*credential*", "**/*secret*", "**/*.pem", "**/*.key"];
/** `merge.human_review_paths` when the repo does not set it: files whose change always waits for a person. */
export const DEFAULT_HUMAN_REVIEW_PATHS = [...MIGRATION_GLOBS, ...SECRET_GLOBS];

/** The hard list in effect: the repo's `merge.human_review_paths`, or the default when the key is absent. */
export function humanReviewPaths(repo: RepoConfig): string[] {
  return repo.merge.human_review_paths ?? DEFAULT_HUMAN_REVIEW_PATHS;
}

const DEPLOY_GLOBS = [
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/*.plist",
  "**/deploy/**",
  "**/infra/**",
  "**/*.tf",
  "**/k8s/**",
  "**/helm/**",
  "**/.github/workflows/**",
  "**/fly.toml",
  "**/render.yaml",
  "**/Procfile",
  "**/*launchd*",
];

export interface SecurityRow {
  area: string;
  touched: boolean;
  note: string;
}

/** What the diff touches, one yes/no row per area; the last row is the hard list. Notes list up to eight paths. */
export function securityRows(changed: string[], hardList: string[] = DEFAULT_HUMAN_REVIEW_PATHS): SecurityRow[] {
  const row = (area: string, globs: string[]): SecurityRow => {
    const hits = changed.filter((f) => matchesAny(f, globs)).slice(0, 8);
    return { area, touched: hits.length > 0, note: hits.length ? hits.join(", ") : "none in this diff" };
  };
  return [
    row("Data/migrations", DATA_GLOBS),
    row("Auth/permissions", AUTH_GLOBS),
    row("Secrets handling", SECRET_GLOBS),
    row("Prod deploy/infra", DEPLOY_GLOBS),
    row("Dependencies", DEPENDENCY_GLOBS),
    row("Human review (hard list)", hardList),
  ];
}

export interface RiskAssessment {
  risk: Risk;
  reasons: string[];
}

/** One line under the risk rating. Reasons come from `riskClass`; a low rating says so. */
export function riskReasonLine(risk: RiskAssessment): string {
  const line = risk.reasons.length ? risk.reasons.join("; ") : "no sensitive paths, dependency changes, or migrations";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * Diff size is a split signal, not a risk class. Test lines stay in the count so a large
 * test or fixture diff is visible, and they do not by themselves become product risk.
 */
export function diffSizeSignal(diffLines: number, limit: number): string | null {
  return diffLines > limit ? `diff ${diffLines} lines > ${limit}` : null;
}

/**
 * Risk classification, in code. `high`: `human_only_paths` or the hard list (`merge.human_review_paths`).
 * `medium`: `sensitive_paths`, dependencies, and migrations the hard list does not cover.
 */
export function riskClass(input: { changed: string[]; diffLines: number; repo: RepoConfig }): RiskAssessment {
  const { changed, repo } = input;
  const hits = (globs: string[]) => changed.filter((f) => matchesAny(f, globs));
  const humanOnly = changed.filter((f) => isProtected(f, repo.human_only_paths));
  if (humanOnly.length) {
    return { risk: "high", reasons: [`human_only_paths: ${humanOnly.join(", ")}`, PROTECTED_REASON] };
  }
  const hard = changed.filter((f) => matchesAny(f, humanReviewPaths(repo)));
  // A file on the hard list is named once, under its hard-list reason.
  const rest = (globs: string[]) => hits(globs).filter((f) => !hard.includes(f));
  const reasons: string[] = hard.length ? [`human_review_paths: ${hard.join(", ")}`] : [];
  const sensitive = rest(repo.sensitive_paths);
  if (sensitive.length) reasons.push(`sensitive_paths: ${sensitive.join(", ")}`);
  const deps = rest(DEPENDENCY_GLOBS);
  if (deps.length) reasons.push(`dependencies: ${deps.join(", ")}`);
  const migrations = rest(MIGRATION_GLOBS);
  if (migrations.length) reasons.push(`migrations: ${migrations.join(", ")}`);
  if (hard.length) return { risk: "high", reasons };
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
