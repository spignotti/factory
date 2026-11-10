import type { BaseStatus } from "../gh.js";

/** One check run on a commit, as `gh` reports it. */
export interface CheckRunView {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  id?: number;
  /** Workflow suite. Draft and ready runs on one SHA are different suites. */
  suite?: number | null;
}

const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function after(a: CheckRunView, b: CheckRunView): boolean {
  const as = a.started_at ?? "";
  const bs = b.started_at ?? "";
  if (as !== bs) return as > bs;
  return (a.id ?? 0) > (b.id ?? 0);
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

/**
 * CI on one commit.
 *
 * The latest run of each check name wins, so a draft `done` failure does not stick after the
 * ready run succeeds, and a cancelled run does not stick after a re-run. A failed `done` is a
 * draft hold only when its own suite shows it: select/check were skipped, or the minimal stub's
 * `draft` job succeeded. It is not a pass, and it is not a settled red while the ready suite is
 * still running (that would end the factory run before CI starts). A failed or cancelled `done`
 * with neither signal is red, including the minimal stub on a ready pull request (that stub has
 * no select/check, so absence of those jobs is not a draft). Once a real suite has succeeded, a
 * newer draft hold (the PR was converted back to draft) is red. A skipped `done` is red: GitHub
 * treats a skipped required check as passed.
 */
export function aggregateCheckRuns(runs: CheckRunView[]): BaseStatus {
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

  for (const run of latest.values()) {
    if (run.name === "done" && (draftHold || run.conclusion === "skipped")) continue;
    if (run.conclusion && FAIL.has(run.conclusion)) return "red";
  }
  if (done?.conclusion === "skipped") return "red";

  const inProgress = runs.some((run) => run.status !== "completed");
  if (draftHold) {
    if (inProgress) return "pending";
    const succeeded = runs.some((run) => run.name === "done" && run.conclusion === "success");
    // A previous green `done` is no longer valid once the PR is a draft again.
    if (succeeded) return "red";
    return "pending";
  }
  if (inProgress) return "pending";
  return "green";
}
