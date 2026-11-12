import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PauseKey {
  runId?: string;
  repo?: string;
  issue?: number;
}

function safe(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

/** Files the queue and the run both see. The run looks up its id; the queue also writes the issue. */
export function pausePaths(factoryHome: string, key: PauseKey): string[] {
  const dir = join(factoryHome, "queue", "pause");
  const out: string[] = [];
  if (key.runId) out.push(join(dir, `run-${safe(key.runId)}`));
  if (key.repo !== undefined && key.issue !== undefined) out.push(join(dir, `issue-${safe(key.repo)}-${key.issue}`));
  return out;
}

/** Ask the running pipeline to stop at the next step boundary. Does not signal the process. */
export function requestPause(factoryHome: string, key: PauseKey, reason: string): void {
  const paths = pausePaths(factoryHome, key);
  if (!paths.length) return;
  mkdirSync(join(factoryHome, "queue", "pause"), { recursive: true });
  for (const path of paths) writeFileSync(path, reason);
}

/** The pause reason, when a marker for this run or issue exists. */
export function pauseRequested(factoryHome: string, key: PauseKey): string | undefined {
  for (const path of pausePaths(factoryHome, key)) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // not this key
    }
  }
  return undefined;
}

export function clearPause(factoryHome: string, key: PauseKey): void {
  for (const path of pausePaths(factoryHome, key)) rmSync(path, { force: true });
}
