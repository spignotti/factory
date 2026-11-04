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

/** A check that runs in CI (fast or full, not local_only). The caller drops swallowed commands. */
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
      // Content-bound is a regex of the secret text (docs/BASELINE.md). `commits` still hides every
      // finding in that commit, so a commit list with a description is not enough.
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

const PYRIGHT_MODE = /^\s*typeCheckingMode\s*[:=]\s*["']?(off|basic|standard|strict)["']?/i;

/** A mode written on its own line. Comments do not count. */
function explicitPyrightMode(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/(^|\s)#.*$/, "").trim();
    const mode = PYRIGHT_MODE.exec(stripped)?.[1];
    if (mode) return mode;
  }
  return undefined;
}

/** Body of `[tool.pyright]`, or undefined when the table is absent. An empty table is `""`. */
function pyrightTable(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[tool.pyright]");
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\[/.test(line.trim())) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * pyright `typeCheckingMode`, else mypy `strict` as `strict` and a configured mypy without it as `basic`.
 * pyright's documented default is `standard` when `pyrightconfig.json` or `[tool.pyright]` omits the key.
 * `pyrightconfig.json` wins over `pyproject.toml` when both exist.
 */
export function typeCheckingMode(dir: string): { tool: "pyright" | "mypy"; mode: string } | undefined {
  const json = read(dir, "pyrightconfig.json");
  if (json !== undefined) {
    try {
      const mode = (JSON.parse(json) as { typeCheckingMode?: unknown }).typeCheckingMode;
      if (mode === undefined) return { tool: "pyright", mode: "standard" };
      if (typeof mode === "string") return { tool: "pyright", mode };
      return { tool: "pyright", mode: "invalid" };
    } catch {
      return { tool: "pyright", mode: "invalid" };
    }
  }
  const pyproject = read(dir, "pyproject.toml");
  if (pyproject !== undefined) {
    const table = pyrightTable(pyproject);
    if (table !== undefined) return { tool: "pyright", mode: explicitPyrightMode(table) ?? "standard" };
  }
  const sources = [pyproject, read(dir, "mypy.ini"), read(dir, ".mypy.ini"), read(dir, "setup.cfg")].filter((t): t is string => t !== undefined);
  for (const text of sources) {
    const mode = explicitPyrightMode(text);
    if (mode) return { tool: "pyright", mode };
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
 * Job id or name that shares a pull_request workflow but does not gate the merge: path filters
 * (`changes`), release and publish, automerge (`enable`) and `meta`.
 */
const NON_GATING_JOBS = new Set(["changes", "release", "publish", "enable", "meta", "automerge", "auto-merge"]);

function isNonGatingJob(id: string, name: string | undefined): boolean {
  return [id, name ?? ""].some((n) => NON_GATING_JOBS.has(n.trim().toLowerCase()));
}

/** True when a job or step `if` cannot hold for a pull_request event. */
function skipsPullRequest(expr: string | undefined): boolean {
  if (!expr?.trim()) return false;
  const compact = expr.replace(/\s+/g, " ");
  if (/github\.event_name\s*==\s*['"]pull_request(?:_target)?['"]/.test(compact)) return false;
  if (/github\.event_name\s*!=\s*['"]pull_request(?:_target)?['"]/.test(compact)) return true;
  const nonPr = /github\.event_name\s*==\s*['"](push|release|workflow_dispatch|schedule|workflow_call|merge_group)['"]/.test(compact);
  return nonPr || /refs\/tags/.test(compact);
}

interface WorkflowJobView {
  /** Check-run name GitHub reports (job `name`, else the id). */
  label: string;
  /** Runs on a pull request and is a merge gate. */
  blocksPr: boolean;
  runs: string[];
}

function jobRunScripts(job: { steps?: unknown }): string[] {
  if (!Array.isArray(job.steps)) return [];
  const runs: string[] = [];
  for (const step of job.steps) {
    if (!step || typeof step !== "object") continue;
    const row = step as { if?: unknown; run?: unknown };
    if (skipsPullRequest(typeof row.if === "string" ? row.if : undefined)) continue;
    if (typeof row.run === "string" && row.run.trim()) runs.push(row.run);
  }
  return runs;
}

function prJobs(doc: unknown, stub: boolean): WorkflowJobView[] {
  if (!triggersOf(doc).some((t) => t === "pull_request" || t === "pull_request_target")) return [];
  const jobs = (doc as { jobs?: Record<string, { name?: unknown; if?: unknown; steps?: unknown }> } | null)?.jobs ?? {};
  const out: WorkflowJobView[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    // The stub blocks through `done` only; `select` and `check` feed that job.
    if (stub && id !== "done") continue;
    const name = typeof job?.name === "string" && job.name.trim() ? job.name.trim() : undefined;
    const blocksPr = !isNonGatingJob(id, name) && !skipsPullRequest(typeof job?.if === "string" ? job.if : undefined);
    out.push({ label: name ?? id, blocksPr, runs: blocksPr ? jobRunScripts(job ?? {}) : [] });
  }
  return out;
}

/**
 * Check-run names that gate a pull request. Release, publish, path-filter and automerge helpers
 * are omitted, as are jobs whose `if` does not run on pull_request.
 */
export function blockingJobs(dir: string): string[] {
  const out: string[] = [];
  for (const file of workflowFiles(dir)) {
    const stub = `.github/workflows/${file.name}` === ".github/workflows/factory.yml";
    for (const job of prJobs(file.doc, stub)) if (job.blocksPr) out.push(job.label);
  }
  return [...new Set(out)];
}

interface NoxSession {
  name: string;
  defaultOn: boolean;
  body: string;
}

function stripPyComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

/** `@nox.session` functions. `default=False` sessions stay out of a bare `nox` run. */
function parseNoxSessions(text: string): NoxSession[] {
  const lines = text.split(/\r?\n/);
  const out: NoxSession[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith("@nox.session")) {
      i++;
      continue;
    }
    const deco: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("def ")) {
      const line = lines[i]!;
      if (line.trim() === "" || line.startsWith("@") || /^[ \t]/.test(line)) {
        deco.push(line);
        i++;
        continue;
      }
      break;
    }
    const def = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i] ?? "");
    if (!def) {
      i++;
      continue;
    }
    const name = def[1]!;
    i++;
    const body: string[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
      body.push(line);
      i++;
    }
    out.push({ name, defaultOn: !/default\s*=\s*False/.test(deco.join("\n")), body: body.join("\n") });
  }
  return out;
}

/**
 * Session names a command passes to nox (`nox -s quality`, `uvx nox -s quality`).
 * Null when the command does not invoke nox. Empty means the default sessions.
 */
function noxSessionNames(command: string): string[] | null {
  if (!/\bnox\b/.test(command)) return null;
  const names = new Set<string>();
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!.replace(/[";&|]+$/g, "");
    if (flag === "-s" || flag === "--session" || flag === "--sessions") {
      for (let j = i + 1; j < tokens.length; j++) {
        const raw = tokens[j]!;
        if (raw.startsWith("-")) break;
        const name = raw.replace(/^[("']+|[)"',]+$/g, "").replace(/\(.*$/, "");
        if (!/^[A-Za-z_][\w]*$/.test(name)) break;
        names.add(name);
        i = j;
      }
    } else if (/^--sessions?=/.test(flag)) {
      const name = flag.split("=")[1]?.replace(/["']/g, "").replace(/\(.*$/, "");
      if (name && /^[A-Za-z_][\w]*$/.test(name)) names.add(name);
    }
  }
  for (const match of command.matchAll(/["']nox["']\s*,\s*["'](?:-s|--sessions?)["']\s*,\s*["']([A-Za-z_][\w]*)["']/g)) names.add(match[1]!);
  return [...names];
}

function sessionClosure(sessions: NoxSession[], name: string, seen: Set<string>): string {
  if (seen.has(name)) return "";
  seen.add(name);
  const session = sessions.find((s) => s.name === name);
  if (!session) return "";
  const body = stripPyComments(session.body);
  const notified = [...body.matchAll(/session\.notify\(\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  const nested = noxSessionNames(body) ?? [];
  return [body, ...[...notified, ...nested].map((child) => sessionClosure(sessions, child, seen))].join("\n");
}

/**
 * Commands that can fail a pull request: repo.yaml checks and pull_request job steps, plus the
 * nox session bodies those commands run. Swallowed commands (`|| true`) are left out.
 */
export function blockingAuditTexts(dir: string, repo: Pick<RepoConfig, "checks">): string[] {
  const commands = blockingRuns(repo).filter((run) => !swallowed(run));
  for (const file of workflowFiles(dir)) {
    const stub = `.github/workflows/${file.name}` === ".github/workflows/factory.yml";
    for (const job of prJobs(file.doc, stub)) {
      if (!job.blocksPr) continue;
      for (const run of job.runs) if (!swallowed(run)) commands.push(run);
    }
  }
  const noxfile = read(dir, "noxfile.py");
  if (!noxfile) return commands;
  const sessions = parseNoxSessions(noxfile);
  const extra: string[] = [];
  for (const command of commands) {
    const picked = noxSessionNames(command);
    if (picked === null) continue;
    const names = picked.length > 0 ? picked : sessions.filter((s) => s.defaultOn).map((s) => s.name);
    extra.push(names.map((name) => sessionClosure(sessions, name, new Set())).join("\n"));
  }
  return [...commands, ...extra];
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
