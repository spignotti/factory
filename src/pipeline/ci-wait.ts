import { realSleep, type Sleep } from "../agents/fake-runner.js";
import type { BaseStatus, GitHub } from "../gh.js";
import { throwIfInterrupted } from "./context.js";

export interface CiPoll {
  github: GitHub;
  repoDir: string;
  sha: string;
  /** 0 = one sample, no wait. Pending is returned as pending (not a failure). */
  waitMinutes: number;
  pollMs: number;
  sleep?: Sleep;
  signal?: AbortSignal;
  /**
   * `waiting` once, when a pending status will be polled; `settled` after the last sample
   * of that wait. A status that is not pending (or a zero wait) does not call this.
   */
  onUpdate?: (info: { status: BaseStatus; phase: "waiting" | "settled"; waitedMs: number }) => void;
}

/**
 * Check-runs on one commit. Pending is polled until it settles or `waitMinutes` pass.
 * The caller decides what red, pending and none mean; this only waits.
 */
export async function pollCommitCi(opts: CiPoll): Promise<{ status: BaseStatus; waitedMs: number }> {
  const started = Date.now();
  let status = await opts.github.baseStatus(opts.repoDir, opts.sha);
  if (status !== "pending" || opts.waitMinutes <= 0) return { status, waitedMs: 0 };
  const sleep = opts.sleep ?? realSleep;
  const polls = Math.ceil((opts.waitMinutes * 60_000) / opts.pollMs);
  opts.onUpdate?.({ status, phase: "waiting", waitedMs: 0 });
  for (let i = 0; i < polls && status === "pending"; i++) {
    await sleep(opts.pollMs, opts.signal);
    throwIfInterrupted(opts);
    status = await opts.github.baseStatus(opts.repoDir, opts.sha);
  }
  const waitedMs = Date.now() - started;
  opts.onUpdate?.({ status, phase: "settled", waitedMs });
  return { status, waitedMs };
}
