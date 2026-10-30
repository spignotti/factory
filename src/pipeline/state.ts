import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResultKind } from "../events.js";
import type { Handoff } from "../schemas/handoff.js";
import { type Lane, type RunContext, type Task, writeJson } from "./context.js";
import type { PackageStatus } from "./dag.js";
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
  step: RunStep;
  result: RunResultKind | null;
  reason: string;
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
  /** Effective lane; absent in states written before M2a (= standard). */
  lane?: Lane;
  lane_escalation?: string[];
  /**
   * The run stopped (`needs_human`) on a transient provider error (timeout, dropped stream, capacity) after
   * retries: `factory resume` discards the uncommitted agent leftovers instead of committing them as a human fix.
   */
  transient?: boolean;
  /** Set by `factory gc` once the worktree and branches of a merged/closed PR are gone. */
  gc_at?: string;
  updated_at: string;
}

export function newState(v: { runId: string; repo: string; task: Task; noPr: boolean; lane?: Lane }): RunState {
  return {
    version: 1,
    run_id: v.runId,
    repo: v.repo,
    task: v.task,
    no_pr: v.noPr,
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
    lane: v.lane ?? "standard",
    lane_escalation: [],
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
