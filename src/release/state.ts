import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { listRuns } from "../runs.js";

/**
 * Durable records of the release handoff (#187), all under `$FACTORY_HOME/releases`.
 *
 * Staging and activation are separate: a candidate is a built, tested, immutable tree registered
 * here, and only an approved candidate whose digest still matches can become the active release.
 * Nothing in this module starts a process or writes into a live installation.
 */

/** Layout version of these records. */
export const RECORD_VERSION = 1 as const;

const WritesSchema = z.object({
  queue: z.number().int().positive(),
  run_state: z.number().int().positive(),
  plan: z.number().int().positive(),
});

const ReadsSchema = z.object({
  queue: z.array(z.number().int().positive()).min(1),
  run_state: z.array(z.number().int().positive()).min(1),
  plan: z.array(z.number().int().positive()).min(1),
});

/** Durable state this code reads, and the one version it writes. */
export const DATA_VERSIONS = {
  reads: { queue: [1], run_state: [1], plan: [1] },
  writes: { queue: 1, run_state: 1, plan: 1 },
} as const;

export type Writes = z.infer<typeof WritesSchema>;
export type Reads = z.infer<typeof ReadsSchema>;

const SHA40 = /^[0-9a-f]{40}$/;

export const CandidateSchema = z.object({
  schema: z.literal(RECORD_VERSION),
  id: z.string().min(1),
  /** Package version of the staged build. */
  version: z.string().min(1),
  /** Full commit the candidate was built from. A pinned candidate is never re-resolved. */
  commit: z.string().regex(SHA40),
  /** Ref the operator named (tag or branch); reported, never re-resolved. */
  ref: z.string().optional(),
  staged_at: z.string(),
  /** Checks that ran over this exact tree. Empty when it was staged without testing. */
  checks_passed: z.array(z.string()),
  tested: z.boolean(),
  /** sha256 over the candidate tree. The candidate is immutable: any change fails verification. */
  digest: z.string(),
  reads: ReadsSchema,
  writes: WritesSchema,
  /** `engines.node` of the staged build; the runtime must satisfy it before this release runs. */
  node_engine: z.string(),
  /** Permission to activate. It binds to this digest: a changed tree is not the approved artifact. */
  approval: z.object({ at: z.string(), digest: z.string() }).optional(),
});

export type Candidate = Omit<z.infer<typeof CandidateSchema>, "schema">;

export const ActiveSchema = z.object({
  schema: z.literal(RECORD_VERSION),
  id: z.string().min(1),
  commit: z.string().regex(SHA40),
  /** The candidate the queue was on before this switch. */
  previous_id: z.string().optional(),
  activated_at: z.string(),
  /** Digest of the tree that was activated; a handoff re-verifies it before it becomes active. */
  digest: z.string(),
});

export type Active = z.infer<typeof ActiveSchema>;

export const HANDOFF_PHASES = ["planned", "draining", "switched", "verifying", "committed", "rolled_back", "aborted", "failed"] as const;
export type HandoffPhase = (typeof HANDOFF_PHASES)[number];

/** A transaction ends at one of these; only then may the next handoff start. */
export const TERMINAL_PHASES: readonly HandoffPhase[] = ["committed", "rolled_back", "aborted", "failed"];

export const HandoffSchema = z.object({
  schema: z.literal(RECORD_VERSION),
  id: z.string().min(1),
  phase: z.enum(HANDOFF_PHASES),
  from_id: z.string().optional(),
  to_id: z.string().min(1),
  /** The operator's worker mode when the handoff started; written back when it ends. */
  user_mode: z.string(),
  /** The operator accepted a durable-state migration: an automatic rollback is then unsafe. */
  migration: z.boolean().default(false),
  /** Pid of the process driving this transaction. A live owner means the handoff is still running. */
  owner_pid: z.number().int().optional(),
  steps: z.array(z.object({ phase: z.enum(HANDOFF_PHASES), at: z.string() })).default([]),
  started_at: z.string(),
  updated_at: z.string(),
});

export type Handoff = Omit<z.infer<typeof HandoffSchema>, "schema">;

export function releasesDir(home: string): string {
  return join(home, "releases");
}

function candidatesDir(home: string): string {
  return join(releasesDir(home), "candidates");
}

/** The sealed build tree of one candidate. */
export function candidateDir(home: string, id: string): string {
  return join(candidatesDir(home), id);
}

function candidateManifestPath(home: string, id: string): string {
  return join(candidatesDir(home), `${id}.json`);
}

export function activePath(home: string): string {
  return join(releasesDir(home), "active.json");
}

export function handoffPath(home: string): string {
  return join(releasesDir(home), "handoff.json");
}

export function candidateId(version: string, commit: string): string {
  return `${version}-${commit.slice(0, 12)}`;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Atomic replace: a reader sees the old record or the new one, never a partial write. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function candidateExists(home: string, id: string): boolean {
  return existsSync(candidateManifestPath(home, id)) || existsSync(candidateDir(home, id));
}

export function readCandidate(home: string, id: string): Candidate | undefined {
  const raw = readJson(candidateManifestPath(home, id));
  if (raw === undefined) return undefined;
  const parsed = CandidateSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { schema: _schema, ...candidate } = parsed.data;
  return candidate;
}

/** Staged candidates, oldest first. An unreadable manifest is skipped, never guessed. */
export function listCandidates(home: string): Candidate[] {
  const dir = candidatesDir(home);
  if (!existsSync(dir)) return [];
  const out: Candidate[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const candidate = readCandidate(home, name.slice(0, -".json".length));
    if (candidate) out.push(candidate);
  }
  return out;
}

export function writeCandidate(home: string, candidate: Candidate): Candidate {
  writeJsonAtomic(candidateManifestPath(home, candidate.id), { schema: RECORD_VERSION, ...candidate });
  return candidate;
}

/** The active release plus the package version of the candidate it names. */
export function readActive(home: string): (Active & { version: string }) | undefined {
  const parsed = ActiveSchema.safeParse(readJson(activePath(home)));
  if (!parsed.success) return undefined;
  const active = parsed.data;
  return { ...active, version: readCandidate(home, active.id)?.version ?? "unknown" };
}

export function writeActive(home: string, candidate: Candidate, previousId?: string): Active & { version: string } {
  const body: Active = {
    schema: RECORD_VERSION,
    id: candidate.id,
    commit: candidate.commit,
    ...(previousId ? { previous_id: previousId } : {}),
    activated_at: new Date().toISOString(),
    digest: candidate.digest,
  };
  writeJsonAtomic(activePath(home), body);
  return { ...body, version: candidate.version };
}

export function readTx(home: string): Handoff | undefined {
  const parsed = HandoffSchema.safeParse(readJson(handoffPath(home)));
  if (!parsed.success) return undefined;
  const { schema: _schema, ...tx } = parsed.data;
  return tx;
}

export function writeTx(home: string, tx: Handoff): Handoff {
  const body: Handoff = { ...tx, updated_at: new Date().toISOString() };
  writeJsonAtomic(handoffPath(home), { schema: RECORD_VERSION, ...body });
  return body;
}

/** sha256 over a tree (paths, sizes and content), so any change is visible. */
export function treeDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel === "" ? name : join(rel, name));
      return;
    }
    hash.update(`${rel}\u0000${st.size}\u0000`);
    hash.update(readFileSync(abs));
    hash.update("\n");
  };
  try {
    walk("");
  } catch {
    return "unreadable";
  }
  return hash.digest("hex");
}

export interface DiskVersions {
  queue: number[];
  run_state: number[];
  plan: number[];
}

/** Durable state versions this home holds. An unreadable file is skipped, not invented. */
export function dataVersionsOnDisk(home: string): DiskVersions {
  const found = { queue: new Set<number>(), run_state: new Set<number>(), plan: new Set<number>() };
  const dir = join(home, "queue");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const raw = readJson(join(dir, name)) as { version?: unknown } | undefined;
      if (typeof raw?.version === "number") found.queue.add(raw.version);
    }
  }
  for (const run of listRuns(home)) {
    const state = readJson(join(run.dir, "state.json")) as { version?: unknown } | undefined;
    if (typeof state?.version === "number") found.run_state.add(state.version);
    const plan = readJson(join(run.dir, "plan.json")) as { version?: unknown } | undefined;
    if (typeof plan?.version === "number") found.plan.add(plan.version);
  }
  const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
  return { queue: sorted(found.queue), run_state: sorted(found.run_state), plan: sorted(found.plan) };
}

/** Counts from the durable queue and run records only: no GitHub call, nothing started. */
export function workInFlight(home: string): { pending: number; running: number; parked: number; paused: number; ci_waiting: number } {
  let pending = 0;
  let running = 0;
  let parked = 0;
  let paused = 0;
  // A queue this build cannot parse (newer schema) must still be counted, not hide the rest.
  const dir = join(home, "queue");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const raw = readJson(join(dir, name)) as { entries?: { status?: unknown; paused?: unknown }[] } | undefined;
      for (const e of raw?.entries ?? []) {
        if (e.status === "pending") pending += 1;
        else if (e.status === "running") running += 1;
        else if (e.status === "parked") parked += 1;
        if (e.paused) paused += 1;
      }
    }
  }
  const ciWaiting = listRuns(home).filter((r) => r.state?.ci_wait !== undefined && r.state.gc_at === undefined).length;
  return { pending, running, parked, paused, ci_waiting: ciWaiting };
}
