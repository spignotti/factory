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

export interface CiWorkflowJob {
  id: string;
  name: string;
  runs: string[];
  /** `continue-on-error` or `exit-code: 0`: the step still occupies a runner. */
  report_only: string[];
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

export interface CiSignal {
  window_days: number;
  runs: number;
  truncated: boolean;
  minutes_per_week: number;
  jobs: JobStat[];
  never_failed: { workflow: string; name: string; runs: number }[];
  slow_without_paths: { workflow: string; file: string | null; name: string; p50_s: number }[];
  report_only: { file: string; job: string; reasons: string[]; minutes_per_week: number }[];
  empty_stub: { select_p50_s: number; select_runs: number; check_skipped: number; check_ran: number } | null;
  duplicates: { command: string; workflows: string[] }[];
  push_to_main: { workflow: string; file: string | null; runs: number; minutes_per_week: number }[];
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
      const reasons = [
        ...(job["continue-on-error"] === true || job["continue-on-error"] === "true" ? ["continue-on-error"] : []),
        ...steps.flatMap((s) => (s && typeof s === "object" ? reportOnly(s) : [])),
      ];
      return [{
        id,
        name: typeof job.name === "string" ? job.name : id,
        runs: steps.map((s) => s?.run).filter((r): r is string => typeof r === "string"),
        report_only: [...new Set(reasons)],
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

function workflowFor(workflows: CiWorkflow[], name: string): CiWorkflow | undefined {
  return workflows.find((w) => w.name === name) ?? workflows.find((w) => w.file.endsWith(`/${name}.yml`) || w.file.endsWith(`/${name}.yaml`));
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

/**
 * Per workflow/job cost and the flags the ci aspect proposes from. High minutes, never-failed,
 * missing path filters, report-only steps, an empty stub, duplicate commands and push-to-main
 * runs are each enough to call the model.
 */
export function ciSignals(input: { runs: CiRun[]; truncated: boolean; workflows: CiWorkflow[]; baseBranch: string; windowDays?: number }): CiSignal {
  const windowDays = input.windowDays ?? WINDOW_DAYS;
  const byJob = new Map<string, Accum>();
  let seconds = 0;
  const pushSeconds = new Map<string, { runs: number; seconds: number }>();
  for (const run of input.runs) {
    let runSeconds = 0;
    for (const job of run.jobs) {
      const secs = job.seconds ?? 0;
      seconds += secs;
      runSeconds += secs;
      const key = `${run.workflow}\u0000${job.name}`;
      const acc = byJob.get(key) ?? { workflow: run.workflow, name: job.name, runs: 0, skipped: 0, failures: 0, seconds: 0, secs: [] };
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
      const p = pushSeconds.get(run.workflow) ?? { runs: 0, seconds: 0 };
      p.runs += 1;
      p.seconds += runSeconds;
      pushSeconds.set(run.workflow, p);
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
    const wf = workflowFor(input.workflows, job.workflow);
    if (isStub(job.workflow, wf?.file ?? null) || wf?.path_filtered) return [];
    return [{ workflow: job.workflow, file: wf?.file ?? null, name: job.name, p50_s: job.p50_s! }];
  });

  const report_only = input.workflows.flatMap((wf) =>
    wf.jobs.filter((job) => job.report_only.length).flatMap((job) => {
      const stat = jobs.find((j) => j.workflow === wf.name && (j.name === job.name || j.name === job.id || jobBase(j.name) === job.id || jobBase(j.name) === job.name));
      if (!stat || stat.runs === 0) return [];
      return [{ file: wf.file, job: job.id, reasons: job.report_only, minutes_per_week: stat.minutes_per_week }];
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

  const push_to_main = [...pushSeconds.entries()]
    .map(([workflow, p]) => ({
      workflow,
      file: workflowFor(input.workflows, workflow)?.file ?? null,
      runs: p.runs,
      minutes_per_week: perWeek(p.seconds, windowDays),
    }))
    .sort((a, b) => a.workflow.localeCompare(b.workflow));

  return {
    window_days: windowDays,
    runs: input.runs.length,
    truncated: input.truncated,
    minutes_per_week: perWeek(seconds, windowDays),
    jobs,
    never_failed: jobs.filter((j) => j.never_failed).map((j) => ({ workflow: j.workflow, name: j.name, runs: j.runs })),
    slow_without_paths,
    report_only,
    empty_stub: empty,
    duplicates,
    push_to_main,
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
