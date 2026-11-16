import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../release/state.js";

/**
 * Outcome of the local fast checks on a base commit (run only when GitHub reports no CI status for
 * it), kept per repository in `$FACTORY_HOME/base-checks/<repo key>.json`. A green record lets later
 * runs on the same base skip the checks. A red one keeps the queue worker from starting runs that
 * would fail the same way, until the base moves or the re-check interval has passed.
 */
export const BASE_RECHECK_MS = 30 * 60_000;
/** The interval doubles per re-check of the same red base, up to this. */
export const MAX_BASE_RECHECK_MS = 4 * 60 * 60_000;

const RecordSchema = z.object({
  sha: z.string().min(1),
  status: z.enum(["green", "red"]),
  /** Checks that failed on the base; empty when green. */
  failed: z.array(z.string()),
  /** When the base was checked, or when the worker last let a run re-check it. */
  at: z.string(),
  /** Re-checks the worker started for this red SHA. Each one doubles the wait; a new SHA starts over. */
  rechecks: z.number().int().min(0).optional(),
});
export type BaseCheckRecord = z.infer<typeof RecordSchema>;

function recordPath(factoryHome: string, repoKey: string): string {
  return join(factoryHome, "base-checks", `${repoKey}.json`);
}

/** The latest record of a repository. A missing or unreadable file is no record. */
export function readBaseCheck(factoryHome: string, repoKey: string): BaseCheckRecord | undefined {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(readFileSync(recordPath(factoryHome, repoKey), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A run that finds the same base red again keeps the re-check count, so the backoff survives it. */
export function writeBaseCheck(factoryHome: string, repoKey: string, record: BaseCheckRecord): void {
  const prev = record.rechecks === undefined && record.status === "red" ? readBaseCheck(factoryHome, repoKey) : undefined;
  const carried = prev?.status === "red" && prev.sha === record.sha && prev.rechecks !== undefined ? { rechecks: prev.rechecks } : {};
  writeJsonAtomic(recordPath(factoryHome, repoKey), { ...record, ...carried });
}

/** Wait before the next re-check of a red base: 30 min, then 1 h, 2 h, at most 4 h. */
export function baseRecheckMs(record: Pick<BaseCheckRecord, "rechecks">): number {
  return Math.min(BASE_RECHECK_MS * 2 ** (record.rechecks ?? 0), MAX_BASE_RECHECK_MS);
}

/** Human-readable base problem of a red record, naming the failed checks. */
export function baseProblem(record: BaseCheckRecord | undefined): string | undefined {
  if (record?.status !== "red") return undefined;
  const recheck = new Date(Date.parse(record.at) + baseRecheckMs(record)).toISOString();
  return `base problem: fast checks red on base ${record.sha.slice(0, 8)}: ${record.failed.join(", ") || "unknown"} (re-check after ${recheck} or when the base moves)`;
}

/**
 * What the worker may do for a base commit without GitHub CI status: `start` (no red record for
 * this SHA), `block` (red and recent), or `recheck` (red, but old enough for one run to check again).
 */
export function baseCheckGate(record: BaseCheckRecord | undefined, sha: string, now: number): "start" | "block" | "recheck" {
  if (!record || record.status !== "red" || record.sha !== sha) return "start";
  const at = Date.parse(record.at);
  return Number.isFinite(at) && now - at < baseRecheckMs(record) ? "block" : "recheck";
}
