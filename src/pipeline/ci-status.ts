import type { BaseStatus } from "../gh.js";

/** One check run on a commit, as `gh` reports it. */
export interface CheckRunView {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  /**
   * When the workflow run / check suite was created. Event order, not when the job started:
   * a draft `done` can start after the ready `done` because it waited on a runner.
   */
  created_at?: string | null;
  id?: number;
  /** Workflow suite. Draft and ready runs on one SHA are different suites. */
  suite?: number | null;
  /**
   * Workflow `name:` (`templates/ci/factory.yml` is `factory`). Absent when the payload did not
   * include it: that run keeps the job-name recognition below.
   */
  workflow?: string | null;
}

/** Workflow `name:` of both CI stubs. Job names (`check`, `done`, `draft`) are not unique to it. */
export const FACTORY_WORKFLOW = "factory";

const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/** Later workflow event wins. Job start time is only a tie-break inside one event. */
function after(a: CheckRunView, b: CheckRunView): boolean {
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac && bc && ac !== bc) return ac > bc;
  // Suite id is assigned when the run is created. Used when created_at is missing (Actions API down).
  if (a.suite != null && b.suite != null && a.suite !== b.suite) return a.suite > b.suite;
  const as = a.started_at ?? "";
  const bs = b.started_at ?? "";
  if (as !== bs) return as > bs;
  return (a.id ?? 0) > (b.id ?? 0);
}

/** A different, later factory event. Same-suite jobs are one event even if one started later. */
function laterEvent(a: CheckRunView, b: CheckRunView): boolean {
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac && bc && ac !== bc) return ac > bc;
  if (a.suite != null && b.suite != null && a.suite !== b.suite) return a.suite > b.suite;
  return false;
}

function isGate(name: string): boolean {
  return name === "select" || name === "check" || name.startsWith("check (");
}

/**
 * Minimal stub job (`templates/ci/factory-minimal.yml`). It runs only on a draft pull request.
 * A successful run in `done`'s suite is what makes that failure a draft hold. The job id is the
 * check-run name; the stub and this constant must stay the same.
 */
export const DRAFT_HOLD_JOB = "draft";

/** Select/check that actually started. A skipped job did not run the matrix. */
function ranGate(run: CheckRunView): boolean {
  return isGate(run.name) && run.conclusion !== "skipped";
}

function skippedGate(run: CheckRunView): boolean {
  return isGate(run.name) && run.conclusion === "skipped";
}

/** The minimal stub's draft marker finished. A skipped or cancelled marker is not a hold. */
function ranDraftMarker(run: CheckRunView): boolean {
  return run.name === DRAFT_HOLD_JOB && run.conclusion === "success";
}

/** Factory stub job. A later lint/dependabot suite must not hide a settled factory failure. */
function factorySignal(name: string): boolean {
  return name === "done" || name === DRAFT_HOLD_JOB || isGate(name);
}

/** Named factory workflow, or a run whose workflow name was not in the payload. */
function factoryRun(run: CheckRunView): boolean {
  const name = run.workflow?.trim();
  return !name || name === FACTORY_WORKFLOW;
}

function worse(a: BaseStatus, b: BaseStatus): BaseStatus {
  if (a === "red" || b === "red") return "red";
  if (a === "pending" || b === "pending") return "pending";
  if (a === "green" || b === "green") return "green";
  return "none";
}

/**
 * CI on one commit.
 *
 * Draft-hold and latest-event logic apply only to the factory workflow (`name: factory`). A run
 * with no workflow name keeps the previous job-name recognition. Other workflows are a plain
 * rollup: latest of each name, a failure is red, anything still running is pending. They are not
 * a draft hold and do not hide a factory `done`.
 *
 * Inside the factory workflow, the latest run of each check name wins by workflow event order
 * (`created_at`, else suite id), not by when the job started. A draft `done` can start after the
 * ready `done` and must not stick; a cancelled draft run is not latest after a later ready run.
 * Inside one event, a re-run's later `started_at` still wins. A failed `done` is a draft hold only
 * when its own suite shows it: select/check were skipped, or the minimal stub's `draft` job
 * succeeded. It is not a pass, and it is not a settled red while a later factory event has started
 * but not reported `done` (cancelling the draft run can fail `done` before the ready check run
 * exists). A failed or cancelled `done` with neither signal is red, including the minimal stub on
 * a ready pull request (that stub has no select/check, so absence of those jobs is not a draft).
 * Once a real suite has succeeded, a newer draft hold (the PR was converted back to draft) is red.
 * A skipped `done` is red: GitHub treats a skipped required check as passed.
 */
export function aggregateCheckRuns(runs: CheckRunView[]): BaseStatus {
  if (runs.length === 0) return "none";
  const factory: CheckRunView[] = [];
  const other: CheckRunView[] = [];
  for (const run of runs) (factoryRun(run) ? factory : other).push(run);
  return worse(aggregateFactoryRuns(factory), aggregateOtherRuns(other));
}

/** Other workflows: no draft hold, no factory event order. Latest of a name still wins a re-run. */
function aggregateOtherRuns(runs: CheckRunView[]): BaseStatus {
  if (runs.length === 0) return "none";
  const latest = new Map<string, CheckRunView>();
  for (const run of runs) {
    const prev = latest.get(run.name);
    if (!prev || after(run, prev)) latest.set(run.name, run);
  }
  for (const run of latest.values()) {
    if (run.conclusion && FAIL.has(run.conclusion)) return "red";
  }
  if (runs.some((run) => run.status !== "completed")) return "pending";
  return "green";
}

function aggregateFactoryRuns(runs: CheckRunView[]): BaseStatus {
  if (runs.length === 0) return "none";
  const latest = new Map<string, CheckRunView>();
  for (const run of runs) {
    const prev = latest.get(run.name);
    if (!prev || after(run, prev)) latest.set(run.name, run);
  }
  const suites = new Map<number, CheckRunView[]>();
  for (const run of runs) {
    if (run.suite == null) continue;
    const list = suites.get(run.suite) ?? [];
    list.push(run);
    suites.set(run.suite, list);
  }
  const done = latest.get("done");
  // No suite id: a failed `done` is a real failure. A draft hold needs positive evidence in that suite.
  const ownSuite = done?.suite != null ? (suites.get(done.suite) ?? []) : [];
  const draftHold =
    !!done &&
    !!done.conclusion &&
    FAIL.has(done.conclusion) &&
    done.suite != null &&
    !ownSuite.some(ranGate) &&
    (ownSuite.some(skippedGate) || ownSuite.some(ranDraftMarker));
  // Cancelling the draft run can fail `done` before the ready run has a `done` check. Not red yet.
  const laterOpen = !!done && runs.some((run) => factorySignal(run.name) && laterEvent(run, done));

  for (const run of latest.values()) {
    if (run.name === "done" && (draftHold || laterOpen || run.conclusion === "skipped")) continue;
    if (run.conclusion && FAIL.has(run.conclusion)) return "red";
  }
  if (done?.conclusion === "skipped" && !laterOpen) return "red";

  const inProgress = runs.some((run) => run.status !== "completed");
  if (draftHold) {
    if (inProgress || laterOpen) return "pending";
    const succeeded = runs.some((run) => run.name === "done" && run.conclusion === "success");
    // A previous green `done` is no longer valid once the PR is a draft again.
    if (succeeded) return "red";
    return "pending";
  }
  if (laterOpen || inProgress) return "pending";
  return "green";
}
