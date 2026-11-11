import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileTimed } from "../exec.js";
import type { CiRun } from "../gh.js";
import { baseRef, revParse, withBaseWorktree } from "../git.js";
import type { MemoryFile } from "../memory.js";
import { matchesAny } from "../schemas/plan.js";
import type { RepoConfig } from "../schemas/repo.js";
import { NEVER_FAILED_MIN_RUNS } from "../harden/signals.js";

/** A test at least this slow is a duration signal. Shorter timings stay out of the prompt. */
export const SLOW_TEST_SECONDS = 2;
/** Local duration and coverage commands never run longer than this, even when the check timeout is higher. */
export const LOCAL_SIGNAL_TIMEOUT_MS = 5 * 60_000;
const SLOWEST_CAP = 15;
const UNCOVERED_CAP = 40;
const TEST_JOB = /(^|[^a-z])(tests?|pytest|vitest|jest|specs?|e2e|unit)([^a-z]|$)/i;

export interface SlowTest {
  name: string;
  seconds: number;
}

export interface UncoveredPath {
  path: string;
  sensitive: boolean;
  missed: number;
}

export interface TestSignal {
  slowest: SlowTest[];
  duration_error: string | null;
  flaky: { key: string; text: string; count: number }[];
  never_failed: { workflow: string; name: string; runs: number }[];
  /** Null when `tests.coverage` is unset. */
  coverage: { uncovered: UncoveredPath[]; error: string | null } | null;
}

/** Vitest's default script is watch mode. `--run` (or the `vitest run` subcommand) forces a single run. */
export function forceVitestRun(command: string): string {
  if (/\bvitest\s+run\b/.test(command) || /(^|\s)--run(\s|=|$)/.test(command)) return command;
  return command.replace(/\bvitest\b/, "vitest --run");
}

export function durationCommand(command: string): { command: string; kind: "pytest" | "vitest" | "jest" } | null {
  const base = command.replace(/\{files\}/g, "").replace(/\s+/g, " ").trim();
  if (!base) return null;
  if (/\bpytest\b/.test(base)) return { kind: "pytest", command: /--durations(=|\s)/.test(base) ? base : `${base} --durations=25` };
  if (/\bvitest\b/.test(base)) {
    const withRun = forceVitestRun(base);
    return { kind: "vitest", command: /--reporter(=|\s)/.test(withRun) ? withRun : `${withRun} --reporter=json` };
  }
  if (/\bjest\b/.test(base)) return { kind: "jest", command: /\s--json\b/.test(base) ? base : `${base} --json` };
  return null;
}

/** `min(5 min, limits.command_timeout_minutes)`. Each local command gets its own cap. */
export function localSignalTimeoutMs(commandTimeoutMinutes: number): number {
  return Math.min(LOCAL_SIGNAL_TIMEOUT_MS, commandTimeoutMinutes * 60_000);
}

/** The repo's runner, when the command names pytest, vitest or jest. Otherwise null (no duration signal). */
export function runnerInvocation(repoDir: string, repo: RepoConfig): { command: string; kind: "pytest" | "vitest" | "jest" } | null {
  const direct = [repo.tests.run, ...repo.checks.map((c) => c.run)].map((c) => (c ? durationCommand(c) : null)).find((c) => c);
  if (direct) return direct;
  let script: string;
  try {
    script = ((JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { scripts?: { test?: string } }).scripts?.test ?? "");
  } catch {
    return null;
  }
  const parsed = durationCommand(script);
  if (!parsed || parsed.kind === "pytest") return parsed;
  const pm = existsSync(join(repoDir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(repoDir, "yarn.lock")) ? "yarn" : "npm";
  const flags =
    parsed.kind === "vitest"
      ? [forceVitestRun(script) === script ? "" : "--run", /--reporter(=|\s)/.test(script) ? "" : "--reporter=json"].filter(Boolean)
      : [/\s--json\b/.test(script) ? "" : "--json"].filter(Boolean);
  return { kind: parsed.kind, command: flags.length ? `${pm} test -- ${flags.join(" ")}` : `${pm} test` };
}

export function parsePytestDurations(text: string): SlowTest[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /slowest .+durations/i.test(l));
  const body = start >= 0 ? lines.slice(start + 1) : [];
  const totals = new Map<string, number>();
  for (const line of body) {
    if (/^=+$/.test(line.trim())) break;
    const m = /^(\d+(?:\.\d+)?)(ms|s)\s+\S+\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const seconds = m[2] === "ms" ? Number(m[1]) / 1000 : Number(m[1]);
    totals.set(m[3]!, (totals.get(m[3]!) ?? 0) + seconds);
  }
  return ranked(totals);
}

export function parseReporterDurations(text: string): SlowTest[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const results = json && typeof json === "object" ? (json as { testResults?: unknown }).testResults : undefined;
  if (!Array.isArray(results)) return [];
  const totals = new Map<string, number>();
  for (const file of results) {
    if (!file || typeof file !== "object") continue;
    const assertions = (file as { assertionResults?: unknown }).assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const test of assertions) {
      if (!test || typeof test !== "object") continue;
      const row = test as { fullName?: unknown; title?: unknown; name?: unknown; duration?: unknown };
      const name = typeof row.fullName === "string" ? row.fullName : typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : "";
      if (!name || typeof row.duration !== "number" || !Number.isFinite(row.duration)) continue;
      totals.set(name, Math.max(totals.get(name) ?? 0, row.duration / 1000));
    }
  }
  return ranked(totals);
}

function ranked(totals: Map<string, number>): SlowTest[] {
  return [...totals.entries()]
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds * 1000) / 1000 }))
    .filter((t) => t.seconds >= SLOW_TEST_SECONDS)
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
    .slice(0, SLOWEST_CAP);
}

export function parseCoverageReport(text: string, filename: string): { path: string; missed: number }[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xml") || text.includes("<coverage") || text.includes("<class ")) return parseCobertura(text);
  if (lower.endsWith(".info") || text.includes("\nSF:") || text.startsWith("SF:")) return parseLcov(text);
  try {
    return parseCoverageJson(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

function parseLcov(text: string): { path: string; missed: number }[] {
  const out: { path: string; missed: number }[] = [];
  for (const record of text.split("end_of_record")) {
    const path = /^SF:(.+)$/m.exec(record)?.[1]?.trim();
    if (!path) continue;
    const missed = [...record.matchAll(/^DA:\d+,(\d+)/gm)].filter((m) => m[1] === "0").length;
    if (missed) out.push({ path, missed });
  }
  return out;
}

function parseCobertura(text: string): { path: string; missed: number }[] {
  const out: { path: string; missed: number }[] = [];
  for (const chunk of text.split(/<class\b/i).slice(1)) {
    const path = /filename="([^"]+)"/i.exec(chunk)?.[1];
    if (!path) continue;
    const missed = [...chunk.matchAll(/hits="0"/g)].length;
    if (missed) out.push({ path, missed });
  }
  return out;
}

function missedOf(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const summary = row.summary;
  if (summary && typeof summary === "object") {
    const missing = (summary as { missing_lines?: unknown }).missing_lines;
    if (typeof missing === "number") return missing;
    if (Array.isArray(missing)) return missing.length;
  }
  const lines = row.lines;
  if (lines && typeof lines === "object") {
    const total = (lines as { total?: unknown }).total;
    const covered = (lines as { covered?: unknown }).covered;
    if (typeof total === "number" && typeof covered === "number") return Math.max(0, total - covered);
  }
  const statements = row.s;
  if (statements && typeof statements === "object") return Object.values(statements).filter((n) => n === 0).length;
  return null;
}

function parseCoverageJson(json: unknown): { path: string; missed: number }[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const files = root.files && typeof root.files === "object" ? (root.files as Record<string, unknown>) : root;
  const out: { path: string; missed: number }[] = [];
  for (const [key, value] of Object.entries(files)) {
    if (key === "total" || key === "meta") continue;
    const missed = missedOf(value);
    if (!missed) continue;
    const path = value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string" ? (value as { path: string }).path : key;
    out.push({ path, missed });
  }
  return out;
}

function relPath(repoDir: string, path: string): string {
  const norm = path.replaceAll("\\", "/");
  const root = repoDir.replaceAll("\\", "/").replace(/\/$/, "");
  const cut = norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm.replace(/^\.\//, "");
  return cut;
}

export function uncoveredCritical(repoDir: string, reports: { path: string; missed: number }[], sensitive: string[]): UncoveredPath[] {
  const byPath = new Map<string, number>();
  for (const row of reports) {
    const path = relPath(repoDir, row.path);
    byPath.set(path, Math.max(byPath.get(path) ?? 0, row.missed));
  }
  return [...byPath.entries()]
    .map(([path, missed]) => ({ path, missed, sensitive: matchesAny(path, sensitive) }))
    .sort((a, b) => Number(b.sensitive) - Number(a.sensitive) || b.missed - a.missed || a.path.localeCompare(b.path))
    .slice(0, UNCOVERED_CAP);
}

const COVERAGE_FILES = ["coverage/coverage-summary.json", "coverage/coverage-final.json", "coverage.json", "coverage/lcov.info", "lcov.info", "coverage.xml"];

function clip(e: unknown): string {
  return ((e as Error).message || String(e)).split("\n")[0]!.slice(0, 200);
}

export interface TestSignalInput {
  repoDir: string;
  repo: RepoConfig;
  mem: MemoryFile;
  runs: CiRun[];
  dryRun?: boolean;
  exec?: (command: string, cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
  /** Where local commands run. Default: a temporary base worktree, removed afterwards. Never the checkout. */
  isolate?: (repoDir: string, repo: RepoConfig, fn: (cwd: string) => Promise<void>) => Promise<void>;
}

function signalEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CI: "1" };
}

async function defaultExec(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileTimed("sh", ["-c", command], { cwd, timeoutMs, maxBuffer: 8 * 1024 * 1024, env: signalEnv() });
}

/** Detached worktree of the base commit, same idea as the plan-base worktree. Removed afterwards. */
async function withSignalWorktree(repoDir: string, repo: RepoConfig, fn: (cwd: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "factory-improve-"));
  try {
    const sha = await revParse(repoDir, await baseRef(repoDir, repo.base_branch));
    await withBaseWorktree(repoDir, sha, join(tmp, "wt"), fn);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function outputOf(e: unknown): { stdout: string; stderr: string } | null {
  if (!e || typeof e !== "object") return null;
  const rec = e as { stdout?: unknown; stderr?: unknown };
  const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
  const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
  if (!stdout && !stderr) return null;
  return { stdout, stderr };
}

function flakyOf(mem: MemoryFile): TestSignal["flaky"] {
  return mem.entries
    .filter((e) => e.status === "open" && e.key.startsWith("flaky:"))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((e) => ({ key: e.key, text: e.text, count: e.count }));
}

function neverFailedTests(runs: CiRun[]): TestSignal["never_failed"] {
  const byJob = new Map<string, { workflow: string; name: string; runs: number; failures: number }>();
  for (const run of runs) {
    for (const job of run.jobs) {
      if (!job.conclusion || job.conclusion === "skipped" || !TEST_JOB.test(job.name)) continue;
      const key = `${run.workflow}\u0000${job.name}`;
      const acc = byJob.get(key) ?? { workflow: run.workflow, name: job.name, runs: 0, failures: 0 };
      acc.runs += 1;
      if (job.conclusion === "failure" || job.conclusion === "timed_out") acc.failures += 1;
      byJob.set(key, acc);
    }
  }
  return [...byJob.values()]
    .filter((j) => j.runs >= NEVER_FAILED_MIN_RUNS && j.failures === 0)
    .map(({ workflow, name, runs: n }) => ({ workflow, name, runs: n }))
    .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.name.localeCompare(b.name));
}

function readReports(repoDir: string, sinceMs: number): { path: string; missed: number }[] {
  const out: { path: string; missed: number }[] = [];
  for (const rel of COVERAGE_FILES) {
    const path = join(repoDir, rel);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).mtimeMs + 1000 < sinceMs) continue;
      out.push(...parseCoverageReport(readFileSync(path, "utf8"), rel));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Slow tests (when the repo's runner can report them), flaky checks from memory, test jobs that
 * never failed, and uncovered critical paths when `tests.coverage` is set.
 */
export async function collectTestSignals(input: TestSignalInput): Promise<TestSignal> {
  const flaky = flakyOf(input.mem);
  const never_failed = neverFailedTests(input.runs);
  let slowest: SlowTest[] = [];
  let duration_error: string | null = null;
  let coverage: TestSignal["coverage"] = null;
  const invocation = runnerInvocation(input.repoDir, input.repo);
  const command = input.repo.tests.coverage;
  if (input.dryRun) {
    if (command) coverage = { uncovered: [], error: "dry-run: command not run" };
    return { slowest, duration_error, flaky, never_failed, coverage };
  }
  if (!invocation && !command) return { slowest, duration_error, flaky, never_failed, coverage };

  const exec = input.exec ?? defaultExec;
  const timeoutMs = localSignalTimeoutMs(input.repo.limits.command_timeout_minutes);
  const isolate = input.isolate ?? withSignalWorktree;
  await isolate(input.repoDir, input.repo, async (cwd) => {
    if (invocation) {
      try {
        const out = await exec(invocation.command, cwd, timeoutMs);
        const text = `${out.stdout}\n${out.stderr}`;
        slowest = invocation.kind === "pytest" ? parsePytestDurations(text) : parseReporterDurations(text);
      } catch (e) {
        const partial = outputOf(e);
        const text = partial ? `${partial.stdout}\n${partial.stderr}` : "";
        if (text.trim()) slowest = invocation.kind === "pytest" ? parsePytestDurations(text) : parseReporterDurations(text);
        else duration_error = clip(e);
      }
    }
    if (command) {
      const started = Date.now();
      let error: string | null = null;
      let stdout = "";
      let failedClip: string | null = null;
      try {
        const out = await exec(command, cwd, timeoutMs);
        stdout = out.stdout;
      } catch (e) {
        failedClip = clip(e);
        const partial = outputOf(e);
        if (partial) stdout = partial.stdout;
        else error = failedClip;
      }
      const reports = [...readReports(cwd, started), ...parseCoverageReport(stdout, "stdout")];
      if (failedClip && reports.length === 0 && error === null) error = failedClip;
      coverage = { uncovered: uncoveredCritical(input.repoDir, reports, input.repo.sensitive_paths), error };
    }
  });
  return { slowest, duration_error, flaky, never_failed, coverage };
}

export function testWorth(signal: TestSignal, refresh: number): boolean {
  return refresh > 0 || signal.slowest.length > 0 || signal.flaky.length > 0 || signal.never_failed.length > 0 || (signal.coverage?.uncovered.length ?? 0) > 0;
}
