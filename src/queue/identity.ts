import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryIdentity } from "../pipeline/outcome.js";

/**
 * Which release a process runs, and which process owns the queue.
 *
 * The queue worker publishes this while it holds `queue/worker.lock`, so `factory release status`
 * can name the version that owns the queue, and a handoff can prove that the worker it started is
 * the only holder. A reader always checks the pid: a file naming a dead process is stale, never the
 * live worker.
 */

export interface ReleaseIdentity {
  /** Candidate id (`<version>-<commit12>`), the `FACTORY_RELEASE_ID`, or `installed-<version>`. */
  id: string;
  version: string;
  /** Full commit of this build, or `unknown` when the tree carries no commit. */
  commit: string;
}

export interface WorkerIdentity extends ReleaseIdentity {
  pid: number;
  at: string;
}

/** Root of the running package (`dist/queue/identity.js` → the package root). */
export function installRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const SHA40 = /^[0-9a-f]{40}$/;

/** A release directory built without git carries its commit in `BUILD.json`. Never guessed. */
function commitOf(root: string): string {
  const build = readJson(join(root, "BUILD.json"));
  const fromBuild = typeof build?.commit === "string" ? build.commit.trim() : "";
  return SHA40.test(fromBuild) ? fromBuild : "unknown";
}

/**
 * Identity of the code this process runs. `FACTORY_RELEASE_ID` (set when a handoff starts a worker
 * from a staged candidate) wins, so the worker reports the candidate it was started from.
 */
export function executingRelease(root = installRoot()): ReleaseIdentity {
  const identity = factoryIdentity(root);
  const commit = identity.commit !== "unknown" ? identity.commit : commitOf(root);
  const override = process.env.FACTORY_RELEASE_ID?.trim();
  const id = override || (commit !== "unknown" ? `${identity.version}-${commit.slice(0, 12)}` : `installed-${identity.version}`);
  return { id, version: identity.version, commit };
}

/** No `.json` name: `loadAllQueues` must never try to parse it as a queue. */
export function workerIdentityPath(home: string): string {
  return join(home, "queue", "worker.id");
}

export function workerLockPath(home: string): string {
  return join(home, "queue", "worker.lock");
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Publishes this process as the queue worker. Callers hold `queue/worker.lock`. */
export function publishWorkerIdentity(home: string, release: ReleaseIdentity): void {
  const dir = join(home, "queue");
  mkdirSync(dir, { recursive: true });
  const body: WorkerIdentity = { ...release, pid: process.pid, at: new Date().toISOString() };
  writeFileSync(workerIdentityPath(home), JSON.stringify(body, null, 2) + "\n");
}

/** Removes the identity file, but only while it still names this process. */
export function clearWorkerIdentity(home: string, pid = process.pid): void {
  const live = readWorkerIdentity(home);
  if (live && live.pid !== pid) return;
  rmSync(workerIdentityPath(home), { force: true });
}

/** The published identity, or undefined when absent or unreadable. Says nothing about liveness. */
export function readWorkerIdentity(home: string): WorkerIdentity | undefined {
  const raw = readJson(workerIdentityPath(home)) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  if (typeof raw.version !== "string" || typeof raw.commit !== "string") return undefined;
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined;
  return { id: raw.id, version: raw.version, commit: raw.commit, pid: raw.pid, at: typeof raw.at === "string" ? raw.at : "" };
}

/** The pid holding `queue/worker.lock`, when that process is alive. A stale file names nobody. */
export function workerLockHolder(home: string): number | undefined {
  const path = workerLockPath(home);
  if (!existsSync(path)) return undefined;
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8").split("\n")[0]);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pidAlive(pid) ? pid : undefined;
}

/** The identity of a live worker: published, and its process still running. */
export function currentWorker(home: string): WorkerIdentity | undefined {
  const identity = readWorkerIdentity(home);
  if (!identity || !pidAlive(identity.pid)) return undefined;
  return identity;
}

/** True when the live worker is the process that holds the worker lock. */
export function workerOwnsLock(home: string, identity: WorkerIdentity | undefined = currentWorker(home)): boolean {
  if (!identity) return false;
  return workerLockHolder(home) === identity.pid;
}
