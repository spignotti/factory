import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { diffText, git, mergeBase } from "../git.js";
import { matchesAny, type Plan, redGreenLoosening } from "../schemas/plan.js";
import { parseRepoConfig, REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import { describeStandardsRemoval, namesCheck, STANDARDS_REL, standardsRemovalDeclared, standardsRemovals, type StandardsRemoval } from "../standards.js";
import type { BuiltinResult } from "./builtin.js";

/**
 * Config guard: the implementer fixes code to satisfy linters, type checkers and test runners; it
 * does not loosen their config or silence them inline. Deterministic: a changed tool config or an
 * added suppression fails the gate unless the plan puts it in scope (the config file in a package's
 * `files`, the suppression marker named in a package or criterion). Removing or renaming a workflow
 * job is a loosening unless that file's protected_changes names the job.
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

/** Security-tool config: any change is a loosening unless the plan names the file. */
const SECURITY_CONFIG = [
  "**/.semgrep/**",
  "**/.gitleaks.toml",
  "**/.gitleaksignore",
  "**/.shellcheckrc",
  "**/.trivyignore",
  "**/.hadolint.yaml",
];

/** pyproject/setup.cfg sections that configure linting, typing, formatting or tests. */
const TOOL_SECTION = /^\[(tool\.(ruff|pyright|mypy|black|isort|pylint|flake8|coverage|pytest)\b[^\]]*|mypy[^\]]*|flake8|pylint[^\]]*|isort|coverage:[^\]]*|tool:pytest)\]\s*$/;

/** tsconfig compiler flags that make type checking stricter or looser. */
const TS_FLAGS = /"(strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|noFallthroughCasesInSwitch|noPropertyAccessFromIndexSignature|exactOptionalPropertyTypes|allowUnreachableCode|allowUnusedLabels|skipLibCheck|checkJs|allowJs|useUnknownInCatchVariables|alwaysStrict|noEmitOnError)"\s*:\s*[^,}\n]+/g;

/** Coverage thresholds in vitest/jest config or package.json. */
const COVERAGE = /\b(thresholds?|coverageThreshold|lines|branches|functions|statements|perFile|autoUpdate|fail_under|cov-fail-under)\b["']?\s*[:=]\s*[^,}\n]+/g;
const TEST_RUNNER_CONFIG = ["**/vitest.config.*", "**/vitest.workspace.*", "**/jest.config.*", "**/package.json", "**/.coveragerc"];
const COVERAGE_RATCHET_FILES = [
  ...TEST_RUNNER_CONFIG,
  "**/pytest.ini",
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/tox.ini",
  "**/.nycrc",
  "**/.nycrc.json",
  "**/nyc.config.*",
  "**/.c8rc",
  "**/.c8rc.json",
  "**/c8.config.*",
];
const COVERAGE_METRICS = new Set(["lines", "branches", "functions", "statements"]);

interface ThresholdSet {
  nums: Map<string, number[]>;
  bools: Map<string, boolean>;
}

function emptyThresholds(): ThresholdSet {
  return { nums: new Map(), bools: new Map() };
}

function addNum(set: ThresholdSet, key: string, value: number): void {
  const list = set.nums.get(key) ?? [];
  list.push(value);
  set.nums.set(key, list);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function addThresholdObject(prefix: string, node: unknown, set: ThresholdSet): void {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const n = asNumber(value);
    if (n != null && COVERAGE_METRICS.has(key)) addNum(set, `${prefix}.${key}`, n);
    else if (value && typeof value === "object") addThresholdObject(prefix, value, set);
  }
}

function addNycObject(prefix: string, node: unknown, set: ThresholdSet): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj["check-coverage"] === true) set.bools.set(`${prefix}.check-coverage`, true);
  else if (obj["check-coverage"] === false) set.bools.set(`${prefix}.check-coverage`, false);
  if (obj["check-coverage"] !== true) return;
  for (const key of COVERAGE_METRICS) {
    const n = asNumber(obj[key]);
    if (n != null) addNum(set, `${prefix}.${key}`, n);
  }
}

function addCliThresholds(text: string, set: ThresholdSet): void {
  const tool = /\bc8\b/.test(text) ? "c8" : /\bnyc\b/.test(text) ? "nyc" : null;
  const check = /(?:^|\s)--check-coverage\b/.test(text) && !/(?:^|\s)--no-check-coverage\b/.test(text);
  if (tool && check) {
    set.bools.set(`${tool}.check-coverage`, true);
    for (const metric of COVERAGE_METRICS) {
      for (const hit of text.matchAll(new RegExp(`--${metric}(?:=|\\s+)(\\d+(?:\\.\\d+)?)`, "g"))) addNum(set, `${tool}.${metric}`, Number(hit[1]));
    }
  } else if (tool && /(?:^|\s)--no-check-coverage\b/.test(text)) {
    set.bools.set(`${tool}.check-coverage`, false);
  }
  for (const hit of text.matchAll(/--cov-fail-under(?:=|\s+)(\d+(?:\.\d+)?)/g)) addNum(set, "cov-fail-under", Number(hit[1]));
}

function addPytestThresholds(text: string, set: ThresholdSet): void {
  for (const hit of text.matchAll(/(?:^|\n)\s*fail_under\s*=\s*(\d+(?:\.\d+)?)/g)) addNum(set, "fail_under", Number(hit[1]));
  addCliThresholds(text, set);
}

function sliceBalanced(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

function addJsCoverageBlocks(text: string, set: ThresholdSet): void {
  const re = /\b(coverageThreshold|thresholds)\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text))) {
    const brace = text.indexOf("{", hit.index + hit[0].length);
    if (brace < 0) continue;
    const body = sliceBalanced(text, brace);
    const prefix = hit[1] === "coverageThreshold" ? "jest" : "vitest";
    for (const metric of body.matchAll(/\b(lines|branches|functions|statements)\b["']?\s*:\s*["']?(\d+(?:\.\d+)?)/g)) {
      addNum(set, `${prefix}.${metric[1]}`, Number(metric[2]));
    }
    re.lastIndex = brace + body.length;
  }
  addCliThresholds(text, set);
}

function addJsonThresholds(name: string, text: string, set: ThresholdSet): void {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    addJsCoverageBlocks(text, set);
    addPytestThresholds(text, set);
    return;
  }
  if (!json || typeof json !== "object") return;
  const root = json as Record<string, unknown>;
  if (name === "package.json") {
    const jest = root.jest;
    if (jest && typeof jest === "object") addThresholdObject("jest", (jest as Record<string, unknown>).coverageThreshold, set);
    addNycObject("nyc", root.nyc, set);
    addNycObject("c8", root.c8, set);
    const scripts = root.scripts;
    if (scripts && typeof scripts === "object") {
      for (const value of Object.values(scripts as Record<string, unknown>)) {
        if (typeof value === "string") addCliThresholds(value, set);
      }
    }
    return;
  }
  addNycObject(name.includes("c8") ? "c8" : "nyc", root, set);
}

function addNycText(prefix: string, text: string, set: ThresholdSet): void {
  if (/["']?check-coverage["']?\s*:\s*true\b/.test(text)) {
    set.bools.set(`${prefix}.check-coverage`, true);
    for (const metric of COVERAGE_METRICS) {
      for (const hit of text.matchAll(new RegExp(`["']?${metric}["']?\\s*[:=]\\s*["']?(\\d+(?:\\.\\d+)?)`, "g"))) {
        addNum(set, `${prefix}.${metric}`, Number(hit[1]));
      }
    }
  } else if (/["']?check-coverage["']?\s*:\s*false\b/.test(text)) {
    set.bools.set(`${prefix}.check-coverage`, false);
  }
  addCliThresholds(text, set);
}

function extractThresholds(path: string, text: string): ThresholdSet {
  const set = emptyThresholds();
  const name = basename(path);
  if (name === "package.json" || name === ".nycrc" || name === ".nycrc.json" || name === ".c8rc" || name === ".c8rc.json") addJsonThresholds(name, text, set);
  else if (/(?:nyc|c8)\.config\./.test(name)) addNycText(name.includes("c8") ? "c8" : "nyc", text, set);
  else if (matchesAny(path, ["**/vitest.config.*", "**/vitest.workspace.*", "**/jest.config.*"])) addJsCoverageBlocks(text, set);
  if (name === "pyproject.toml" || name === "setup.cfg" || name === "tox.ini" || name === "pytest.ini" || name === ".coveragerc") addPytestThresholds(text, set);
  return set;
}

function gateTurnedOff(tool: string, before: ThresholdSet, after: ThresholdSet): boolean {
  const key = `${tool}.check-coverage`;
  return before.bools.get(key) === true && after.bools.get(key) !== true;
}

/**
 * A lowered coverage threshold. Absent when nothing enforced was lowered (raising and adding stay allowed).
 * Compared kinds: vitest/jest coverageThreshold, pytest fail_under / --cov-fail-under, nyc/c8 check-coverage.
 */
export function coverageRatchet(path: string, before: string | undefined, after: string | undefined): string | undefined {
  if (before === undefined || before === after || !matchesAny(path, COVERAGE_RATCHET_FILES)) return undefined;
  const prior = extractThresholds(path, before);
  const next = extractThresholds(path, after ?? "");
  const lowered: string[] = [];
  for (const [key, was] of prior.bools) {
    if (was === true && next.bools.get(key) !== true) lowered.push(`${key} turned off`);
  }
  for (const [key, values] of prior.nums) {
    const tool = key.split(".")[0]!;
    if ((tool === "nyc" || tool === "c8") && gateTurnedOff(tool, prior, next)) continue;
    const beforeSorted = [...values].sort((a, b) => b - a);
    const afterSorted = [...(next.nums.get(key) ?? [])].sort((a, b) => b - a);
    if (afterSorted.length < beforeSorted.length) lowered.push(`${key} removed`);
    for (let i = 0; i < Math.min(beforeSorted.length, afterSorted.length); i++) {
      if (afterSorted[i]! < beforeSorted[i]!) lowered.push(`${key} ${beforeSorted[i]} -> ${afterSorted[i]}`);
    }
  }
  if (!lowered.length) return undefined;
  return `${path}: coverage threshold lowered (${lowered.join("; ")})`;
}

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
  { marker: "nosemgrep", pattern: /(?:#|\/\/)\s*nosemgrep\b/ },
  { marker: "gitleaks:allow", pattern: /(?:#|\/\/)\s*gitleaks:allow\b/ },
  { marker: "# shellcheck disable", pattern: /#\s*shellcheck\s+disable\b/ },
  { marker: "# nosec", pattern: /#\s*nosec\b/ },
  { marker: "pragma: no cover", pattern: /#\s*pragma:\s*no\s+cover\b/ },
];

/** Prose files may mention markers without suppressing anything. */
const PROSE = /\.(md|mdx|markdown|txt|rst)$/i;

const sorted = (xs: string[]) => xs.map((x) => x.replace(/\s+/g, " ").trim()).sort().join("\n");

/** Check fields that define what runs; `timeout_s` and `timeout_minutes` are handled separately in config_guard. */
const checkIdentity = (c: { name: string; run: string; tier: string; paths?: string[]; services?: string[]; local_only?: boolean }) => ({
  name: c.name,
  run: c.run,
  tier: c.tier,
  paths: c.paths,
  services: c.services,
  local_only: c.local_only,
});

/** Effective wall-clock cap in seconds. `timeout_s` wins over `timeout_minutes` and the repo default. */
const effectiveCheckTimeoutSeconds = (cfg: RepoConfig, c: { timeout_s?: number; timeout_minutes?: number }) =>
  c.timeout_s ?? (c.timeout_minutes ?? cfg.limits.gate_timeout_minutes) * 60;

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
  if (matchesAny(path, SECURITY_CONFIG)) return "security tool config changed";
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
    else if (now.flake_allow && c.flake_allow !== now.flake_allow) out.push(`check ${c.name} flake_allow set (${now.flake_allow})`);
    else if (c.owner && !now.owner) out.push(`check ${c.name} owner removed`);
    else if (!same(checkIdentity(c), checkIdentity(now))) out.push(`check ${c.name} changed (run, tier, paths, services or local_only)`);
  }
  if (a.limits.gate_timeout_minutes > b.limits.gate_timeout_minutes) out.push("limits.gate_timeout_minutes raised");
  for (const c of b.checks) {
    const now = a.checks.find((x) => x.name === c.name);
    if (!now) continue;
    const beforeEff = effectiveCheckTimeoutSeconds(b, c);
    const afterEff = effectiveCheckTimeoutSeconds(a, now);
    if (afterEff <= beforeEff) continue;
    const explicit =
      c.timeout_s !== undefined || now.timeout_s !== undefined || c.timeout_minutes !== undefined || now.timeout_minutes !== undefined;
    if (explicit || a.limits.gate_timeout_minutes === b.limits.gate_timeout_minutes) {
      out.push(`check ${c.name} timeout raised`);
    }
  }
  const testTimeoutS = (cfg: RepoConfig) => cfg.tests.timeout_s ?? cfg.limits.gate_timeout_minutes * 60;
  if (testTimeoutS(a) > testTimeoutS(b)) {
    const explicit = a.tests.timeout_s !== undefined || b.tests.timeout_s !== undefined;
    if (explicit || a.limits.gate_timeout_minutes === b.limits.gate_timeout_minutes) out.push("tests.timeout_s raised");
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
  if (b.limits.diff_count_tests && !a.limits.diff_count_tests) out.push("limits.diff_count_tests turned off");
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
  if (a.concurrency.max_runs > b.concurrency.max_runs) out.push("concurrency.max_runs raised");
  removed("concurrency.exclusive_paths", b.concurrency.exclusive_paths, a.concurrency.exclusive_paths);
  removed("concurrency.resources", b.concurrency.resources, a.concurrency.resources);
  const exKey = (e: { tool: string; rule: string }) => `${e.tool}:${e.rule}`;
  const added = a.tool_exceptions.filter((e) => !b.tool_exceptions.some((x) => exKey(x) === exKey(e)));
  if (added.length) out.push(`tool_exceptions added: ${added.map(exKey).join(", ")}`);
  if (b.baseline.require_tools && !a.baseline.require_tools) out.push("baseline.require_tools turned off");
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

function standardsRemovalHow(): string {
  return `declare it by listing ${STANDARDS_REL} in a package's files and naming the rule, or the check as a whole word, in the goal, an acceptance criterion, or protected_changes (not in out_of_scope)`;
}

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

export interface WorkflowJobRemoval {
  file: string;
  /** Job id that was removed, or whose `name:` changed. */
  id: string;
  /** Previous `name:`, or the id when unset. */
  name: string;
  kind: "removed" | "renamed";
}

function workflowJobs(text: string | undefined): { id: string; name: string }[] | null {
  if (text === undefined) return [];
  let doc: unknown;
  try {
    doc = parse(text) ?? {};
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return [];
  const jobs = (doc as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.entries(jobs as Record<string, unknown>).flatMap(([id, raw]) => {
    if (!id) return [];
    const named = raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string" ? (raw as { name: string }).name.trim() : "";
    return [{ id, name: named || id }];
  });
}

/**
 * A job id that disappeared, or a `name:` that changed, in a workflow file. Adding a job or editing
 * its steps is not a loosening. An unparsable after-file cannot prove the jobs remain.
 */
export function workflowJobLoosening(file: string, before: string | undefined, after: string | undefined): WorkflowJobRemoval[] {
  if (!WORKFLOW_FILE.test(file.replaceAll("\\", "/")) || before === undefined || before === after) return [];
  const oldJobs = workflowJobs(before);
  if (!oldJobs?.length) return [];
  const newJobs = workflowJobs(after);
  if (newJobs === null) return oldJobs.map((job) => ({ file, id: job.id, name: job.name, kind: "removed" as const }));
  const out: WorkflowJobRemoval[] = [];
  for (const job of oldJobs) {
    const now = newJobs.find((j) => j.id === job.id);
    if (!now) out.push({ file, id: job.id, name: job.name, kind: "removed" });
    else if (now.name !== job.name) out.push({ file, id: job.id, name: job.name, kind: "renamed" });
  }
  return out;
}

function namesJob(text: string, job: string): boolean {
  const name = job.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(text);
}

function jobRemovalDeclared(plan: Plan, packages: string[], removal: WorkflowJobRemoval): boolean {
  const files = new Set(plan.packages.filter((p) => packages.includes(p.id)).flatMap((p) => p.files));
  if (!files.has(removal.file)) return false;
  const text = (plan.protected_changes ?? [])
    .filter((c) => c.file === removal.file)
    .map((c) => `${c.change}\n${c.reason}`)
    .join("\n");
  return namesJob(text, removal.id) || namesJob(text, removal.name);
}

function describeJobRemoval(r: WorkflowJobRemoval): string {
  const label = r.name !== r.id ? `${r.id} (name: ${r.name})` : r.id;
  const verb = r.kind === "renamed" ? "renamed" : "removed";
  return `job ${label} ${verb} (loosens a required check; name the job in that file's protected_changes)`;
}

/**
 * A removed check is retired, not weakened, when the plan lists repo.yaml, names the old check,
 * adds the replacement it names, and the acceptance has both a failing and a passing probe for
 * that replacement. Any other loosening stays a loosening.
 */
export function equivalentReplacement(plan: Plan, packages: string[], removed: string, added: readonly string[]): boolean {
  const files = plan.packages.filter((p) => packages.includes(p.id)).flatMap((p) => p.files);
  if (!files.includes(REPO_CONFIG_PATH)) return false;
  const acceptance = plan.acceptance.map((a) => a.text).join("\n");
  const fails = new Set([...acceptance.matchAll(/probe fail:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
  const passes = new Set([...acceptance.matchAll(/probe pass:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!));
  const text = [
    plan.goal,
    ...plan.packages.filter((p) => packages.includes(p.id)).flatMap((p) => [p.title, p.description]),
    ...plan.acceptance.filter((a) => packages.includes(a.package)).map((a) => a.text),
    ...(plan.protected_changes ?? []).flatMap((c) => [c.change, c.reason]),
  ].join("\n");
  if (!namesCheck(text, removed)) return false;
  return added.some((name) => fails.has(name) && passes.has(name) && namesCheck(text, name));
}

function addedCheckNames(before: string | undefined, after: string | undefined): string[] {
  if (before === undefined || after === undefined) return [];
  let previous: RepoConfig;
  let next: RepoConfig;
  try {
    previous = parseRepoConfig(before);
    next = parseRepoConfig(after);
  } catch {
    return [];
  }
  const had = new Set(previous.checks.map((c) => c.name));
  return next.checks.map((c) => c.name).filter((name) => !had.has(name));
}

/** The gate over precomputed inputs (pure, for tests). */
export function configGuard(input: {
  plan: Plan;
  packages: string[];
  configChanges: { file: string; why: string }[];
  suppressions: { file: string; marker: string; line: string }[];
  /** repo.yaml loosening: fails even when the plan declares the file a protected change. */
  loosening?: string[];
  /** Lowered coverage threshold: fails even when the plan lists the file. Raising is not listed here. */
  thresholdLoosening?: string[];
  /** Rule or marker removed from standards.md. Declared only when a package lists the file and the rule text, or the check name as a whole word, is in the goal, acceptance, or protected_changes. */
  standardsRemovals?: StandardsRemoval[];
  /** Workflow job removed or renamed. Declared only when a package lists the file and protected_changes names the job. */
  jobLoosening?: WorkflowJobRemoval[];
  /** Check names present after the edit and absent before. A removal is retired only when one of these is the probed replacement. */
  addedChecks?: readonly string[];
  /** Issue labels. `factory:red-green-not-applicable` is a red-green loosening and needs `red_green_reason`. */
  labels?: string[];
}): BuiltinResult {
  const files = input.plan.packages.filter((p) => input.packages.includes(p.id)).flatMap((p) => p.files);
  const text = planText(input.plan, input.packages);
  const inScope = (f: string) => files.includes(f) || matchesAny(f, files);
  const exemption = redGreenLoosening(input.plan, input.labels ?? []);
  const bad = [
    ...input.configChanges.filter((c) => !inScope(c.file)).map((c) => `${c.file}: ${c.why} (not in the plan's files)`),
    ...input.suppressions.filter((s) => !text.includes(s.marker.toLowerCase())).map((s) => `${s.file}: adds \`${s.marker}\`: ${s.line.slice(0, 120)}`),
    ...(input.loosening ?? [])
      .filter((line) => {
        const removed = /^check (\S+) removed$/.exec(line);
        return !removed || !equivalentReplacement(input.plan, input.packages, removed[1]!, input.addedChecks ?? []);
      })
      .map((l) => `${REPO_CONFIG_PATH}: ${l} (loosens the factory's own checks; only a human makes this edit)`),
    ...(input.thresholdLoosening ?? []),
    ...(input.standardsRemovals ?? [])
      .filter((r) => !standardsRemovalDeclared(input.plan, r))
      .map((r) => `${STANDARDS_REL}: ${describeStandardsRemoval(r)} (loosens a repo standard; ${standardsRemovalHow()})`),
    ...(input.jobLoosening ?? []).filter((r) => !jobRemovalDeclared(input.plan, input.packages, r)).map((r) => `${r.file}: ${describeJobRemoval(r)}`),
    ...(exemption.fail ? [exemption.fail] : []),
  ];
  const note = exemption.note ?? "";
  if (bad.length) {
    const tail = note ? `\n${note}` : "";
    return { name: "config_guard", ok: false, detail: `fix the code instead of loosening the tools (bug):\n- ${bad.join("\n- ")}${tail}` };
  }
  return { name: "config_guard", ok: true, detail: note };
}

/** Collects config changes and added suppressions in a worktree against `base` (stage first). */
export async function configGuardInputs(cwd: string, base: string, changed: string[]): Promise<Pick<Parameters<typeof configGuard>[0], "configChanges" | "suppressions" | "loosening" | "thresholdLoosening" | "standardsRemovals" | "jobLoosening" | "addedChecks">> {
  const mb = await mergeBase(cwd, base);
  const configChanges: { file: string; why: string }[] = [];
  const thresholdLoosening: string[] = [];
  const jobLoosening: WorkflowJobRemoval[] = [];
  let loosening: string[] = [];
  let addedChecks: string[] = [];
  let standards: StandardsRemoval[] = [];
  for (const file of changed) {
    const before = await git(cwd, ["show", `${mb}:${file}`]).catch(() => undefined);
    const after = await readFile(join(cwd, file), "utf8").catch(() => undefined);
    const why = configChange(file, before, after);
    if (why) configChanges.push({ file, why });
    const lowered = coverageRatchet(file, before, after);
    if (lowered) thresholdLoosening.push(lowered);
    jobLoosening.push(...workflowJobLoosening(file, before, after));
    if (file === REPO_CONFIG_PATH) {
      loosening = repoConfigLoosening(before, after);
      addedChecks = addedCheckNames(before, after);
    }
    if (file === STANDARDS_REL) standards = standardsRemovals(before, after);
  }
  return { configChanges, suppressions: addedSuppressions(await diffText(cwd, base)), loosening, thresholdLoosening, standardsRemovals: standards, jobLoosening, addedChecks };
}
