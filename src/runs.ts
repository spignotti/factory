import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryEvent, RunResult } from "./events.js";
import type { RunState } from "./pipeline/state.js";

/** One run directory as `status`, `stats` and `gc` see it. Unreadable files are left out. */
export interface RunRecord {
  run_id: string;
  dir: string;
  /** From the run id (`YYYYMMDD-HHMMSS-xxxxxx`, UTC). */
  started_at: Date;
  state?: RunState;
  /** Last `result.json` (the latest attempt: run or resume). */
  result?: RunResult;
}

const RUN_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]+$/;

export function runStartedAt(runId: string): Date | undefined {
  const m = RUN_ID.exec(runId);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}

function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** All runs under `$FACTORY_HOME/runs`, oldest first. */
export function listRuns(factoryHome: string): RunRecord[] {
  const root = join(factoryHome, "runs");
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const id of readdirSync(root).sort()) {
    const started = runStartedAt(id);
    if (!started) continue;
    const dir = join(root, id);
    const state = readJson<RunState>(join(dir, "state.json"));
    const result = readJson<RunResult>(join(dir, "result.json"));
    out.push({ run_id: id, dir, started_at: started, ...(state ? { state } : {}), ...(result ? { result } : {}) });
  }
  return out;
}

export function readEvents(run: RunRecord): FactoryEvent[] {
  const path = join(run.dir, "events.jsonl");
  if (!existsSync(path)) return [];
  const out: FactoryEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as FactoryEvent);
    } catch {
      // a torn last line of a killed run
    }
  }
  return out;
}
