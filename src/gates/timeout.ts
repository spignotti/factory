import type { ShResult } from "../exec.js";
import type { Deadline } from "../pipeline/budget.js";
import type { Check } from "../schemas/repo.js";

/** Default gap between progress heartbeats while a check command is still running. */
export const CHECK_HEARTBEAT_MS = 30_000;

/** Whether `sh` killed the command for `timeoutMs`. */
export function shTimedOut(r: ShResult): boolean {
  return r.output.includes("[factory] timed out after ");
}

/**
 * Per-check gate timeout: `timeout_s`, else `timeout_minutes`, else the repo default (10 min / 600 s).
 * Min of that and the remaining wall budget when a deadline is set. At least 1 s when the budget caps it.
 */
export function gateCheckTimeoutMs(opts: {
  check?: Pick<Check, "timeout_s" | "timeout_minutes">;
  gateTimeoutMinutes: number;
  deadline?: Deadline;
}): number | undefined {
  const capMs =
    opts.check?.timeout_s !== undefined
      ? opts.check.timeout_s * 1000
      : (opts.check?.timeout_minutes ?? opts.gateTimeoutMinutes) * 60_000;
  if (opts.deadline === undefined) return capMs;
  return Math.min(capMs, Math.max(1000, opts.deadline.at - Date.now()));
}

export interface CheckPulse {
  check: string;
  event: "progress" | "heartbeat";
  /** setup / base / head for the red-green proof; absent for an ordinary check. */
  where?: string;
}

/**
 * Emits one progress event up front and a heartbeat while `run` is in flight, so a long
 * sandboxed check shows up in `factory status` instead of looking idle.
 */
export async function watchCheck<T>(
  check: string,
  run: () => Promise<T>,
  opts?: { heartbeatMs?: number; where?: string; onCheck?: (e: CheckPulse) => void },
): Promise<T> {
  const onCheck = opts?.onCheck;
  const pulse = (event: CheckPulse["event"]) => onCheck?.({ check, event, ...(opts?.where ? { where: opts.where } : {}) });
  pulse("progress");
  const ms = opts?.heartbeatMs ?? CHECK_HEARTBEAT_MS;
  const timer = onCheck && ms > 0 ? setInterval(() => pulse("heartbeat"), ms) : undefined;
  timer?.unref();
  try {
    return await run();
  } finally {
    if (timer) clearInterval(timer);
  }
}
