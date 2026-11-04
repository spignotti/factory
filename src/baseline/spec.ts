import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { asset } from "../prompts.js";
import type { RepoConfig } from "../schemas/repo.js";
import type { Toolchains } from "../toolchains.js";

/** Shipped baseline (`templates/baseline/`). Bump `VERSION` when a code or a rule changes. */
export function baselineRoot(): string {
  return fileURLToPath(new URL("../../templates/baseline", import.meta.url));
}

export function baselineVersion(): string {
  return asset("templates/baseline/VERSION").trim();
}

export function semgrepRulesDir(): string {
  return join(baselineRoot(), "semgrep", "rules");
}

/**
 * Ruff `select` the Python baseline requires. A repo covers a code by selecting it (or a prefix,
 * or `ALL`) or by a `tool_exceptions` entry for that code.
 */
export const RUFF_BASELINE = ["E", "F", "W", "I", "UP", "B", "S", "BLE", "C4", "SIM", "RUF", "ASYNC"] as const;

/** Registry rulesets a semgrep invocation must name. `p/python` may stand in for `p/default`. */
export const SEMGREP_REGISTRY = ["p/owasp-top-ten", "p/secrets"] as const;
export const SEMGREP_BASE_RULESETS = ["p/default", "p/python"] as const;

/** `selected` covers `code` when it is `ALL`, equal, or a prefix (`E` covers `E501`, not the reverse). */
export function ruleCovered(selected: readonly string[], code: string): boolean {
  return selected.some((s) => s === "ALL" || s === code || code.startsWith(s));
}

/** An ignore still applies to something that is selected (a broader ignore counts). */
export function ignoreLive(selected: readonly string[], code: string): boolean {
  return selected.some((s) => s === "ALL" || s === code || s.startsWith(code) || code.startsWith(s));
}

export interface RuffConfig {
  extend?: string;
  select: string[];
  extendSelect: string[];
  ignore: string[];
  perFileIgnores: string[];
}

const CODE = /\b([A-Z][A-Z0-9]{0,9})\b/g;

function codesFrom(value: string): string[] {
  return [...value.matchAll(CODE)].map((m) => m[1]!).filter((c) => c === "ALL" || /^[A-Z]+[0-9]*$/.test(c));
}

function unquote(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * The subset of ruff's TOML that doctor needs (select, ignore, extend). `pyproject` is true for
 * `pyproject.toml`, where only `[tool.ruff…]` counts.
 */
export function parseRuffToml(text: string, pyproject: boolean): RuffConfig {
  const out: RuffConfig = { select: [], extendSelect: [], ignore: [], perFileIgnores: [] };
  let section: string | undefined = pyproject ? undefined : "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const stripped = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!stripped) continue;
    const header = /^\[([^\]]+)\]$/.exec(stripped);
    if (header) {
      const name = header[1]!.trim();
      if (!pyproject) section = name;
      else if (name === "tool.ruff") section = "";
      else if (name.startsWith("tool.ruff.")) section = name.slice("tool.ruff.".length);
      else section = undefined;
      continue;
    }
    if (section === undefined) continue;
    if (section === "lint.per-file-ignores" || section === "per-file-ignores") {
      out.perFileIgnores.push(...codesFrom(stripped));
      continue;
    }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(stripped);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2] ?? "";
    if (value.includes("[") && !value.includes("]")) {
      while (!value.includes("]") && i + 1 < lines.length) {
        i++;
        value += `\n${(lines[i] ?? "").replace(/(^|\s)#.*$/, "")}`;
      }
    }
    const topOrLint = section === "" || section === "lint";
    if (key === "extend" && section === "") out.extend = unquote(value);
    if (!topOrLint) continue;
    if (key === "select") out.select.push(...codesFrom(value));
    else if (key === "extend-select") out.extendSelect.push(...codesFrom(value));
    else if (key === "ignore" || key === "extend-ignore") out.ignore.push(...codesFrom(value));
  }
  return out;
}

export interface EffectiveRuff {
  /** A ruff config file (or a `[tool.ruff]` section) is present. */
  found: boolean;
  select: string[];
  ignore: string[];
  /** extend path that could not be read. */
  missingExtend?: string;
}

function mergeRuff(parent: RuffConfig, child: RuffConfig): { select: string[]; ignore: string[] } {
  const select = [...(child.select.length ? child.select : parent.select), ...child.extendSelect];
  const ignore = [...parent.ignore, ...parent.perFileIgnores, ...child.ignore, ...child.perFileIgnores];
  return { select, ignore };
}

/** Effective select/ignore from `ruff.toml`, `.ruff.toml` or `[tool.ruff]` in pyproject, one extend deep. */
export function loadRuff(dir: string): EffectiveRuff {
  const pyprojectPath = join(dir, "pyproject.toml");
  const pyproject = existsSync(pyprojectPath) ? readFileSync(pyprojectPath, "utf8") : undefined;
  const py = pyproject !== undefined ? parseRuffToml(pyproject, true) : undefined;
  const named = ["ruff.toml", ".ruff.toml"].find((n) => existsSync(join(dir, n)));
  const file = named ? parseRuffToml(readFileSync(join(dir, named), "utf8"), false) : undefined;
  const child = file ?? (py && (py.select.length || py.extend || py.ignore.length || py.perFileIgnores.length || py.extendSelect.length) ? py : undefined);
  if (!child) return { found: false, select: [], ignore: [] };
  if (!child.extend) return { found: true, ...mergeRuff({ select: [], extendSelect: [], ignore: [], perFileIgnores: [] }, child) };
  const extPath = join(dirname(join(dir, named ?? "pyproject.toml")), child.extend);
  if (!existsSync(extPath)) return { found: true, ...mergeRuff({ select: [], extendSelect: [], ignore: [], perFileIgnores: [] }, child), missingExtend: child.extend };
  const parent = parseRuffToml(readFileSync(extPath, "utf8"), extPath.endsWith("pyproject.toml"));
  return { found: true, ...mergeRuff(parent, child) };
}

export function exceptionRules(repo: Pick<RepoConfig, "tool_exceptions">, tool: string): string[] {
  return repo.tool_exceptions.filter((e) => e.tool === tool).map((e) => e.rule);
}

const read = (dir: string, name: string): string | undefined => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);

export function isPythonProject(dir: string, toolchains: Pick<Toolchains, "python" | "uv">): boolean {
  if (toolchains.uv || toolchains.python) return true;
  return ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py", "Pipfile", "uv.lock", "ruff.toml", ".ruff.toml", "pyrightconfig.json", "mypy.ini", ".mypy.ini"].some((n) => existsSync(join(dir, n)));
}

export function isPnpmProject(dir: string, toolchains: Pick<Toolchains, "pnpm">): boolean {
  return toolchains.pnpm || existsSync(join(dir, "pnpm-lock.yaml"));
}

export function isNpmProject(dir: string, pnpm: boolean): boolean {
  return !pnpm && (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json")));
}

const IMAGE_FILES = ["Dockerfile", "Containerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export function hasImageBuild(dir: string): boolean {
  if (IMAGE_FILES.some((n) => existsSync(join(dir, n)))) return true;
  try {
    return readdirSync(dir).some((n) => n.startsWith("Dockerfile"));
  } catch {
    return false;
  }
}

/** Check commands plus workflow sources: where a tool invocation can live. */
export function scanText(dir: string, repo: Pick<RepoConfig, "checks">): string {
  const parts = [repo.checks.map((c) => c.run).join("\n")];
  const wf = join(dir, ".github", "workflows");
  if (existsSync(wf)) {
    for (const name of readdirSync(wf)) {
      if (/\.ya?ml$/.test(name)) parts.push(read(wf, name) ?? "");
    }
  }
  return parts.join("\n");
}

/** A check that runs in CI (fast or full, not local_only) and is not swallowed. */
export function blockingRuns(repo: Pick<RepoConfig, "checks">): string[] {
  return repo.checks.filter((c) => c.tier !== "manual" && !c.local_only).map((c) => c.run);
}

export function swallowed(run: string): boolean {
  return /\|\|\s*true\b/.test(run) || /\|\|\s*:\s*$/.test(run);
}

/** pnpm/npm `--audit-level` at least `high` (low and moderate are stricter; critical is weaker). */
export function auditLevelOk(run: string): boolean {
  const m = /--audit-level(?:=|\s+)([A-Za-z]+)/.exec(run);
  if (!m) return true;
  return ["low", "moderate", "high"].includes(m[1]!.toLowerCase());
}

export interface TrivyIgnoreIssue {
  line: number;
  id: string;
}

/** `.trivyignore` entries whose id has no reason comment on the same line or the line above. */
export function trivyIgnoreIssues(text: string): TrivyIgnoreIssue[] {
  const out: TrivyIgnoreIssue[] = [];
  let pending = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) {
      pending = false;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pending = true;
      continue;
    }
    const hash = raw.indexOf("#");
    const inline = hash >= 0 && raw.slice(hash + 1).trim().length > 0;
    const id = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (id && !inline && !pending) out.push({ line: i + 1, id });
    pending = false;
  }
  return out;
}

export interface GitleaksAllowlist {
  description: boolean;
  /** A regex of the matched secret, not a path or a commit. */
  contentBound: boolean;
}

/**
 * `[extend] useDefault` and each `[[allowlists]]` block. Absent file → the built-in rules.
 * A present file keeps the built-in rules only when it sets `useDefault = true` (a config that
 * lists its own `[[rules]]` replaces the defaults otherwise).
 */
export function parseGitleaks(text: string | undefined): { present: boolean; useDefault: boolean; allowlists: GitleaksAllowlist[] } {
  if (text === undefined) return { present: false, useDefault: true, allowlists: [] };
  const useDefault = /^\s*useDefault\s*=\s*true\b/m.test(text);
  const allowlists: GitleaksAllowlist[] = [];
  const parts = text.split(/^\s*\[\[allowlists\]\]\s*$/m).slice(1);
  for (const part of parts) {
    const body = part.split(/^\s*\[\[/)[0] ?? "";
    allowlists.push({
      description: /^\s*description\s*=\s*\S/m.test(body),
      contentBound: /^\s*regexes\s*=/m.test(body) || /^\s*regexTarget\s*=\s*"match"/m.test(body) || /^\s*stopwords\s*=/m.test(body),
    });
  }
  return { present: true, useDefault, allowlists };
}

const PYRIGHT_RANK: Record<string, number> = { off: 0, basic: 1, standard: 2, strict: 3 };

export function pyrightRank(mode: string | undefined): number | undefined {
  if (!mode) return undefined;
  return PYRIGHT_RANK[mode.toLowerCase()];
}

/** pyright `typeCheckingMode`, else mypy `strict` as `strict` and a configured mypy without it as `basic`. */
export function typeCheckingMode(dir: string): { tool: "pyright" | "mypy"; mode: string } | undefined {
  const json = read(dir, "pyrightconfig.json");
  if (json !== undefined) {
    try {
      const mode = (JSON.parse(json) as { typeCheckingMode?: unknown }).typeCheckingMode;
      if (typeof mode === "string") return { tool: "pyright", mode };
    } catch {
      return { tool: "pyright", mode: "invalid" };
    }
  }
  const sources = [read(dir, "pyproject.toml"), read(dir, "mypy.ini"), read(dir, ".mypy.ini"), read(dir, "setup.cfg")].filter((t): t is string => t !== undefined);
  for (const text of sources) {
    const py = /typeCheckingMode\s*[:=]\s*["']?(off|basic|standard|strict)["']?/i.exec(text);
    if (py) return { tool: "pyright", mode: py[1]! };
  }
  for (const text of sources) {
    if (!/\[(tool\.mypy|mypy[^\]]*)\]/.test(text)) continue;
    const section = text.split(/\[(?:tool\.mypy|mypy[^\]]*)\]/)[1]?.split(/\n\[/)[0] ?? "";
    return { tool: "mypy", mode: /^\s*strict\s*=\s*True\b/m.test(section) ? "strict" : "basic" };
  }
  return undefined;
}

/** Workflow files and parsed documents for the dependabot and branch-protection checks. */
export function workflowFiles(dir: string): { name: string; text: string; doc: unknown }[] {
  const wf = join(dir, ".github", "workflows");
  if (!existsSync(wf)) return [];
  const out: { name: string; text: string; doc: unknown }[] = [];
  for (const name of readdirSync(wf).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const text = readFileSync(join(wf, name), "utf8");
    let doc: unknown;
    try {
      doc = parse(text);
    } catch {
      doc = null;
    }
    out.push({ name, text, doc });
  }
  return out;
}

function triggersOf(doc: unknown): string[] {
  const wf = doc as { on?: unknown; true?: unknown } | null;
  const on = wf?.on ?? wf?.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/**
 * Job names that block a pull request. The factory stub blocks through its `done` job only
 * (`select` and `check` feed that job). Other workflows contribute every job.
 */
export function blockingJobs(dir: string): string[] {
  const out: string[] = [];
  for (const file of workflowFiles(dir)) {
    if (!triggersOf(file.doc).some((t) => t === "pull_request" || t === "pull_request_target")) continue;
    const jobs = (file.doc as { jobs?: Record<string, { name?: unknown }> } | null)?.jobs ?? {};
    const stub = `.github/workflows/${file.name}` === ".github/workflows/factory.yml";
    for (const [id, job] of Object.entries(jobs)) {
      if (stub && id !== "done") continue;
      const label = typeof job?.name === "string" && job.name.trim() ? job.name.trim() : id;
      out.push(label);
    }
  }
  return [...new Set(out)];
}

export interface DependabotUpdate {
  ecosystem: string;
  exclude: string[];
}

export function dependabotUpdates(text: string | undefined): { error?: string; updates: DependabotUpdate[] } {
  if (text === undefined) return { updates: [] };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0]!.slice(0, 160), updates: [] };
  }
  const updates = (doc as { updates?: unknown } | null)?.updates;
  if (!Array.isArray(updates)) return { updates: [] };
  return {
    updates: updates.map((u) => {
      const row = u as { "package-ecosystem"?: unknown; "exclude-paths"?: unknown };
      const exclude = Array.isArray(row?.["exclude-paths"]) ? row["exclude-paths"].filter((p): p is string => typeof p === "string") : [];
      return { ecosystem: typeof row?.["package-ecosystem"] === "string" ? row["package-ecosystem"] : "", exclude };
    }),
  };
}
