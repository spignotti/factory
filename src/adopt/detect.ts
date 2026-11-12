import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CI_STUB_PATH } from "../ci.js";
import { migrationDirGlobs } from "../paths.js";
import { matchesAny } from "../schemas/plan.js";
import { joinArgv, mutatingName, noxSessionBodies, readOnlyCommand, analyzeCommand } from "./mutation.js";

/**
 * `factory adopt` step 1: what a repository is made of, read from its files only (no
 * commands; `measure` runs them). Everything here is a proposal a human reviews in the adopt PR.
 */

export type CheckKind = "typecheck" | "lint" | "format" | "test" | "e2e" | "build" | "other";

export interface Candidate {
  name: string;
  run: string;
  kind: CheckKind;
  /** Where it came from, e.g. `package.json script "lint"`, `nox session "tests"`. */
  source: string;
  /** What it effectively runs, for duplicate detection (defaults to `run`). */
  effective?: string;
}

/** A candidate adopt did not draft as a check (it changes files, or duplicates another). */
export interface SkippedCheck {
  name: string;
  run: string;
  source: string;
  reason: string;
}

export interface WorkflowJob {
  id: string;
  name: string;
  runs: string[];
  uses: string[];
  /** Containers under `services:` (e.g. postgres for tests). */
  services: string[];
  secrets: boolean;
}

export interface Workflow {
  file: string;
  triggers: string[];
  /** Runs for pull requests or branch pushes (not only tags, releases, schedules or by hand). */
  gates_prs: boolean;
  jobs: WorkflowJob[];
  /** Raw text (for legacy-bot and special-job detection). */
  text: string;
}

export interface SpecialJob {
  workflow: string;
  job: string;
  tool: string;
}

export interface Detection {
  stacks: string[];
  package_manager: "pnpm" | "npm" | "yarn" | "bun" | null;
  python: { runner: "uv" | "poetry" | "pip" | null; nox_sessions: string[]; nox_default: string[] } | null;
  setup: string;
  candidates: Candidate[];
  /** Not drafted: mutating commands, fix-type sessions, duplicates (listed in the adopt PR). */
  skipped: SkippedCheck[];
  tests: { globs: string[]; run: string | null };
  ui: { present: boolean; reasons: string[] };
  db: { present: boolean; reasons: string[] };
  cloud: { present: boolean; reasons: string[] };
  workflows: Workflow[];
  special_jobs: SpecialJob[];
  /** Secret names from an env template (never values) and whether a secrets-manager config is present. */
  secrets: { names: string[]; sources: string[]; infisical: boolean; infisicalProjectId?: string };
  /** Migration directories in the tree, as exclusive-path globs (`supabase/migrations/**`). */
  migration_globs: string[];
}

export const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template", ".env.dist"];

/** Variable names of the env templates (values are never read into the draft). */
export function envTemplateNames(dir: string): { names: string[]; sources: string[] } {
  const names = new Set<string>();
  const sources: string[] = [];
  for (const f of ENV_TEMPLATES) {
    const text = read(dir, f);
    if (text === undefined) continue;
    sources.push(f);
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) names.add(m[1]!);
    }
  }
  return { names: [...names], sources };
}

const read = (dir: string, f: string): string | undefined => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);

function readJson(dir: string, f: string): Record<string, unknown> | undefined {
  const t = read(dir, f);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const NODE_SCRIPTS: [RegExp, string, CheckKind][] = [
  [/^(typecheck|type-check|types|check-types|tsc|check:types)$/, "typecheck", "typecheck"],
  [/^lint$/, "lint", "lint"],
  [/^(format:check|fmt:check|prettier:check|check:format)$/, "format", "format"],
  [/^(test|test:unit|unit)$/, "test", "test"],
  [/^(test:e2e|e2e|test:integration|integration)$/, "e2e", "e2e"],
  [/^build$/, "build", "build"],
];

function nodeCandidates(dir: string, pm: NonNullable<Detection["package_manager"]>, skipped: SkippedCheck[]): Candidate[] {
  const scripts = ((readJson(dir, "package.json")?.scripts ?? {}) as Record<string, string>);
  const out: Candidate[] = [];
  const taken = new Set<string>();
  const exec = pm === "npm" ? "npx" : `${pm} exec`;
  for (const script of Object.keys(scripts)) {
    for (const [re, name, kind] of NODE_SCRIPTS) {
      if (!re.test(script) || taken.has(name)) continue;
      const source = `package.json script "${script}"`;
      const body = String(scripts[script] ?? "");
      const ro = readOnlyCommand(body);
      if (!ro) {
        skipped.push({ name, run: `${pm} run ${script}`, source, reason: "changes files and has no obvious check-only variant" });
        continue;
      }
      taken.add(name);
      // A rewritten script runs its tools directly; a chain of several commands is not rewritten (readOnlyCommand).
      if (ro.changed) out.push({ name, run: `${exec} ${ro.run}`, kind, source: `${source} (check-only variant: ${ro.why.join("; ")})`, effective: ro.run });
      else out.push({ name, run: `${pm} run ${script}`, kind, source, effective: body.trim() || undefined });
    }
  }
  return out;
}

/** `@nox.session` / `@session` functions (and `name=` overrides) plus `nox.options.sessions`. */
export function noxSessions(text: string): { sessions: string[]; defaults: string[] } {
  const sessions: string[] = [];
  for (const m of text.matchAll(/@(?:nox\.)?session\b(\([^)]*\))?\s*(?:@[^\n]*\n\s*)*def\s+(\w+)/g)) {
    const name = /name\s*=\s*["']([^"']+)["']/.exec(m[1] ?? "")?.[1] ?? m[2]!;
    if (!sessions.includes(name)) sessions.push(name);
  }
  const d = /nox\.options\.sessions\s*=\s*\[([^\]]*)\]/.exec(text)?.[1];
  const defaults = d ? [...d.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!) : [];
  return { sessions, defaults };
}

function kindOf(name: string): CheckKind {
  if (/type|mypy|pyright|tsc/.test(name)) return "typecheck";
  if (/e2e|integration|playwright|browser/.test(name)) return "e2e";
  if (/lint|ruff|flake|pylint/.test(name)) return "lint";
  if (/format|fmt|black/.test(name)) return "format";
  if (/test|pytest/.test(name)) return "test";
  if (/build|docs/.test(name)) return "build";
  return "other";
}

/** Formatter-like session names: dropped when their body cannot be read (they likely rewrite files). */
const FORMAT_NAME = /^(?:format|fmt|black|isort|prettier|style)$/i;

function noxCandidates(text: string, sessions: string[], runner: "uv" | "poetry" | "pip" | null, skipped: SkippedCheck[]): Candidate[] {
  const prefix = runner === "uv" ? "uv run --locked " : runner === "poetry" ? "poetry run " : runner === "pip" ? ".venv/bin/" : "";
  const noxCmd = runner === "uv" ? "uv run --locked nox" : runner === "poetry" ? "poetry run nox" : "nox";
  const bodies = new Map(noxSessionBodies(text).map((b) => [b.name, b]));
  const out: Candidate[] = [];
  for (const s of sessions) {
    const run = `${noxCmd} -s ${s}`;
    const source = `nox session "${s}"`;
    if (mutatingName(s)) {
      skipped.push({ name: s, run, source, reason: "fix/maintenance session (changes files)" });
      continue;
    }
    const body = bodies.get(s);
    const commands = body?.commands ?? null;
    if (!commands) {
      if (FORMAT_NAME.test(s)) skipped.push({ name: s, run, source, reason: "formatter session whose commands could not be read; add a --check variant by hand" });
      else out.push({ name: s, run, kind: kindOf(s), source });
      continue;
    }
    const verdicts = commands.map(analyzeCommand);
    if (!verdicts.some((v) => v.mutates)) {
      out.push({ name: s, run, kind: kindOf(s), source, effective: JSON.stringify(commands) });
      continue;
    }
    if (verdicts.some((v) => v.mutates && !v.check)) {
      skipped.push({ name: s, run, source, reason: `changes files (${verdicts.flatMap((v) => (v.mutates ? [v.why] : [])).join("; ")}) and has no obvious check-only variant` });
      continue;
    }
    // Run the read-only variant directly; inside a nox-managed venv the tools come from the project runner.
    const parts = commands.map((c, i) => {
      const v = verdicts[i]!;
      const argv = v.mutates && v.check ? v.check : c;
      return body!.external || /^(?:uv|poetry|pdm|hatch|npx|pnpm|yarn|npm)$/.test(argv[0]!) ? joinArgv(argv) : `${prefix}${joinArgv(argv)}`;
    });
    out.push({
      name: s,
      run: parts.join(" && "),
      kind: kindOf(s),
      source: `${source} (check-only variant: ${verdicts.flatMap((v) => (v.mutates ? [v.why] : [])).join("; ")})`,
      effective: parts.join(" && "),
    });
  }
  return out;
}

/** Same command under several names (nox `test` and `test_unit`): keep one, the more specific (longer) name. */
export function dedupeCandidates(candidates: Candidate[], skipped: SkippedCheck[]): Candidate[] {
  const norm = (c: Candidate) => (c.effective ?? c.run).replace(/\s+/g, " ").trim();
  const keep = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = norm(c);
    const prev = keep.get(key);
    if (!prev) keep.set(key, c);
    else {
      const [winner, loser] = c.name.length > prev.name.length ? [c, prev] : [prev, c];
      keep.set(key, winner);
      skipped.push({ name: loser.name, run: loser.run, source: loser.source, reason: `same command as "${winner.name}"` });
    }
  }
  const kept = new Set(keep.values());
  return candidates.filter((c) => kept.has(c));
}

function pythonCandidates(dir: string, runner: "uv" | "poetry" | "pip" | null, nox: { sessions: string[] } | null, noxText: string | undefined, skipped: SkippedCheck[]): Candidate[] {
  const prefix = runner === "uv" ? "uv run --locked " : runner === "poetry" ? "poetry run " : runner === "pip" ? ".venv/bin/" : "";
  if (nox?.sessions.length) return noxCandidates(noxText ?? "", nox.sessions, runner, skipped);
  const py = [read(dir, "pyproject.toml") ?? "", read(dir, "requirements-dev.txt") ?? "", read(dir, "requirements.txt") ?? "", read(dir, "setup.cfg") ?? ""].join("\n");
  const has = (re: RegExp) => re.test(py);
  const out: Candidate[] = [];
  if (has(/\[tool\.ruff|\bruff\b/)) {
    out.push({ name: "lint", run: `${prefix}ruff check .`, kind: "lint", source: "ruff configured" });
    out.push({ name: "format", run: `${prefix}ruff format --check .`, kind: "format", source: "ruff configured" });
  }
  if (has(/\[tool\.mypy|\bmypy\b/)) out.push({ name: "typecheck", run: `${prefix}mypy .`, kind: "typecheck", source: "mypy configured" });
  else if (has(/\[tool\.pyright|\bpyright\b/)) out.push({ name: "typecheck", run: `${prefix}pyright`, kind: "typecheck", source: "pyright configured" });
  if (has(/\[tool\.pytest|\bpytest\b/) || existsSync(join(dir, "tests"))) out.push({ name: "test", run: `${prefix}pytest`, kind: "test", source: "pytest configured" });
  return out;
}

function otherCandidates(dir: string): Candidate[] {
  const out: Candidate[] = [];
  if (existsSync(join(dir, "Cargo.toml"))) {
    out.push(
      { name: "format", run: "cargo fmt --check", kind: "format", source: "Cargo.toml" },
      { name: "lint", run: "cargo clippy --all-targets -- -D warnings", kind: "lint", source: "Cargo.toml" },
      { name: "test", run: "cargo test", kind: "test", source: "Cargo.toml" },
    );
  }
  if (existsSync(join(dir, "go.mod"))) {
    out.push({ name: "lint", run: "go vet ./...", kind: "lint", source: "go.mod" }, { name: "test", run: "go test ./...", kind: "test", source: "go.mod" });
  }
  return out;
}

const DB = /\b(postgres|postgresql|psycopg2?|asyncpg|sqlalchemy|django|prisma|typeorm|knex|sequelize|mysql2?|mariadb|mongodb|mongoose|redis|supabase)\b|"(pg)"/i;
const UI = /"(react|vue|svelte|@sveltejs\/kit|next|nuxt|astro|solid-js|@angular\/core|vite|@playwright\/test)"|\b(pytest-playwright|playwright|streamlit|gradio|jinja2|django)\b/i;
const CLOUD = /\b(aws|boto3|gcloud|google-cloud|azure|terraform|pulumi|vercel|netlify|fly\.io|cloudflare|wrangler|infisical)\b/i;

/** Tools of jobs `adopt` does not turn into a check by itself (the baseline plan carries them over). */
const SPECIAL = /\b(gitleaks|pip-audit|npm audit|pnpm audit|yarn audit|cosign|systemd-analyze|trivy|codeql|semgrep|bandit|safety check|osv-scanner|zizmor|actionlint|hadolint|shellcheck|dependency-review|license-check)\b/i;

function asList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

export function readWorkflows(dir: string): Workflow[] {
  const wfDir = join(dir, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  const out: Workflow[] = [];
  for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = `.github/workflows/${name}`;
    if (file === CI_STUB_PATH) continue;
    const text = readFileSync(join(wfDir, name), "utf8");
    let doc: Record<string, unknown> = {};
    try {
      doc = (parse(text) ?? {}) as Record<string, unknown>;
    } catch {
      // unparsable: listed with no jobs, never removed automatically
    }
    const jobs = Object.entries((doc.jobs ?? {}) as Record<string, Record<string, unknown>>).map(([id, j]) => {
      const steps = (Array.isArray(j?.steps) ? j.steps : []) as Record<string, unknown>[];
      return {
        id,
        name: typeof j?.name === "string" ? j.name : id,
        runs: steps.map((s) => s.run).filter((r): r is string => typeof r === "string"),
        uses: [...steps.map((s) => s.uses), j?.uses].filter((u): u is string => typeof u === "string"),
        services: asList(j?.services),
        secrets: /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(JSON.stringify(j ?? {})),
      };
    });
    const on = doc.on ?? doc.true;
    const triggers = asList(on);
    const push = on && typeof on === "object" && !Array.isArray(on) ? (on as Record<string, unknown>).push : undefined;
    const tagsOnly = !!push && typeof push === "object" && "tags" in push && !("branches" in push) && !("branches-ignore" in push);
    const gates = triggers.some((t) => ["pull_request", "pull_request_target", "merge_group"].includes(t)) || (triggers.includes("push") && !tagsOnly);
    out.push({ file, triggers, gates_prs: gates, jobs, text });
  }
  return out;
}

export function specialJobs(workflows: Workflow[]): SpecialJob[] {
  const out: SpecialJob[] = [];
  for (const wf of workflows) {
    for (const j of wf.jobs) {
      const m = SPECIAL.exec([...j.runs, ...j.uses].join("\n"));
      if (m) out.push({ workflow: wf.file, job: j.id, tool: m[1]!.toLowerCase() });
    }
  }
  return out;
}

const TEST_GLOBS = ["tests/**", "test/**", "__tests__/**", "**/test_*.py", "**/*_test.py", "**/*.test.*", "**/*.spec.*", "**/*_test.go"];

/** Reads the repo at `dir` (a clean base worktree); `files` = `git ls-files`. */
export function detect(dir: string, files: string[]): Detection {
  const stacks: string[] = [];
  const pkg = readJson(dir, "package.json");
  let pm: Detection["package_manager"] = null;
  let setupParts: string[] = [];
  const candidates: Candidate[] = [];
  const skipped: SkippedCheck[] = [];
  if (pkg) {
    stacks.push("node");
    pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm";
    setupParts.push({ pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile", npm: existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install" }[pm]);
    candidates.push(...nodeCandidates(dir, pm, skipped));
  }
  let python: Detection["python"] = null;
  const isPython = ["pyproject.toml", "setup.py", "requirements.txt", "noxfile.py"].some((f) => existsSync(join(dir, f)));
  if (isPython) {
    stacks.push("python");
    const runner = existsSync(join(dir, "uv.lock")) ? "uv" : existsSync(join(dir, "poetry.lock")) ? "poetry" : existsSync(join(dir, "requirements.txt")) ? "pip" : null;
    const noxText = read(dir, "noxfile.py");
    const nox = noxText ? noxSessions(noxText) : null;
    python = { runner, nox_sessions: nox?.sessions ?? [], nox_default: nox?.defaults ?? [] };
    if (runner === "uv") setupParts.push("uv sync --locked");
    else if (runner === "poetry") setupParts.push("poetry install");
    else if (runner === "pip") setupParts.push("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt");
    for (const c of pythonCandidates(dir, runner, nox, noxText, skipped)) if (!candidates.some((x) => x.name === c.name)) candidates.push(c);
  }
  for (const [f, s] of [["Cargo.toml", "rust"], ["go.mod", "go"]] as const) if (existsSync(join(dir, f))) stacks.push(s);
  for (const c of otherCandidates(dir)) if (!candidates.some((x) => x.name === c.name)) candidates.push(c);
  setupParts = setupParts.filter(Boolean);
  const checks = dedupeCandidates(candidates, skipped);

  const workflows = readWorkflows(dir);
  const manifests = [read(dir, "package.json"), read(dir, "pyproject.toml"), read(dir, "requirements.txt"), read(dir, "docker-compose.yml"), read(dir, "compose.yaml")].join("\n");
  const dbReasons = [
    ((m) => (m ? `dependency/compose: ${m[1] ?? m[2]}` : ""))(DB.exec(manifests)),
    ...workflows.flatMap((w) => w.jobs.filter((j) => j.services.length).map((j) => `CI services in ${w.file} (${j.id}): ${j.services.join(", ")}`)),
    files.some((f) => f.startsWith("supabase/")) ? "supabase/ directory" : "",
    files.some((f) => /(^|\/)migrations\//.test(f)) ? "migrations/ directory" : "",
  ].filter(Boolean);
  const uiReasons = [UI.exec(manifests)?.[0] ? `dependency: ${UI.exec(manifests)![0]!.replaceAll('"', "")}` : "", files.some((f) => /(^|\/)templates\/.+\.html$/.test(f)) ? "HTML templates" : ""].filter(Boolean);
  const cloudReasons = [
    CLOUD.exec(manifests)?.[1] ? `dependency: ${CLOUD.exec(manifests)![1]}` : "",
    ...workflows.filter((w) => w.jobs.some((j) => j.secrets)).map((w) => `${w.file} uses secrets`),
  ].filter(Boolean);

  const testFiles = files.filter((f) => matchesAny(f, TEST_GLOBS));
  const globs = TEST_GLOBS.filter((g) => testFiles.some((f) => matchesAny(f, [g])));
  let testRun: string | null = null;
  const testScript = String((pkg?.scripts as Record<string, string> | undefined)?.test ?? "");
  if (pm) testRun = singleFileTestCommand(testScript, pm);
  if (!testRun && python && candidates.some((c) => c.kind === "test")) {
    const prefix = python.runner === "uv" ? "uv run --locked " : python.runner === "poetry" ? "poetry run " : python.runner === "pip" ? ".venv/bin/" : "";
    testRun = `${prefix}pytest {files}`;
  }

  return {
    stacks,
    package_manager: pm,
    python,
    setup: setupParts.join(" && "),
    candidates: checks,
    skipped,
    tests: { globs, run: testRun },
    ui: { present: uiReasons.length > 0, reasons: uiReasons },
    db: { present: dbReasons.length > 0, reasons: dbReasons },
    cloud: { present: cloudReasons.length > 0, reasons: cloudReasons },
    workflows,
    special_jobs: specialJobs(workflows),
    secrets: { ...envTemplateNames(dir), ...infisicalConfig(dir) },
    migration_globs: migrationDirGlobs(files),
  };
}

const LOADER_VALUE = new Set(["--import", "--loader", "--require", "-r", "--experimental-loader", "--tsconfig"]);

/** Shell words. `KEY='a b'` stays one word so a loader in `NODE_OPTIONS` is not split. */
function shellWords(segment: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = segment.trim();
  while (i < s.length) {
    while (s[i] === " ") i++;
    if (i >= s.length) break;
    const env = /^([A-Za-z_][A-Za-z0-9_]*)=(['"])/.exec(s.slice(i));
    if (env) {
      const start = i + env[0].length;
      const end = s.indexOf(env[2]!, start);
      out.push(`${env[1]}=${end < 0 ? s.slice(start) : s.slice(start, end)}`);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i]!;
      const end = s.indexOf(q, i + 1);
      out.push(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const word = /^\S+/.exec(s.slice(i));
    if (!word) break;
    out.push(word[0]);
    i += word[0].length;
  }
  return out;
}

function shellQuote(value: string): string {
  return /[\s'"]/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value;
}

/** Node loader options (`--import`, `--loader`, `--require`, `--experimental-*`) and their values. */
function loaderFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (LOADER_VALUE.has(a)) {
      const v = args[i + 1];
      if (v && !v.startsWith("-")) {
        out.push(a, shellQuote(v));
        i++;
      }
      continue;
    }
    if (/^--(?:import|loader|require)=/.test(a)) {
      out.push(quotedEquals(a));
      continue;
    }
    if (a.startsWith("--experimental-")) out.push(a);
  }
  return out;
}

const WATCH = new Set(["run", "--watch", "--watchAll", "-w"]);

function isWatch(token: string): boolean {
  return WATCH.has(token) || token.startsWith("--watch=") || token.startsWith("--watchAll=");
}

/** Flags that do not take the next word. A following path is a file selection, not a value. */
const BOOLEAN_FLAG = new Set([
  "--coverage",
  "--bail",
  "--silent",
  "--ci",
  "--runInBand",
  "--forceExit",
  "--detectOpenHandles",
  "--passWithNoTests",
  "--onlyChanged",
  "--changed",
  "--updateSnapshot",
  "-u",
  "--colors",
  "--no-colors",
  "--no-coverage",
  "--no-file-parallelism",
  "--dangerouslyIgnoreUnhandledErrors",
  "--standalone",
  "--experimental-vm-modules",
]);

function quotedEquals(token: string): string {
  const eq = token.indexOf("=");
  return `${token.slice(0, eq + 1)}${shellQuote(token.slice(eq + 1))}`;
}

/** Keeps flags and their values. Drops watch mode and positional files so `{files}` is the selection. */
function toolFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (isWatch(a) || !a.startsWith("-")) continue;
    if (a.includes("=")) {
      out.push(quotedEquals(a));
      continue;
    }
    const v = args[i + 1];
    if (v && !v.startsWith("-") && !BOOLEAN_FLAG.has(a) && !a.startsWith("--experimental-")) {
      out.push(a, shellQuote(v));
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Flags for `node --test`. Loader flags stay even when they follow `--test`
 * (`node --test --import tsx`). Other flags stay only when they precede `--test`.
 * Watch mode and file arguments are dropped.
 */
function nodeTestFlags(args: string[], runnerAt: number, testAt: number): string[] {
  const out: string[] = [];
  for (let i = runnerAt + 1; i < args.length; i++) {
    if (i === testAt) continue;
    const a = args[i]!;
    const loaderEquals = /^--(?:import|loader|require)=/.test(a);
    const loader = LOADER_VALUE.has(a) || a.startsWith("--experimental-") || loaderEquals;
    if (loader) {
      if (loaderEquals) out.push(quotedEquals(a));
      else if (LOADER_VALUE.has(a)) {
        const v = args[i + 1];
        if (v && !v.startsWith("-")) {
          out.push(a, shellQuote(v));
          i++;
        } else out.push(a);
      } else out.push(a);
      continue;
    }
    if (i < testAt && a.startsWith("-") && !isWatch(a)) {
      const v = args[i + 1];
      if (v && !v.startsWith("-") && !BOOLEAN_FLAG.has(a) && i + 1 !== testAt) {
        out.push(a, shellQuote(v));
        i++;
      } else out.push(a);
    }
  }
  return out;
}

function binName(token: string, name: string): boolean {
  return new RegExp(`(?:^|/)${name}(?:\\.m?js)?$`).test(token);
}

/**
 * Command that runs the cited test files. Taken from the repo's `test` script.
 * Node loader flags stay (`--import tsx`, `--loader`, `--experimental-strip-types`, a loader in `NODE_OPTIONS`).
 * File arguments and watch mode (`--watch`, `--watchAll`, `-w`) do not: `{files}` is the selection.
 */
export function singleFileTestCommand(script: string, pm: NonNullable<Detection["package_manager"]>): string | null {
  const exec = pm === "npm" ? "npx" : `${pm} exec`;
  for (const segment of script.split(/\s*(?:&&|\|\||;)\s*/)) {
    const words = shellWords(segment);
    const env = words.filter((w) => w.startsWith("NODE_OPTIONS=") && /import|loader|require|experimental/.test(w));
    const args = words.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const prefix = env.map((w) => `NODE_OPTIONS=${shellQuote(w.slice("NODE_OPTIONS=".length))}`).join(" ");
    const lead = prefix ? `${prefix} ` : "";
    const vitest = args.findIndex((a) => binName(a, "vitest"));
    const jest = args.findIndex((a) => binName(a, "jest"));
    const tool = vitest >= 0 ? vitest : jest;
    if (tool >= 0) {
      const before = args.slice(0, tool);
      const nodeAt = before.findIndex((a) => binName(a, "node"));
      const keptLoaders = nodeAt >= 0 ? loaderFlags(before.slice(nodeAt + 1)) : [];
      const flags = toolFlags(args.slice(tool + 1));
      const tail = `${vitest >= 0 ? "run " : ""}${flags.length ? `${flags.join(" ")} ` : ""}{files}`;
      if (nodeAt >= 0 && keptLoaders.length) return `${lead}node ${keptLoaders.join(" ")} ${shellQuote(args[tool]!)} ${tail}`;
      const bin = vitest >= 0 ? "vitest" : "jest";
      return `${lead}${exec} ${bin} ${tail}`;
    }
    const runnerAt = args.findIndex((a) => binName(a, "node") || binName(a, "tsx") || binName(a, "ts-node"));
    const testAt = args.indexOf("--test");
    if (runnerAt >= 0 && testAt > runnerAt) {
      const flags = nodeTestFlags(args, runnerAt, testAt);
      const flagText = flags.length ? `${flags.join(" ")} ` : "";
      return `${lead}${args[runnerAt]} ${flagText}--test {files}`;
    }
  }
  return null;
}

/** `.infisical.json` presence and its `workspaceId` (the project id), only when it is a plain id (it ends up in a shell command). */
function infisicalConfig(dir: string): { infisical: boolean; infisicalProjectId?: string } {
  const file = join(dir, ".infisical.json");
  if (!existsSync(file)) return { infisical: false };
  try {
    const id = (JSON.parse(readFileSync(file, "utf8")) as { workspaceId?: unknown }).workspaceId;
    return typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id) ? { infisical: true, infisicalProjectId: id } : { infisical: true };
  } catch {
    return { infisical: true };
  }
}
