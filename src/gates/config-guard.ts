import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { diffText, git, mergeBase } from "../git.js";
import { matchesAny, type Plan } from "../schemas/plan.js";
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
  { marker: "eslint-disable", pattern: /eslint-disable(-next-line|-line)?\b/ },
  { marker: "@ts-ignore", pattern: /@ts-ignore\b/ },
  { marker: "@ts-expect-error", pattern: /@ts-expect-error\b/ },
  { marker: "@ts-nocheck", pattern: /@ts-nocheck\b/ },
  { marker: "biome-ignore", pattern: /biome-ignore\b/ },
  { marker: "nolint", pattern: /\/\/\s*nolint\b/ },
  { marker: "allow(clippy", pattern: /#!?\[allow\(clippy::/ },
];

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
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
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
}): BuiltinResult {
  const files = input.plan.packages.filter((p) => input.packages.includes(p.id)).flatMap((p) => p.files);
  const text = planText(input.plan, input.packages);
  const inScope = (f: string) => files.includes(f) || matchesAny(f, files);
  const bad = [
    ...input.configChanges.filter((c) => !inScope(c.file)).map((c) => `${c.file}: ${c.why} (not in the plan's files)`),
    ...input.suppressions.filter((s) => !text.includes(s.marker.toLowerCase())).map((s) => `${s.file}: adds \`${s.marker}\`: ${s.line.slice(0, 120)}`),
  ];
  return bad.length
    ? { name: "config_guard", ok: false, detail: `fix the code instead of loosening the tools (bug):\n- ${bad.join("\n- ")}` }
    : { name: "config_guard", ok: true, detail: "" };
}

/** Collects config changes and added suppressions in a worktree against `base` (stage first). */
export async function configGuardInputs(cwd: string, base: string, changed: string[]): Promise<Pick<Parameters<typeof configGuard>[0], "configChanges" | "suppressions">> {
  const mb = await mergeBase(cwd, base);
  const configChanges: { file: string; why: string }[] = [];
  for (const file of changed) {
    const before = await git(cwd, ["show", `${mb}:${file}`]).catch(() => undefined);
    const after = await readFile(join(cwd, file), "utf8").catch(() => undefined);
    const why = configChange(file, before, after);
    if (why) configChanges.push({ file, why });
  }
  return { configChanges, suppressions: addedSuppressions(await diffText(cwd, base)) };
}
