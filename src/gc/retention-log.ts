import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { GcReportSchema } from "../schemas/reports.js";

export type GcReport = z.infer<typeof GcReportSchema>;

const MAX_LOG = 5 * 1024 * 1024;

export interface GcLogEntry {
  at: string;
  scheduled: boolean;
  deploy_self_busy?: boolean;
  report: GcReport;
}

export function gcLogPath(factoryHome: string): string {
  return join(factoryHome, "gc.log");
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= MAX_LOG) return;
  const rotated = `${path}.1`;
  if (existsSync(rotated)) renameSync(rotated, `${path}.2`);
  renameSync(path, rotated);
}

/** Appends one JSON line to `$FACTORY_HOME/gc.log` (rotates at 5 MiB). */
export function appendGcLog(factoryHome: string, entry: GcLogEntry): string {
  const path = gcLogPath(factoryHome);
  rotateIfNeeded(path);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return path;
}
