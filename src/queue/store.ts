import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { repoLockId, type GitCallOptions } from "../git.js";
import { lockRepoKey, tryPathLock } from "../pipeline/lock.js";

/** Issue must carry this label before `queue add` accepts it. */
export const FACTORY_READY_LABEL = "factory-ready";
/** Issue with this label is not ready to run. */
export const NEEDS_PLAN_LABEL = "needs-plan";

export const QUEUE_STATUSES = ["pending", "running", "done", "parked"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export interface QueueEntry {
  issue: number;
  status: QueueStatus;
  /** Start only once this issue's factory PR is merged. */
  after?: number;
  run_id?: string;
  pr?: string;
  reason?: string;
  /** Times a transient `needs_human` sent this entry to the back. At most 2. */
  requeues?: number;
  /** Open factory PR numbers that overlap this run. Pending again once each is merged or closed. */
  blocked_by?: number[];
  /** Live factory runs whose claimed paths overlap this one. Pending again once each has finished. */
  blocked_runs?: string[];
  pid?: number;
  added_at: string;
  /** Label removed while the run was in progress. The process is left alive; the pipeline stops at a step boundary. */
  paused?: boolean;
  /** Why this issue was the one started (priority, age). Not a blocker reason. */
  choice?: string;
  /** Set on an extra issue while it is part of another issue's bundle. It is not started on its own. */
  bundled_with?: number;
  /** Hash of the issue title and body at the last start. A mismatch drops the saved plan. */
  issue_rev?: string;
  /**
   * Written when a coding run reaches `done`. Absent on older entries: those stay unknown,
   * even when `status` is `done` and `pr` is set. `merged: "no"` is not a confirmed merge.
   */
  delivery?: {
    merged: "no" | "confirmed" | "unknown";
    pr: string | null;
    attempts: number | null;
  };
}

export interface QueueFile {
  version: 1;
  /** Absolute checkout the worker runs in. */
  repo: string;
  repo_key: string;
  entries: QueueEntry[];
}

const EntrySchema = z.object({
  issue: z.number().int().positive(),
  status: z.enum(QUEUE_STATUSES),
  after: z.number().int().positive().optional(),
  run_id: z.string().optional(),
  pr: z.string().optional(),
  reason: z.string().optional(),
  requeues: z.number().int().min(0).optional(),
  blocked_by: z.array(z.number().int().positive()).optional(),
  blocked_runs: z.array(z.string()).optional(),
  pid: z.number().int().optional(),
  added_at: z.string(),
  paused: z.boolean().optional(),
  choice: z.string().optional(),
  bundled_with: z.number().int().positive().optional(),
  issue_rev: z.string().optional(),
  delivery: z
    .object({
      merged: z.enum(["no", "confirmed", "unknown"]),
      pr: z.string().nullable(),
      attempts: z.number().int().min(0).nullable(),
    })
    .optional(),
});

const FileSchema = z.object({
  version: z.literal(1),
  repo: z.string().min(1),
  repo_key: z.string().min(1),
  entries: z.array(EntrySchema),
});

export function queueDir(factoryHome: string): string {
  return join(factoryHome, "queue");
}

export function queuePath(factoryHome: string, key: string): string {
  return join(queueDir(factoryHome), `${key}.json`);
}

/** Same key as the repo lock: origin URL, else the path. One queue per repository. */
export async function repoQueueKey(repoDir: string, opts?: GitCallOptions): Promise<string> {
  return lockRepoKey(await repoLockId(resolve(repoDir), opts));
}

export function parseQueue(text: string, path: string): QueueFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`queue file ${path} is not JSON`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`queue file ${path} is invalid`);
  return parsed.data;
}

export function loadQueueByKey(factoryHome: string, key: string): QueueFile | undefined {
  const path = queuePath(factoryHome, key);
  if (!existsSync(path)) return undefined;
  return parseQueue(readFileSync(path, "utf8"), path);
}

/** Atomic replace. Readers see the previous file or the new one, never a partial write. */
export function saveQueue(factoryHome: string, file: QueueFile): void {
  const dir = queueDir(factoryHome);
  mkdirSync(dir, { recursive: true });
  const path = queuePath(factoryHome, file.repo_key);
  const tmp = join(dir, `.${file.repo_key}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

export function loadAllQueues(factoryHome: string): QueueFile[] {
  const dir = queueDir(factoryHome);
  if (!existsSync(dir)) return [];
  const out: QueueFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    out.push(parseQueue(readFileSync(path, "utf8"), path));
  }
  return out;
}

/**
 * Read-modify-write under a short lock so `queue add` and the worker do not drop each other's entries.
 * Creates the file on first use.
 */
export async function updateQueue<T>(factoryHome: string, repoDir: string, fn: (q: QueueFile) => Promise<T> | T, opts?: GitCallOptions): Promise<T> {
  const repo = resolve(repoDir);
  const key = await repoQueueKey(repo, opts);
  const dir = queueDir(factoryHome);
  mkdirSync(dir, { recursive: true });
  const held = await tryPathLock(
    join(dir, `${key}.write.lock`),
    "queue",
    async () => {
      const q = loadQueueByKey(factoryHome, key) ?? { version: 1 as const, repo, repo_key: key, entries: [] };
      q.repo = repo;
      const value = await fn(q);
      saveQueue(factoryHome, q);
      return value;
    },
    { waitMs: 60_000 },
  );
  if (!held.ok) throw new Error(`queue for ${repo} is busy`);
  return held.value;
}

export interface QueueNext {
  issue: number;
  status: "pending" | "running" | "parked";
  run_id: string | null;
  reason: string | null;
}

export interface QueueSummary {
  repo: string;
  pending: number;
  running: number;
  parked: number;
  next: QueueNext[];
}

const NEXT_LIMIT = 5;

function isOpen(e: QueueEntry): e is QueueEntry & { status: "pending" | "running" | "parked" } {
  return e.status !== "done";
}

export function summarizeQueue(q: QueueFile): QueueSummary {
  const count = (s: QueueStatus) => q.entries.filter((e) => e.status === s).length;
  return {
    repo: q.repo,
    pending: count("pending"),
    running: count("running"),
    parked: count("parked"),
    next: q.entries.filter(isOpen).slice(0, NEXT_LIMIT).map((e) => ({
      issue: e.issue,
      status: e.status,
      run_id: e.run_id ?? null,
      reason: e.reason ?? (e.after !== undefined && e.status === "pending" ? `after #${e.after}` : null),
    })),
  };
}

/** Unreadable files are skipped so `factory status` still prints. */
export function summarizeQueues(factoryHome: string): QueueSummary[] {
  const dir = queueDir(factoryHome);
  if (!existsSync(dir)) return [];
  const out: QueueSummary[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      out.push(summarizeQueue(parseQueue(readFileSync(join(dir, name), "utf8"), join(dir, name))));
    } catch {
      // a corrupt queue file must not hide the rest of status
    }
  }
  return out;
}
