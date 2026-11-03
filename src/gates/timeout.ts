import type { ShResult } from "../exec.js";
import type { Deadline } from "../pipeline/budget.js";
import type { Check } from "../schemas/repo.js";

/** Whether `sh` killed the command for `timeoutMs`. */
export function shTimedOut(r: ShResult): boolean {
  return r.output.includes("[factory] timed out after ");
}

/**
 * Per-check gate timeout: min(per-check or repo default, remaining wall budget when set).
 * At least 1 s when a deadline caps the budget.
 */
export function gateCheckTimeoutMs(opts: {
  check?: Pick<Check, "timeout_minutes">;
  gateTimeoutMinutes: number;
  deadline?: Deadline;
}): number | undefined {
  const minutes = opts.check?.timeout_minutes ?? opts.gateTimeoutMinutes;
  const capMs = minutes * 60_000;
  if (opts.deadline === undefined) return capMs;
  return Math.min(capMs, Math.max(1000, opts.deadline.at - Date.now()));
}
