import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the one worker for this factory home should behave. Absent file means `run`. */
export const WORKER_MODES = ["run", "pause", "drain", "stop"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

export function controlPath(factoryHome: string): string {
  return join(factoryHome, "queue", "control");
}

/** `run` when no marker is present. Unknown text is `run` so a torn write does not freeze the worker. */
export function readWorkerMode(factoryHome: string): WorkerMode {
  try {
    const text = readFileSync(controlPath(factoryHome), "utf8").trim();
    if (text === "pause" || text === "drain" || text === "stop") return text;
  } catch {
    // no marker
  }
  return "run";
}

export function writeWorkerMode(factoryHome: string, mode: Exclude<WorkerMode, "run">): void {
  mkdirSync(join(factoryHome, "queue"), { recursive: true });
  writeFileSync(controlPath(factoryHome), `${mode}\n`);
}

/** `resume`, and `stop` once the worker has seen it. Pause and drain stay until this. */
export function clearWorkerMode(factoryHome: string): void {
  rmSync(controlPath(factoryHome), { force: true });
}
