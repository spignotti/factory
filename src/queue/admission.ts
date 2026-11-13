import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A temporary admission hold, written by a release handoff and read by the one worker.
 *
 * This is deliberately not the `pause`/`drain` marker: `queue/control` is the operator's intent and
 * survives a version switch, while this hold belongs to one handoff transaction and is released when
 * that transaction commits, rolls back or aborts. `target_release` says which release the queue is
 * moving to, so the worker it replaces is the one asked to leave.
 */
export type AdmissionState = "hold" | "drain";

export interface Admission {
  state: AdmissionState;
  /** Handoff transaction that set it. Another transaction's hold is neither read nor cleared. */
  tx: string;
  reason: string;
  /** Candidate id the queue is moving to. A worker running it is not asked to leave. */
  target_release: string;
  at: string;
}

/** A marker beside `queue/control`, without a `.json` name: the queue loaders must not read it. */
export function admissionPath(home: string): string {
  return join(home, "queue", "admission");
}

export function requestAdmissionHold(
  home: string,
  req: { state?: AdmissionState; tx: string; reason: string; target_release?: string },
): Admission {
  const a: Admission = {
    state: req.state ?? "hold",
    tx: req.tx,
    reason: req.reason,
    target_release: req.target_release ?? "",
    at: new Date().toISOString(),
  };
  const dir = join(home, "queue");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.admission.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n");
  renameSync(tmp, admissionPath(home));
  return a;
}

/** The live hold. An unreadable or half-written file is no hold, so a worker is never frozen. */
export function admissionHold(home: string): Admission | undefined {
  let raw: Partial<Admission>;
  try {
    raw = JSON.parse(readFileSync(admissionPath(home), "utf8")) as Partial<Admission>;
  } catch {
    return undefined;
  }
  if (typeof raw.tx !== "string" || !raw.tx) return undefined;
  if (raw.state !== "hold" && raw.state !== "drain") return undefined;
  return {
    state: raw.state,
    tx: raw.tx,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    target_release: typeof raw.target_release === "string" ? raw.target_release : "",
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/** Removes the hold. With `tx`, only that transaction's hold is removed. */
export function clearAdmissionHold(home: string, tx?: string): void {
  const live = admissionHold(home);
  if (!live) return;
  if (tx !== undefined && live.tx !== tx) return;
  rmSync(admissionPath(home), { force: true });
}
