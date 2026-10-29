import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CI_STUB_PATH } from "../ci.js";
import { matchesAny } from "../schemas/plan.js";

/**
 * `factory adopt` step 1 (SPEC §12): what a repository is made of, read from its files only (no
 * commands; `measure` runs them). Everything here is a proposal a human reviews in the adopt PR.
 */

export type CheckKind = "typecheck" | "lint" | "format" | "test" | "e2e" | "build" | "other";

export interface Candidate {
  name: string;
  run: string;
  kind: CheckKind;
  /** Where it came from, e.g. `package.json script "lint"`, `nox session "tests"`. */
  source: string;
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
  tests: { globs: string[]; run: string | null };
  ui: { present: boolean; reasons: string[] };
  db: { present: boolean; reasons: string[] };
  cloud: { present: boolean; reasons: string[] };
  workflows: Workflow[];
  special_jobs: SpecialJob[];
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

function nodeCandidates(dir: string, pm: NonNullable<Detection["package_manager"]>): Candidate[] {
  const scripts = ((readJson(dir, "package.json")?.scripts ?? {}) as Record<string, string>);
  const out: Candidate[] = [];
  const taken = new Set<string>();
  for (const script of Object.keys(scripts)) {
    for (const [re, name, kind] of NODE_SCRIPTS) {
      if (!re.test(script) || taken.has(name)) continue;
      taken.add(name);
      out.push({ name, run: `${pm} run ${script}`, kind, source: `package.json script "${script}"` });
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

function pythonCandidates(dir: string, runner: "uv" | "poetry" | "pip" | null, nox: { sessions: string[] } | null): Candidate[] {
  const prefix = runner === "uv" ? "uv run --locked " : runner === "poetry" ? "poetry run " : runner === "pip" ? ".venv/bin/" : "";
  if (nox?.sessions.length) {
    const noxCmd = runner === "uv" ? "uv run --locked nox" : runner === "poetry" ? "poetry run nox" : "nox";
    return nox.sessions.map((s) => ({ name: s, run: `${noxCmd} -s ${s}`, kind: kindOf(s), source: `nox session "${s}"` }));
  }
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
  if (pkg) {
    stacks.push("node");
    pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm";
    setupParts.push({ pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile", bun: "bun install --frozen-lockfile", npm: existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install" }[pm]);
    candidates.push(...nodeCandidates(dir, pm));
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
    for (const c of pythonCandidates(dir, runner, nox)) if (!candidates.some((x) => x.name === c.name)) candidates.push(c);
  }
  for (const [f, s] of [["Cargo.toml", "rust"], ["go.mod", "go"]] as const) if (existsSync(join(dir, f))) stacks.push(s);
  for (const c of otherCandidates(dir)) if (!candidates.some((x) => x.name === c.name)) candidates.push(c);
  setupParts = setupParts.filter(Boolean);

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
  if (pm) {
    const exec = pm === "npm" ? "npx" : `${pm} exec`;
    if (/\bvitest\b/.test(testScript)) testRun = `${exec} vitest run {files}`;
    else if (/\bjest\b/.test(testScript)) testRun = `${exec} jest {files}`;
    else if (/node --test/.test(testScript)) testRun = "node --test {files}";
  }
  if (!testRun && python && candidates.some((c) => c.kind === "test")) {
    const prefix = python.runner === "uv" ? "uv run --locked " : python.runner === "poetry" ? "poetry run " : python.runner === "pip" ? ".venv/bin/" : "";
    testRun = `${prefix}pytest {files}`;
  }

  return {
    stacks,
    package_manager: pm,
    python,
    setup: setupParts.join(" && "),
    candidates,
    tests: { globs, run: testRun },
    ui: { present: uiReasons.length > 0, reasons: uiReasons },
    db: { present: dbReasons.length > 0, reasons: dbReasons },
    cloud: { present: cloudReasons.length > 0, reasons: cloudReasons },
    workflows,
    special_jobs: specialJobs(workflows),
  };
}
