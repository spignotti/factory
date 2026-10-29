import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realSleep } from "../agents/fake-runner.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockHolder {
  pid: number;
  runId?: string;
}

/** Lock file content: `<pid>\n<run-id>`. */
function readHolder(path: string): LockHolder | undefined {
  try {
    const [pidLine, runId] = readFileSync(path, "utf8").split("\n");
    const pid = Number(pidLine);
    return Number.isInteger(pid) && pid > 0 ? { pid, ...(runId ? { runId } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function holderAlive(path: string): boolean {
  const holder = readHolder(path);
  return holder !== undefined && alive(holder.pid);
}

/** A takeover guard older than this belongs to a crashed process. */
const GUARD_STALE_MS = 10_000;

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

function lockPath(factoryHome: string, repoId: string): string {
  return join(factoryHome, "locks", `${safe(repoId)}.lock`);
}

/**
 * Per-repo lock `<factoryHome>/locks/<repo-id>.lock`: one factory process per repository at a time
 * (runs and resumes). A lock whose process is gone is stale and taken over. Returns a release
 * function, or undefined when the lock is held.
 */
export function acquireRepoLock(factoryHome: string, repoId: string, runId: string): (() => void) | undefined {
  const path = lockPath(factoryHome, repoId);
  mkdirSync(join(factoryHome, "locks"), { recursive: true });
  const guard = `${path}.takeover`;
  // The content is written before the lock appears (hard link is atomic), so readers never see an empty lock.
  const tmp = `${path}.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${process.pid}\n${runId}`);
  const link = () => {
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    }
  };
  try {
    if (link()) return () => rmSync(path, { force: true });
    if (holderAlive(path)) return undefined;
    // Stale: only the holder of the takeover guard may remove it, after re-checking under the guard.
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch {
      // no guard
    }
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
    } catch {
      return undefined;
    }
    try {
      if (holderAlive(path)) return undefined;
      rmSync(path, { force: true });
      return link() ? () => rmSync(path, { force: true }) : undefined;
    } finally {
      rmSync(guard, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Who holds the repo lock right now (undefined when free or stale). */
export function repoLockHolder(factoryHome: string, repoId: string): LockHolder | undefined {
  const path = lockPath(factoryHome, repoId);
  return holderAlive(path) ? readHolder(path) : undefined;
}

/**
 * Queue: polls until the repo lock is free and takes it. Rejects with the signal's reason when
 * aborted (SIGINT/SIGTERM while waiting).
 */
export async function waitForRepoLock(
  factoryHome: string,
  repoId: string,
  runId: string,
  opts: { pollMs: number; signal?: AbortSignal },
): Promise<() => void> {
  for (;;) {
    const release = acquireRepoLock(factoryHome, repoId, runId);
    if (release) return release;
    await realSleep(opts.pollMs, opts.signal);
  }
}
