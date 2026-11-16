import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../release/state.js";

/**
 * Outcome of the local fast checks on a base commit (run only when GitHub reports no CI status for
 * it), kept per repository in `$FACTORY_HOME/base-checks/<repo key>.json`. A green record lets later
 * runs on the same base skip the checks. A red one keeps the queue worker from starting runs that
 * would fail the same way, until the base moves or `BASE_RECHECK_MS` has passed.
 */
export const BASE_RECHECK_MS = 30 * 60_000;

const RecordSchema = z.object({
  sha: z.string().min(1),
  status: z.enum(["green", "red"]),
  /** Checks that failed on the base; empty when green. */
  failed: z.array(z.string()),
  /** When the base was checked, or when the worker last let a run re-check it. */
  at: z.string(),
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

export function writeBaseCheck(factoryHome: string, repoKey: string, record: BaseCheckRecord): void {
  writeJsonAtomic(recordPath(factoryHome, repoKey), record);
}

/** Human-readable base problem of a red record, naming the failed checks. */
export function baseProblem(record: BaseCheckRecord | undefined): string | undefined {
  if (record?.status !== "red") return undefined;
  const recheck = new Date(Date.parse(record.at) + BASE_RECHECK_MS).toISOString();
  return `base problem: fast checks red on base ${record.sha.slice(0, 8)}: ${record.failed.join(", ") || "unknown"} (re-check after ${recheck} or when the base moves)`;
}

/**
 * What the worker may do for a base commit without GitHub CI status: `start` (no red record for
 * this SHA), `block` (red and recent), or `recheck` (red, but old enough for one run to check again).
 */
export function baseCheckGate(record: BaseCheckRecord | undefined, sha: string, now: number): "start" | "block" | "recheck" {
  if (!record || record.status !== "red" || record.sha !== sha) return "start";
  const at = Date.parse(record.at);
  return Number.isFinite(at) && now - at < BASE_RECHECK_MS ? "block" : "recheck";
}
