import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryEvent } from "./events.js";
import type { RunRecord } from "./runs.js";
import { readEvents } from "./runs.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockHolder(path: string): { pid: number; runId?: string } | undefined {
  try {
    const [pidLine, runId] = readFileSync(path, "utf8").split("\n");
    const pid = Number(pidLine);
    return Number.isInteger(pid) && pid > 0 ? { pid, ...(runId ? { runId } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Run ids named on a repo lock whose holder process is gone (no lease file needed). */
export function orphanedRunIds(factoryHome: string): Set<string> {
  const dir = join(factoryHome, "locks");
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const holder = readLockHolder(path);
    if (holder?.runId && !alive(holder.pid)) out.add(holder.runId);
  }
  return out;
}

/**
 * A `--wait` run or resume still queued for the repo lock: its last `queued` event has no later
 * `lock_acquired`, and the waiting process is alive (a waiter that was killed or aborted is not queued).
 */
export function isQueuedWaiter(run: RunRecord, events: FactoryEvent[]): boolean {
  const q = events.findLastIndex((e) => e.event === "queued");
  if (q < 0) return false;
  if (events.slice(q + 1).some((e) => e.event === "progress" && e.data.lock_acquired !== undefined)) return false;
  const pid = events[q]!.data.waiter_pid;
  if (typeof pid === "number") return alive(pid);
  // events from before waiter_pid: only a fresh run without state or result can still be waiting
  return !run.state && !run.result;
}

export function queuedFromEvents(events: FactoryEvent[]): { holder_run_id: string | null; holder_pid: number | null } {
  const q = events.findLast((e) => e.event === "queued");
  const data = q?.data ?? {};
  return {
    holder_run_id: typeof data.holder_run_id === "string" ? data.holder_run_id : null,
    holder_pid: typeof data.holder_pid === "number" ? data.holder_pid : null,
  };
}

/**
 * Check command still running, from the latest progress or heartbeat that names it.
 * A later `gate_result` or step boundary means nothing is in flight.
 */
/** Stream-abort retry whose follow-up call has not finished yet. */
export function currentStepRetry(events: FactoryEvent[]): { class: string; attempt: number; max: number; package: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "agent_finished" || e.event === "step_finished" || e.event === "run_finished") return null;
    if (e.event !== "step_retry") continue;
    return {
      class: typeof e.data.class === "string" ? e.data.class : "stream",
      attempt: typeof e.data.attempt === "number" ? e.data.attempt : 0,
      max: typeof e.data.max === "number" ? e.data.max : 0,
      package: typeof e.data.package === "string" ? e.data.package : null,
    };
  }
  return null;
}

export function currentCheckName(events: FactoryEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "gate_result" || e.event === "step_finished" || e.event === "step_started") return null;
    if ((e.event === "progress" || e.event === "heartbeat") && e.data.phase === "running" && typeof e.data.check === "string" && e.data.check) {
      return e.data.check;
    }
  }
  return null;
}

export function lastEventMs(events: FactoryEvent[]): number | undefined {
  const last = events.at(-1)?.ts;
  return last ? Date.parse(last) : undefined;
}

export function eventsForRun(run: RunRecord): FactoryEvent[] {
  return readEvents(run);
}
