import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { diffText, git, mergeBase } from "../git.js";
import { matchesAny, type Plan } from "../schemas/plan.js";
import { parseRepoConfig, REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import type { BuiltinResult } from "./builtin.js";

/**
 * Config guard: the implementer fixes code to satisfy linters, type checkers and test runners; it
 * does not loosen their config or silence them inline. Deterministic: a changed tool config or an
 * added suppression fails the gate unless the plan puts it in scope (the config file in a package's
 * `files`, the suppression marker named in a package or criterion).
 */

/** Files that are tool config as a whole: any change counts. */
const WHOLE_CONFIG = [
  "**/ruff.toml",
  "**/.ruff.toml",
  "**/pyrightconfig.json",
  "**/mypy.ini",
  "**/.mypy.ini",
  "**/.flake8",
  "**/.pylintrc",
  "**/.eslintrc",
  "**/.eslintrc.*",
  "**/eslint.config.*",
  "**/biome.json",
  "**/biome.jsonc",
  "**/.prettierrc",
  "**/.prettierrc.*",
  "**/prettier.config.*",
  "**/.golangci.{yml,yaml,toml,json}",
  "**/clippy.toml",
  "**/.clippy.toml",
];

/** pyproject/setup.cfg sections that configure linting, typing, formatting or tests. */
const TOOL_SECTION = /^\[(tool\.(ruff|pyright|mypy|black|isort|pylint|flake8|coverage|pytest)\b[^\]]*|mypy[^\]]*|flake8|pylint[^\]]*|isort|coverage:[^\]]*|tool:pytest)\]\s*$/;

/** tsconfig compiler flags that make type checking stricter or looser. */
const TS_FLAGS = /"(strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|noFallthroughCasesInSwitch|noPropertyAccessFromIndexSignature|exactOptionalPropertyTypes|allowUnreachableCode|allowUnusedLabels|skipLibCheck|checkJs|allowJs|useUnknownInCatchVariables|alwaysStrict|noEmitOnError)"\s*:\s*[^,}\n]+/g;

/** Coverage thresholds in vitest/jest config or package.json. */
const COVERAGE = /\b(thresholds?|coverageThreshold|lines|branches|functions|statements|perFile|autoUpdate|fail_under|cov-fail-under)\b["']?\s*[:=]\s*[^,}\n]+/g;
const TEST_RUNNER_CONFIG = ["**/vitest.config.*", "**/vitest.workspace.*", "**/jest.config.*", "**/package.json", "**/.coveragerc"];

export interface Suppression {
  marker: string;
  pattern: RegExp;
}

export const SUPPRESSIONS: Suppression[] = [
  { marker: "noqa", pattern: /#\s*noqa\b/i },
  { marker: "type: ignore", pattern: /#\s*type:\s*ignore\b/ },
  { marker: "pyright: ignore", pattern: /#\s*pyright:\s*(ignore|basic)\b/ },
  { marker: "pylint: disable", pattern: /#\s*pylint:\s*disable\b/ },
  { marker: "eslint-disable", pattern: /(?:\/\/|\/\*|\*)\s*eslint-disable(-next-line|-line)?\b/ },
  { marker: "@ts-ignore", pattern: /(?:\/\/|\/\*|\*)\s*@ts-ignore\b/ },
  { marker: "@ts-expect-error", pattern: /(?:\/\/|\/\*|\*)\s*@ts-expect-error\b/ },
  { marker: "@ts-nocheck", pattern: /(?:\/\/|\/\*|\*)\s*@ts-nocheck\b/ },
  { marker: "biome-ignore", pattern: /(?:\/\/|\/\*|\*)\s*biome-ignore\b/ },
  { marker: "nolint", pattern: /\/\/\s*nolint\b/ },
  { marker: "allow(clippy", pattern: /#!?\[allow\(clippy::/ },
];

/** Prose files may mention markers without suppressing anything. */
const PROSE = /\.(md|mdx|markdown|txt|rst)$/i;

const sorted = (xs: string[]) => xs.map((x) => x.replace(/\s+/g, " ").trim()).sort().join("\n");

/** Lines of the given TOML/INI sections. */
function toolSections(text: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) on = TOOL_SECTION.test(line.trim());
    if (on && line.trim() && !line.trim().startsWith("#")) out.push(line);
  }
  return sorted(out);
}

/**
 * Why a change to `path` is a tool-config change, or undefined. `before`/`after` are the file at the
 * merge base and now (`undefined` = absent).
 */
export function configChange(path: string, before: string | undefined, after: string | undefined): string | undefined {
  if (before === after) return undefined;
  const b = before ?? "";
  const a = after ?? "";
  if (matchesAny(path, WHOLE_CONFIG)) return "linter/formatter/type-checker config changed";
  const name = basename(path);
  if (name === "pyproject.toml" || name === "setup.cfg" || name === "tox.ini") {
    return toolSections(b) !== toolSections(a) ? `[tool.*] lint/type/test config in ${name} changed` : undefined;
  }
  if (/^tsconfig.*\.json$/.test(name)) {
    const flags = (t: string) => sorted(t.match(TS_FLAGS) ?? []);
    return flags(b) !== flags(a) ? "tsconfig strictness flags changed" : undefined;
  }
  if (matchesAny(path, TEST_RUNNER_CONFIG) || name === "pytest.ini") {
    const cov = (t: string) => sorted(t.match(COVERAGE) ?? []);
    return cov(b) !== cov(a) ? "coverage thresholds changed" : undefined;
  }
  return undefined;
}

const RISK_RANK = { none: 0, low: 1, medium: 2, high: 3 } as const;
const POLICY_RANK = { bot_review: 0, human_review: 1 } as const;

/**
 * Ways a `.factory/repo.yaml` change weakens the factory's own checks or widens what agents get.
 * Adding checks or protections is fine; this list is never in scope, even for a declared protected
 * change: only a human makes these edits.
 */
export function repoConfigLoosening(before: string | undefined, after: string | undefined): string[] {
  if (before === undefined || before === after) return [];
  let b: RepoConfig;
  try {
    b = parseRepoConfig(before);
  } catch {
    return []; // an invalid base config cannot be loosened
  }
  if (after === undefined) return ["repo.yaml deleted"];
  let a: RepoConfig;
  try {
    a = parseRepoConfig(after);
  } catch (e) {
    return [`repo.yaml no longer valid: ${(e as Error).message.slice(0, 200)}`];
  }
  const out: string[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const removed = (what: string, xs: string[], ys: string[]) => {
    const gone = xs.filter((x) => !ys.includes(x));
    if (gone.length) out.push(`${what} removed: ${gone.join(", ")}`);
  };
  for (const c of b.checks) {
    const now = a.checks.find((x) => x.name === c.name);
    if (!now) out.push(`check ${c.name} removed`);
    else if (!c.local_only && now.local_only) out.push(`check ${c.name} made local_only (dropped from CI)`);
    else if (!same(c, now)) out.push(`check ${c.name} changed (run, tier, paths, services or local_only)`);
  }
  removed("human_only_paths", b.human_only_paths, a.human_only_paths);
  removed("sensitive_paths", b.sensitive_paths, a.sensitive_paths);
  removed("limits.forbidden_paths", b.limits.forbidden_paths, a.limits.forbidden_paths);
  const skips = a.review.skip_paths.filter((x) => !b.review.skip_paths.includes(x));
  if (skips.length) out.push(`review.skip_paths added: ${skips.join(", ")}`);
  if (a.review.max_rounds < b.review.max_rounds) out.push("review.max_rounds lowered");
  if (b.review.checklist && !a.review.checklist) out.push("review.checklist turned off");
  if (RISK_RANK[a.merge.auto_merge_max_risk] > RISK_RANK[b.merge.auto_merge_max_risk]) out.push("merge.auto_merge_max_risk raised");
  for (const r of ["low", "medium"] as const) {
    if (POLICY_RANK[a.merge.policy[r]] < POLICY_RANK[b.merge.policy[r]]) out.push(`merge.policy.${r} loosened`);
  }
  if (a.merge.low_max_diff_lines > b.merge.low_max_diff_lines) out.push("merge.low_max_diff_lines raised");
  if (a.limits.max_diff_lines > b.limits.max_diff_lines) out.push("limits.max_diff_lines raised");
  const excl = a.limits.diff_exclude.filter((x) => !b.limits.diff_exclude.includes(x));
  if (excl.length) out.push(`limits.diff_exclude added: ${excl.join(", ")}`);
  removed("tests.globs", b.tests.globs, a.tests.globs);
  if (b.tests.run && a.tests.run !== b.tests.run) out.push("tests.run changed");
  const env = a.agent_env.filter((x) => !b.agent_env.includes(x));
  if (env.length) out.push(`agent_env added: ${env.join(", ")}`);
  if (!same(b.secrets, a.secrets)) out.push("secrets changed");
  if (b.env_command !== a.env_command) out.push("env_command changed");
  if (b.setup !== a.setup) out.push("setup changed");
  for (const s of b.services) {
    const now = a.services.find((x) => x.name === s.name);
    if (!now || !same(s, now)) out.push(`service ${s.name} changed or removed`);
  }
  // A new host service runs repo commands outside the sandbox (and env_from feeds checks): only a human adds one.
  for (const s of a.services) {
    if (s.host && !b.services.some((x) => x.name === s.name)) out.push(`host service ${s.name} added (runs outside the sandbox)`);
  }
  if (!same(b.models, a.models)) out.push("models changed");
  if (!same(b.git, a.git)) out.push("git author changed");
  return out;
}

/** Suppressions on added lines of a unified diff: `[file, marker, line text]`. */
export function addedSuppressions(diff: string): { file: string; marker: string; line: string }[] {
  const out: { file: string; marker: string; line: string }[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m) {
      file = m[1]!;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++") || PROSE.test(file)) continue;
    for (const s of SUPPRESSIONS) if (s.pattern.test(line)) out.push({ file, marker: s.marker, line: line.slice(1).trim() });
  }
  return out;
}

function planText(plan: Plan, packages: string[]): string {
  const ps = plan.packages.filter((p) => packages.includes(p.id));
  return [...ps.flatMap((p) => [p.title, p.description]), ...plan.acceptance.filter((a) => packages.includes(a.package)).map((a) => a.text)].join("\n").toLowerCase();
}

/** The gate over precomputed inputs (pure, for tests). */
export function configGuard(input: {
  plan: Plan;
  packages: string[];
  configChanges: { file: string; why: string }[];
  suppressions: { file: string; marker: string; line: string }[];
  /** repo.yaml loosening: fails even when the plan declares the file a protected change. */
  loosening?: string[];
}): BuiltinResult {
  const files = input.plan.packages.filter((p) => input.packages.includes(p.id)).flatMap((p) => p.files);
  const text = planText(input.plan, input.packages);
  const inScope = (f: string) => files.includes(f) || matchesAny(f, files);
  const bad = [
    ...input.configChanges.filter((c) => !inScope(c.file)).map((c) => `${c.file}: ${c.why} (not in the plan's files)`),
    ...input.suppressions.filter((s) => !text.includes(s.marker.toLowerCase())).map((s) => `${s.file}: adds \`${s.marker}\`: ${s.line.slice(0, 120)}`),
    ...(input.loosening ?? []).map((l) => `${REPO_CONFIG_PATH}: ${l} (loosens the factory's own checks; only a human makes this edit)`),
  ];
  return bad.length
    ? { name: "config_guard", ok: false, detail: `fix the code instead of loosening the tools (bug):\n- ${bad.join("\n- ")}` }
    : { name: "config_guard", ok: true, detail: "" };
}

/** Collects config changes and added suppressions in a worktree against `base` (stage first). */
export async function configGuardInputs(cwd: string, base: string, changed: string[]): Promise<Pick<Parameters<typeof configGuard>[0], "configChanges" | "suppressions" | "loosening">> {
  const mb = await mergeBase(cwd, base);
  const configChanges: { file: string; why: string }[] = [];
  let loosening: string[] = [];
  for (const file of changed) {
    const before = await git(cwd, ["show", `${mb}:${file}`]).catch(() => undefined);
    const after = await readFile(join(cwd, file), "utf8").catch(() => undefined);
    const why = configChange(file, before, after);
    if (why) configChanges.push({ file, why });
    if (file === REPO_CONFIG_PATH) loosening = repoConfigLoosening(before, after);
  }
  return { configChanges, suppressions: addedSuppressions(await diffText(cwd, base)), loosening };
}
