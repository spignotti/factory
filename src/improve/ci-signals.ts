import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRunView, type RunListRow } from "../ci-history.js";
import { CI_STUB_PATH } from "../ci.js";
import type { CiRun } from "../gh.js";
import { NEVER_FAILED_MIN_RUNS, SLOW_CHECK_SECONDS, WINDOW_DAYS } from "../harden/signals.js";

/** Minutes/week above which CI cost alone is a signal (the model is called). */
export const HIGH_CI_MINUTES_PER_WEEK = 60;
/** `select` over this, with every `check` job skipped, is an empty factory stub. */
export const SLOW_SELECT_SECONDS = 60;

const FAILED = new Set(["failure", "timed_out"]);
const CODE_EVENTS = new Set(["push", "pull_request", "pull_request_target"]);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export interface CiWorkflowStep {
  name: string;
  reasons: string[];
  /** First line of `run`, so a run view step `Run <cmd>` can be matched. */
  run: string | null;
  uses: string | null;
}

export interface CiWorkflowJob {
  id: string;
  name: string;
  runs: string[];
  steps: CiWorkflowStep[];
}

export interface CiWorkflow {
  file: string;
  name: string;
  /** Every push / pull_request trigger has paths or paths-ignore. Dispatch-only workflows count as filtered. */
  path_filtered: boolean;
  jobs: CiWorkflowJob[];
}

export interface JobStat {
  workflow: string;
  name: string;
  runs: number;
  failures: number;
  failure_rate: number;
  minutes_per_week: number;
  p50_s: number | null;
  p90_s: number | null;
  never_failed: boolean;
}

export interface ReportOnlyStep {
  name: string;
  reasons: string[];
  /** Step duration in seconds when a run view had it. Null when the view omitted steps. */
  seconds: number | null;
}

export interface ReportOnlyJob {
  file: string;
  job: string;
  /** Full job minutes/week only when every step of the job is report-only. Otherwise null. */
  minutes_per_week: number | null;
  steps: ReportOnlyStep[];
}

export interface CiSignal {
  window_days: number;
  runs: number;
  truncated: boolean;
  /** Runs left out because `gh run view` failed. The rest of the window is kept. */
  skipped: number;
  /** Set when the list was cut off: per-week figures use the days actually covered, not the full window. */
  truncation: string | null;
  minutes_per_week: number;
  jobs: JobStat[];
  never_failed: { workflow: string; name: string; runs: number }[];
  slow_without_paths: { workflow: string; file: string | null; name: string; p50_s: number }[];
  report_only: ReportOnlyJob[];
  empty_stub: { select_p50_s: number; select_runs: number; check_skipped: number; check_ran: number } | null;
  duplicates: { command: string; workflows: string[] }[];
  push_to_main: { workflow: string; file: string | null; runs: number; minutes_per_week: number }[];
  /** Shell or aggregate jobs that ran but reported no duration. Not zero defects and not a clean bill. */
  measurement_gaps: string[];
}

/** Attach `gh run view` JSON to list rows that fall inside the window. */
export function assembleRuns(rows: RunListRow[], views: Record<string, unknown>, sinceIso: string): CiRun[] {
  return rows
    .filter((row) => row.created_at >= sinceIso)
    .map((row) => ({
      id: row.id,
      sha: row.sha,
      workflow: row.workflow,
      event: row.event,
      conclusion: row.conclusion,
      created_at: row.created_at,
      head_branch: row.head_branch,
      path: row.path,
      jobs: parseRunView(views[String(row.id)]),
    }));
}

function triggersOf(doc: Record<string, unknown>): { name: string; value: unknown }[] {
  const on = doc.on ?? doc.true;
  if (typeof on === "string") return [{ name: on, value: true }];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === "string").map((name) => ({ name, value: true }));
  if (on && typeof on === "object") return Object.entries(on as Record<string, unknown>).map(([name, value]) => ({ name, value }));
  return [];
}

function hasPaths(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const paths = (value as Record<string, unknown>).paths ?? (value as Record<string, unknown>)["paths-ignore"];
  return Array.isArray(paths) ? paths.length > 0 : typeof paths === "string" && paths.length > 0;
}

function reportOnly(step: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (step["continue-on-error"] === true || step["continue-on-error"] === "true") reasons.push("continue-on-error");
  const with_ = step.with;
  if (with_ && typeof with_ === "object") {
    const exit = (with_ as Record<string, unknown>)["exit-code"];
    if (exit === 0 || exit === "0") reasons.push("exit-code: 0");
  }
  return reasons;
}

function normCommand(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
}

/** Workflow files, including the factory stub. Unparsable files are skipped. */
export function readCiWorkflows(repoDir: string): CiWorkflow[] {
  const dir = join(repoDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const out: CiWorkflow[] = [];
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = `.github/workflows/${name}`;
    let doc: Record<string, unknown>;
    try {
      doc = (parse(readFileSync(join(dir, name), "utf8")) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    const triggers = triggersOf(doc);
    const code = triggers.filter((t) => CODE_EVENTS.has(t.name));
    const jobs = Object.entries((doc.jobs ?? {}) as Record<string, unknown>).flatMap(([id, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const job = raw as Record<string, unknown>;
      const steps = (Array.isArray(job.steps) ? job.steps : []) as Record<string, unknown>[];
      return [{
        id,
        name: typeof job.name === "string" ? job.name : id,
        runs: steps.map((s) => s?.run).filter((r): r is string => typeof r === "string"),
        steps: steps.flatMap((s, i) => (s && typeof s === "object" ? [workflowStep(s, i)] : [])),
      }];
    });
    out.push({
      file,
      name: typeof doc.name === "string" ? doc.name : name.replace(/\.ya?ml$/, ""),
      path_filtered: code.length === 0 || code.every((t) => hasPaths(t.value)),
      jobs,
    });
  }
  return out;
}

function isStub(workflow: string, file: string | null): boolean {
  return workflow === "factory" || file === CI_STUB_PATH;
}

function workflowStep(step: Record<string, unknown>, index: number): CiWorkflowStep {
  const run = typeof step.run === "string" ? step.run : null;
  const uses = typeof step.uses === "string" ? step.uses : null;
  const named = typeof step.name === "string" && step.name.trim() ? step.name.trim() : null;
  const name = named ?? (run ? run.split("\n")[0]!.trim().slice(0, 80) : null) ?? uses ?? `step ${index + 1}`;
  return { name, reasons: reportOnly(step), run, uses };
}

function workflowFor(workflows: CiWorkflow[], run: { workflow: string; path?: string | null }): CiWorkflow | undefined {
  if (run.path) {
    const path = run.path.replace(/^\.\//, "");
    const byPath = workflows.find((w) => w.file === path);
    if (byPath) return byPath;
  }
  return workflows.find((w) => w.name === run.workflow) ?? workflows.find((w) => w.file === run.workflow || w.file.endsWith(`/${run.workflow}.yml`) || w.file.endsWith(`/${run.workflow}.yaml`));
}

function runLabel(run: CiRun, workflows: CiWorkflow[]): string {
  return workflowFor(workflows, run)?.name ?? run.workflow;
}

/** Path when known, so a `run-name` cannot split one workflow into many. */
function runKey(run: CiRun, workflows: CiWorkflow[]): string {
  return run.path ?? workflowFor(workflows, run)?.file ?? run.workflow;
}

function jobBase(name: string): string {
  return name.replace(/ \([^)]*\)$/, "");
}

interface Accum {
  workflow: string;
  name: string;
  runs: number;
  skipped: number;
  failures: number;
  seconds: number;
  secs: number[];
}

function perWeek(seconds: number, windowDays: number): number {
  return round(seconds / 60 / (windowDays / 7), 1);
}

/** Days the per-week figures divide by. The requested window, unless the list was cut off. */
function coveredDays(runs: { created_at: string }[], truncated: boolean, requestedDays: number, now?: Date): { days: number; note: string | null } {
  if (!truncated) return { days: requestedDays, note: null };
  const stamps = runs.map((r) => Date.parse(r.created_at)).filter((n) => Number.isFinite(n));
  if (!stamps.length) {
    return { days: requestedDays, note: `truncated: no runs were read; per-week figures are not a full ${requestedDays}-day window` };
  }
  const oldest = Math.min(...stamps);
  const end = now?.getTime() ?? Math.max(...stamps);
  const days = Math.max(0.1, round(Math.max(0, end - oldest) / 86_400_000, 1));
  return {
    days,
    note: `truncated: per-week figures use ${days} days actually covered, not the full ${requestedDays}-day window`,
  };
}

function stepSeconds(wf: CiWorkflow, job: CiWorkflowJob, step: CiWorkflowStep, runs: CiRun[]): number | null {
  const hint = step.run ? `Run ${step.run.split("\n")[0]!.trim()}` : null;
  const uses = step.uses?.split("@")[0] ?? null;
  const secs: number[] = [];
  for (const run of runs) {
    const matched = workflowFor([wf], run)?.file === wf.file || run.workflow === wf.name || run.path === wf.file;
    if (!matched) continue;
    for (const viewed of run.jobs) {
      if (viewed.name !== job.name && viewed.name !== job.id && jobBase(viewed.name) !== job.id && jobBase(viewed.name) !== job.name) continue;
      for (const seen of viewed.steps ?? []) {
        const hit = seen.name === step.name || (hint !== null && seen.name === hint) || (step.uses !== null && seen.name === step.uses) || (uses !== null && seen.name === uses);
        if (hit && seen.seconds != null) secs.push(seen.seconds);
      }
    }
  }
  return quantile(secs, 0.5);
}

/**
 * Per workflow/job cost and the flags the ci aspect proposes from. High minutes, never-failed,
 * missing path filters, report-only steps, an empty stub, duplicate commands and push-to-main
 * runs are each enough to call the model.
 */
export function ciSignals(input: { runs: CiRun[]; truncated: boolean; skipped?: number; workflows: CiWorkflow[]; baseBranch: string; windowDays?: number; now?: Date }): CiSignal {
  const requestedDays = input.windowDays ?? WINDOW_DAYS;
  const covered = coveredDays(input.runs, input.truncated, requestedDays, input.now);
  const windowDays = covered.days;
  const byJob = new Map<string, Accum>();
  let seconds = 0;
  const pushSeconds = new Map<string, { label: string; runs: number; seconds: number }>();
  for (const run of input.runs) {
    const label = runLabel(run, input.workflows);
    let runSeconds = 0;
    for (const job of run.jobs) {
      const secs = job.seconds ?? 0;
      seconds += secs;
      runSeconds += secs;
      const key = `${runKey(run, input.workflows)}\u0000${job.name}`;
      const acc = byJob.get(key) ?? { workflow: label, name: job.name, runs: 0, skipped: 0, failures: 0, seconds: 0, secs: [] };
      acc.seconds += secs;
      if (!job.conclusion || job.conclusion === "skipped") {
        acc.skipped += 1;
      } else {
        acc.runs += 1;
        if (FAILED.has(job.conclusion)) acc.failures += 1;
        if (job.seconds != null) acc.secs.push(job.seconds);
      }
      byJob.set(key, acc);
    }
    if (run.event === "push" && run.head_branch === input.baseBranch) {
      const key = runKey(run, input.workflows);
      const p = pushSeconds.get(key) ?? { label, runs: 0, seconds: 0 };
      p.runs += 1;
      p.seconds += runSeconds;
      pushSeconds.set(key, p);
    }
  }
  const jobs: JobStat[] = [...byJob.values()]
    .map((acc) => ({
      workflow: acc.workflow,
      name: acc.name,
      runs: acc.runs,
      failures: acc.failures,
      failure_rate: acc.runs ? round(acc.failures / acc.runs, 4) : 0,
      minutes_per_week: perWeek(acc.seconds, windowDays),
      p50_s: quantile(acc.secs, 0.5),
      p90_s: quantile(acc.secs, 0.9),
      never_failed: acc.runs >= NEVER_FAILED_MIN_RUNS && acc.failures === 0,
    }))
    .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.name.localeCompare(b.name));

  const slow_without_paths = jobs.flatMap((job) => {
    if ((job.p50_s ?? 0) <= SLOW_CHECK_SECONDS) return [];
    const wf = workflowFor(input.workflows, { workflow: job.workflow });
    if (isStub(job.workflow, wf?.file ?? null) || wf?.path_filtered) return [];
    return [{ workflow: job.workflow, file: wf?.file ?? null, name: job.name, p50_s: job.p50_s! }];
  });

  const report_only = input.workflows.flatMap((wf) =>
    wf.jobs.flatMap((job) => {
      const flagged = job.steps.filter((s) => s.reasons.length > 0);
      if (!flagged.length) return [];
      const stat = jobs.find((j) => j.workflow === wf.name && (j.name === job.name || j.name === job.id || jobBase(j.name) === job.id || jobBase(j.name) === job.name));
      if (!stat || stat.runs === 0) return [];
      const allReportOnly = job.steps.length > 0 && job.steps.every((s) => s.reasons.length > 0);
      return [{
        file: wf.file,
        job: job.id,
        minutes_per_week: allReportOnly ? stat.minutes_per_week : null,
        steps: flagged.map((step) => ({ name: step.name, reasons: step.reasons, seconds: stepSeconds(wf, job, step, input.runs) })),
      }];
    }),
  );

  const select = jobs.find((j) => j.workflow === "factory" && j.name === "select");
  const checkJobs = [...byJob.values()].filter((j) => j.workflow === "factory" && /^check( \(|$)/.test(j.name));
  const checkRan = checkJobs.reduce((n, j) => n + j.runs, 0);
  const checkSkipped = checkJobs.reduce((n, j) => n + j.skipped, 0);
  // Same floor as never-failed: one slow select is not a pattern.
  const empty =
    select && select.runs >= NEVER_FAILED_MIN_RUNS && (select.p50_s ?? 0) > SLOW_SELECT_SECONDS && checkRan === 0
      ? { select_p50_s: select.p50_s!, select_runs: select.runs, check_skipped: checkSkipped, check_ran: checkRan }
      : null;

  const byCommand = new Map<string, Set<string>>();
  for (const wf of input.workflows) {
    for (const job of wf.jobs) {
      for (const run of job.runs) {
        const command = normCommand(run);
        if (command.length < 8) continue;
        const files = byCommand.get(command) ?? new Set();
        files.add(wf.file);
        byCommand.set(command, files);
      }
    }
  }
  const duplicates = [...byCommand.entries()]
    .filter(([, files]) => files.size >= 2)
    .map(([command, files]) => ({ command, workflows: [...files].sort() }))
    .sort((a, b) => a.command.localeCompare(b.command));

  const timingGap = (job: { name: string; runs: number; p50_s: number | null }) =>
    job.runs > 0 && job.p50_s === null && /\b(?:shellcheck|quality|validate)\b/i.test(job.name);
  const measurement_gaps = jobs.filter(timingGap).map((job) => `CI/${job.name}: timing not reported`);

  const push_to_main = [...pushSeconds.values()]
    .map((p) => ({
      workflow: p.label,
      file: workflowFor(input.workflows, { workflow: p.label })?.file ?? null,
      runs: p.runs,
      minutes_per_week: perWeek(p.seconds, windowDays),
    }))
    .sort((a, b) => a.workflow.localeCompare(b.workflow));

  return {
    window_days: windowDays,
    runs: input.runs.length,
    truncated: input.truncated,
    skipped: input.skipped ?? 0,
    truncation: covered.note,
    minutes_per_week: perWeek(seconds, windowDays),
    jobs,
    never_failed: jobs.filter((j) => j.never_failed && !timingGap(j)).map((j) => ({ workflow: j.workflow, name: j.name, runs: j.runs })),
    slow_without_paths,
    report_only,
    empty_stub: empty,
    duplicates,
    push_to_main,
    measurement_gaps,
  };
}

/** Signals alone are enough. High minutes is a signal; an empty window is not. */
export function ciWorth(signal: CiSignal): boolean {
  return (
    (signal.truncated && signal.runs > 0) ||
    signal.minutes_per_week >= HIGH_CI_MINUTES_PER_WEEK ||
    signal.never_failed.length > 0 ||
    signal.slow_without_paths.length > 0 ||
    signal.report_only.length > 0 ||
    signal.empty_stub !== null ||
    signal.duplicates.length > 0 ||
    signal.push_to_main.length > 0
  );
}
