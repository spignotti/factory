import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResultKind, RunStop } from "../events.js";
import type { Handoff } from "../schemas/handoff.js";
import { type RunContext, type Task, writeJson } from "./context.js";
import type { PackageStatus } from "./dag.js";
import type { FailureIdentity } from "./recovery.js";
import type { TrackedFinding } from "./merge.js";

/**
 * Where a run continues on `factory resume`:
 * - `intake`: no worktree yet, not resumable (start a new run)
 * - `implement`: packages not done are (re)implemented
 * - `review`: a fresh review loop
 * - `finalize`: full gates, base merge, PR
 * - `finished`: nothing left
 */
export const RUN_STEPS = ["intake", "implement", "review", "finalize", "finished"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** `<runDir>/state.json`, written after every step. */
export interface RunState {
  version: 1;
  run_id: string;
  repo: string;
  task: Task;
  no_pr: boolean;
  /** `--wait` at intake: queue on slot or path overlap at finalize too. */
  wait?: boolean;
  step: RunStep;
  result: RunResultKind | null;
  reason: string;
  /**
   * Machine-readable cause of this stop and the one permitted recovery action (`factory resume`,
   * the worker and `factory status` read this, never the reason text). Absent on a running or
   * finished attempt and on stops written before #179: readers fail closed for those.
   * Checkpoint, branch, worktree, PR and spent budgets stay on this state (and on result.json).
   * `stop` does not copy them. A stored cause never grants merge permission — risk, protected
   * paths, pause, issue revision, model-family separation, reviewed SHA and required checks stay authoritative.
   */
  stop?: RunStop;
  branch: string | null;
  worktree: string | null;
  base_sha: string | null;
  packages: Record<string, PackageStatus>;
  failures: Record<string, string>;
  handoffs: Handoff[];
  rounds: number;
  findings: TrackedFinding[];
  gate_count: number;
  pr: string | null;
  pr_draft: boolean | null;
  /** SHA the runner approved. A newer head is not this commit, so auto-merge stays off. */
  approved_sha?: string;
  /** SHA the in-run review finished on. A later commit is not this evidence. */
  reviewed_sha?: string;
  /** Head CI was still pending or unregistered when the coding run ended. Policy stays auto. */
  ci_wait?: "pending" | "none";
  /** Pending bounded continuation on this same run/PR; no approval is carried to a new head. */
  continuation?: { kind: "ci" | "head" | "base"; sha: string };
  /** Persisted before each automatic continuation; restart never resets the two-attempt budget. */
  continuation_attempts?: number;
  /**
   * Repair budget already spent. Resume continues it. A blocking `class` is not given another
   * product-code edit. Network retries are the same-model connection budget for the whole run.
   * `failure` is the last observed failure identity (#181): repeated identical fingerprints
   * escalate the repair strategy; resume applies that strategy before the next implement turn
   * and keeps the count. Roots name the checks a later green report may not drop.
   */
  repair?: {
    gate_attempts: number;
    network_retries: number;
    format_used: boolean;
    infra_reruns: number;
    class?: "format" | "code" | "infra" | "base" | "config" | "unknown";
    failure?: FailureIdentity;
  };
  /**
   * Coding attempts on this checkpoint. Absent on runs stored before attempt counts existed;
   * resume must not invent one. A new run starts at 1.
   */
  attempts?: number;
  /** Plan effort chosen at intake. Absent when this run never chose one. */
  plan_effort?: "none" | "medium" | "high";
  /** Always `standard`. Older states may say `fast` (the removed fast lane). */
  lane?: "standard" | "fast";
  /** Fast-lane escalation reasons. No longer written. */
  lane_escalation?: string[];
  /**
   * The run stopped (`needs_human`) on a transient provider error (timeout, dropped stream, stream abort, capacity) after
   * retries: `factory resume` discards the uncommitted agent leftovers instead of committing them as a human fix.
   */
  transient?: boolean;
  /** Set by `factory gc` once the worktree and branches of a merged/closed PR are gone. */
  gc_at?: string;
  /**
   * Set when the run stopped because GitHub CI on the base commit was `red` or still `pending`.
   * `factory gc` / the start of `factory run` resumes the same run once that commit is green,
   * within `limits.base_red_resume_hours`. Absent for a local fast-check `base_red`.
   */
  base_ci?: "red" | "pending";
  /** @deprecated Run directories are no longer archived. Left so old state.json files still parse. */
  archived_at?: string;
  /**
   * Named webhook in `notify.yaml` `targets` (the bot that started the run). The name only — never a URL or key.
   * Absent: the repo's default hook, as before named targets existed.
   */
  notify_target?: string;
  updated_at: string;
}

export function newState(v: { runId: string; repo: string; task: Task; noPr: boolean; wait?: boolean; notifyTarget?: string }): RunState {
  return {
    version: 1,
    run_id: v.runId,
    repo: v.repo,
    task: v.task,
    no_pr: v.noPr,
    wait: v.wait ?? false,
    ...(v.notifyTarget ? { notify_target: v.notifyTarget } : {}),
    step: "intake",
    result: null,
    reason: "",
    branch: null,
    worktree: null,
    base_sha: null,
    packages: {},
    failures: {},
    handoffs: [],
    rounds: 0,
    findings: [],
    gate_count: 0,
    pr: null,
    pr_draft: null,
    lane: "standard",
    attempts: 1,
    updated_at: new Date().toISOString(),
  };
}

export function saveState(ctx: Pick<RunContext, "runDir" | "events">, state: RunState): void {
  state.updated_at = new Date().toISOString();
  writeJson(ctx, "state.json", state);
}

export function readState(runDir: string): RunState {
  const path = join(runDir, "state.json");
  if (!existsSync(path)) throw new Error(`no state.json in ${runDir}`);
  const state = JSON.parse(readFileSync(path, "utf8")) as RunState;
  if (state.version !== 1 || !RUN_STEPS.includes(state.step)) throw new Error(`unsupported state.json in ${runDir}`);
  return state;
}
