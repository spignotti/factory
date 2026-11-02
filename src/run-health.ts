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

export function lastEventMs(events: FactoryEvent[]): number | undefined {
  const last = events.at(-1)?.ts;
  return last ? Date.parse(last) : undefined;
}

export function eventsForRun(run: RunRecord): FactoryEvent[] {
  return readEvents(run);
}
