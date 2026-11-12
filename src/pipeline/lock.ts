import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realSleep } from "../agents/fake-runner.js";
import { canonicalRepoId } from "../memory.js";
import { claimsConflict, type PathClaim } from "./overlap.js";

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

/** A takeover or alloc guard older than this belongs to a crashed process. */
const GUARD_STALE_MS = 10_000;
/** Retries when another process briefly holds the per-repo `.alloc` guard (not when slots are full). */
const ALLOC_GUARD_RETRIES = 12;

function releaseAllocGuard(guard: string): void {
  try {
    if (existsSync(guard) && readFileSync(guard, "utf8").trim() === String(process.pid)) rmSync(guard, { force: true });
  } catch {
    // already gone
  }
}

/**
 * Remove a stale `.alloc` guard without unlinking a file another process just recreated.
 * Renames the guard aside, re-checks the holder, then deletes the trash name.
 */
function stealStaleAllocGuard(guard: string): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(guard);
  } catch {
    return true;
  }
  let pid: number;
  try {
    pid = Number(readFileSync(guard, "utf8").trim());
  } catch {
    // released between stat and read: free again, the caller retries the claim
    return true;
  }
  if (Number.isInteger(pid) && pid > 0 && alive(pid) && Date.now() - st.mtimeMs <= GUARD_STALE_MS) return false;
  const trash = `${guard}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(guard, trash);
  } catch {
    return false;
  }
  try {
    const tp = Number(readFileSync(trash, "utf8").trim());
    const tst = statSync(trash);
    if (Number.isInteger(tp) && tp > 0 && alive(tp) && Date.now() - tst.mtimeMs <= GUARD_STALE_MS) {
      // Put the live guard back without replacing one created meanwhile (rename would clobber it).
      try {
        linkSync(trash, guard);
      } catch {
        // a newer guard exists; it wins
      }
      rmSync(trash, { force: true });
      return false;
    }
  } catch {
    // empty or unreadable trash: drop it
  }
  rmSync(trash, { force: true });
  return true;
}

function withAlloc<T>(dir: string, key: string, fn: () => T): T | "busy" {
  const guard = join(dir, `${key}.alloc`);
  let claimed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(guard, String(process.pid), { flag: "wx" });
      claimed = true;
      break;
    } catch {
      if (!stealStaleAllocGuard(guard)) return "busy";
    }
  }
  if (!claimed) return "busy";
  try {
    return fn();
  } finally {
    releaseAllocGuard(guard);
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);

/** `https://user:token@host/path` → `https://host/path`. scp-style `git@host:path` is left as-is. */
export function stripUserinfo(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+)@(.+)$/i, "$1$3");
}

/**
 * Lock-file key for a repo id (origin URL or path): userinfo stripped, then a short hash of the
 * canonical id plus a readable owner/repo slug. The credential never appears in the key.
 * Not idempotent — pass the raw id once.
 */
export function lockRepoKey(raw: string): string {
  const stripped = stripUserinfo(raw.trim());
  const canonical = canonicalRepoId(stripped, stripped);
  const parts = canonical.split("/").filter(Boolean);
  const slugSrc = parts.slice(-2).join("-") || "repo";
  const slug = slugSrc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "repo";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function locksDir(factoryHome: string): string {
  return join(factoryHome, "locks");
}

function slotPath(dir: string, key: string, slot: number): string {
  return join(dir, slot === 0 ? `${key}.lock` : `${key}.${slot}.lock`);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function existingSlots(dir: string, key: string): number[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${escapeReg(key)}(?:\\.(\\d+))?\\.lock$`);
  const slots: number[] = [];
  for (const name of readdirSync(dir)) {
    const m = re.exec(name);
    if (m) slots.push(m[1] ? Number(m[1]) : 0);
  }
  return slots;
}

/** Previous lock filename (sanitized raw id), when it differs from the current key. Tests plant a stale holder. */
export function legacyLockPath(factoryHome: string, repoId: string): string | undefined {
  const key = lockRepoKey(repoId);
  const name = safe(repoId);
  if (name === key) return undefined;
  return join(locksDir(factoryHome), `${name}.lock`);
}

/**
 * A live legacy file (the pre-hash name, which may contain a credential) blocks the repo.
 * A stale one is deleted so the credential leaves the filename.
 */
function settleLegacy(dir: string, repoId: string, key: string): "live" | "clear" {
  const name = safe(repoId);
  if (name === key) return "clear";
  const legacy = join(dir, `${name}.lock`);
  if (!existsSync(legacy)) return "clear";
  if (holderAlive(legacy)) return "live";
  rmSync(legacy, { force: true });
  rmSync(`${legacy}.paths`, { force: true });
  rmSync(`${legacy}.takeover`, { force: true });
  return "clear";
}

/** Hard-link claim of one slot. Same takeover guard as the single-slot lock. */
function tryClaim(path: string, runId: string): (() => void) | undefined {
  const guard = `${path}.takeover`;
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
  const owned = () => {
    // A crashed holder may have left a path claim beside the file we just replaced.
    rmSync(`${path}.paths`, { force: true });
    return () => {
      rmSync(path, { force: true });
      rmSync(`${path}.paths`, { force: true });
    };
  };
  try {
    if (link()) return owned();
    if (holderAlive(path)) return undefined;
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
      return link() ? owned() : undefined;
    } finally {
      rmSync(guard, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function resourcePath(factoryHome: string, name: string): string {
  return join(locksDir(factoryHome), `resource.${safe(name)}.lock`);
}

export interface ResourceHeld {
  name: string;
  runId?: string;
  pid: number;
}

/**
 * Claim each named resource (a shared database or test fixture) for `runId`.
 * The same live run already holding the name is not claimed again: this caller's release
 * does not delete that file, so a queue pre-claim and `takeRepoLock` do not drop it early.
 * A different live holder fails the whole call and releases only the names this call took.
 */
export function claimResources(
  factoryHome: string,
  names: string[],
  runId: string,
): { ok: true; release: () => void } | { ok: false; held: ResourceHeld } {
  const unique = [...new Set(names)];
  if (!unique.length) return { ok: true, release: () => undefined };
  mkdirSync(locksDir(factoryHome), { recursive: true });
  const releases: Array<() => void> = [];
  for (const name of unique) {
    const path = resourcePath(factoryHome, name);
    const holder = readHolder(path);
    if (holder && alive(holder.pid) && holder.runId === runId) continue;
    const rel = tryClaim(path, runId);
    if (!rel) {
      for (const undo of releases) undo();
      const held = readHolder(path);
      return { ok: false, held: { name, runId: held?.runId, pid: held?.pid ?? 0 } };
    }
    releases.push(rel);
  }
  return {
    ok: true,
    release: () => {
      for (const undo of releases) undo();
    },
  };
}

/** Drop resource locks held by `runId`. A lock held by another run stays. */
export function releaseResourceClaims(factoryHome: string, names: string[], runId: string): void {
  for (const name of new Set(names)) {
    const path = resourcePath(factoryHome, name);
    if (readHolder(path)?.runId === runId) rmSync(path, { force: true });
  }
}

export type LockRelease = (() => void) & { slot: number };

export type AcquireLockResult = { status: "acquired"; release: LockRelease } | { status: "alloc_busy" } | { status: "unavailable" };

function claimSlotsUnderAlloc(dir: string, key: string, repoId: string, runId: string, opts?: LockOptions): LockRelease | undefined {
  if (settleLegacy(dir, repoId, key) === "live") return undefined;
  const maxRuns = Math.min(32, Math.max(1, Math.floor(opts?.maxRuns ?? 1)));
  if (opts?.exclusive) {
    const highest = existingSlots(dir, key).reduce((m, s) => Math.max(m, s), -1);
    const n = Math.max(maxRuns, highest + 1);
    const taken: LockRelease[] = [];
    for (let slot = 0; slot < n; slot++) {
      const rel = claimSlot(dir, key, slot, runId);
      if (!rel) {
        for (const r of taken) r();
        return undefined;
      }
      taken.push(rel);
    }
    return Object.assign(
      () => {
        for (const r of taken) r();
      },
      { slot: 0 },
    ) as LockRelease;
  }
  for (let slot = 0; slot < maxRuns; slot++) {
    const rel = claimSlot(dir, key, slot, runId);
    if (rel) return rel;
  }
  return undefined;
}

/** One attempt to take a slot; `alloc_busy` means the `.alloc` guard was held, not that slots are full. */
export function attemptAcquireRepoLock(factoryHome: string, repoId: string, runId: string, opts?: LockOptions): AcquireLockResult {
  const key = lockRepoKey(repoId);
  const dir = locksDir(factoryHome);
  mkdirSync(dir, { recursive: true });
  const outcome = withAlloc(dir, key, () => claimSlotsUnderAlloc(dir, key, repoId, runId, opts));
  if (outcome === "busy") return { status: "alloc_busy" };
  if (!outcome) return { status: "unavailable" };
  return { status: "acquired", release: outcome };
}

function allocRetryDelayMs(attempt: number): number {
  return 5 + Math.floor(Math.random() * 35) + attempt * 2;
}

/** Retries briefly when only the `.alloc` guard is busy (see NB1). */
export async function acquireRepoLockWithRetry(
  factoryHome: string,
  repoId: string,
  runId: string,
  opts?: LockOptions & { signal?: AbortSignal },
): Promise<LockRelease | undefined> {
  for (let attempt = 0; attempt < ALLOC_GUARD_RETRIES; attempt++) {
    const r = attemptAcquireRepoLock(factoryHome, repoId, runId, opts);
    if (r.status === "acquired") return r.release;
    if (r.status === "unavailable") return undefined;
    await realSleep(allocRetryDelayMs(attempt), opts?.signal);
  }
  return undefined;
}

export interface LockOptions {
  /** How many runs may hold a slot at once. Default 1 (one run per repo). */
  maxRuns?: number;
  /** Claim every slot (metadata archive) so a new run cannot start mid-cleanup. */
  exclusive?: boolean;
}

function claimSlot(dir: string, key: string, slot: number, runId: string): LockRelease | undefined {
  const rel = tryClaim(slotPath(dir, key, slot), runId);
  if (!rel) return undefined;
  return Object.assign(rel, { slot });
}

/**
 * Per-repo lock `<factoryHome>/locks/<slug>-<hash>.lock` (further slots `<key>.<n>.lock`).
 * `maxRuns` 1 is one slot. A lock whose process is gone is stale and taken over.
 * A live legacy file (the old sanitized-URL name) blocks every slot; a stale one is removed.
 * Returns a release function (`.slot` is the slot taken), or undefined when the lock is held.
 */
export function acquireRepoLock(factoryHome: string, repoId: string, runId: string, opts?: LockOptions): LockRelease | undefined {
  const r = attemptAcquireRepoLock(factoryHome, repoId, runId, opts);
  return r.status === "acquired" ? r.release : undefined;
}

/** Who holds slot 0 right now (undefined when free or stale). */
export function repoLockHolder(factoryHome: string, repoId: string): LockHolder | undefined {
  const path = slotPath(locksDir(factoryHome), lockRepoKey(repoId), 0);
  return holderAlive(path) ? readHolder(path) : undefined;
}

/** Path of slot 0 (tests plant a stale holder). */
export function repoLockPath(factoryHome: string, repoId: string): string {
  return slotPath(locksDir(factoryHome), lockRepoKey(repoId), 0);
}

function candidateLocks(factoryHome: string, repoId: string): string[] {
  const dir = locksDir(factoryHome);
  const key = lockRepoKey(repoId);
  const paths = existingSlots(dir, key).map((slot) => slotPath(dir, key, slot));
  const legacy = legacyLockPath(factoryHome, repoId);
  if (legacy && existsSync(legacy)) paths.push(legacy);
  return paths;
}

/**
 * Drops a lock held by `runId` when its process is gone, whichever slot it is on.
 * A live holder is left in place: abandoning a run that is still executing would let another run share the repo.
 */
export function releaseRunLock(factoryHome: string, repoId: string, runId: string): { status: "released" | "absent" | "live"; pid?: number } {
  let sawLive = false;
  let livePid: number | undefined;
  let released = false;
  let releasedPid: number | undefined;
  for (const path of candidateLocks(factoryHome, repoId)) {
    const holder = readHolder(path);
    if (!holder || holder.runId !== runId) continue;
    if (alive(holder.pid)) {
      sawLive = true;
      livePid = holder.pid;
      continue;
    }
    rmSync(path, { force: true });
    rmSync(`${path}.paths`, { force: true });
    released = true;
    releasedPid = holder.pid;
  }
  if (sawLive) return { status: "live", pid: livePid };
  if (released) return { status: "released", pid: releasedPid };
  return { status: "absent" };
}

export type PathDecision = { ok: true } | { ok: false; kind: "busy" } | { ok: false; kind: "conflict"; conflicts: string[] };

interface StoredClaim extends PathClaim {
  runId: string;
}

function readStored(lockFile: string): StoredClaim | "none" | "bad" {
  const side = `${lockFile}.paths`;
  if (!existsSync(side)) return "none";
  try {
    const j = JSON.parse(readFileSync(side, "utf8")) as Partial<StoredClaim>;
    if (!j || !Array.isArray(j.paths) || typeof j.exclusive !== "boolean") return "bad";
    return {
      runId: typeof j.runId === "string" ? j.runId : "",
      paths: j.paths.filter((p): p is string => typeof p === "string"),
      exclusive: j.exclusive,
    };
  } catch {
    return "bad";
  }
}

/**
 * Publish this slot's planned paths and accept them when they do not overlap another live slot.
 * A live slot that has not published paths yet (still planning) does not conflict; the later
 * publisher yields. On conflict the claim is removed and the slot stays held — the caller releases
 * it before waiting, so two runs cannot deadlock. `busy` means the alloc guard was held; retry.
 */
export function decidePathClaim(factoryHome: string, repoId: string, slot: number, runId: string, claim: PathClaim): PathDecision {
  const key = lockRepoKey(repoId);
  const dir = locksDir(factoryHome);
  mkdirSync(dir, { recursive: true });
  const outcome = withAlloc(dir, key, (): PathDecision => {
    const path = slotPath(dir, key, slot);
    const holder = readHolder(path);
    if (!holder || holder.runId !== runId || !alive(holder.pid)) return { ok: false, kind: "conflict", conflicts: ["lock lost"] };
    const side = `${path}.paths`;
    const stored: StoredClaim = { runId, paths: claim.paths, exclusive: claim.exclusive };
    writeFileSync(side, JSON.stringify(stored));
    const conflicts: string[] = [];
    for (const slotN of existingSlots(dir, key)) {
      if (slotN === slot) continue;
      const other = slotPath(dir, key, slotN);
      if (!holderAlive(other)) continue;
      const theirs = readStored(other);
      if (theirs === "none") continue;
      const claimThere: PathClaim = theirs === "bad" ? { paths: [], exclusive: true } : theirs;
      if (!claimsConflict(claim, claimThere)) continue;
      const who = readHolder(other)?.runId ?? "unknown";
      const listed = (theirs === "bad" ? [] : theirs.paths).slice(0, 8).join(", ");
      const why = claimThere.exclusive ? `exclusive${listed ? `: ${listed}` : ""}` : listed || "paths";
      conflicts.push(`${who} (${why})`);
    }
    if (conflicts.length) {
      rmSync(side, { force: true });
      return { ok: false, kind: "conflict", conflicts };
    }
    return { ok: true };
  });
  return outcome === "busy" ? { ok: false, kind: "busy" } : outcome;
}

/**
 * Queue: polls until a slot is free and takes it. Rejects with the signal's reason when aborted
 * (SIGINT/SIGTERM while waiting).
 */
export async function waitForRepoLock(
  factoryHome: string,
  repoId: string,
  runId: string,
  opts: { pollMs: number; signal?: AbortSignal; maxRuns?: number },
): Promise<LockRelease> {
  for (;;) {
    const r = attemptAcquireRepoLock(factoryHome, repoId, runId, { maxRuns: opts.maxRuns });
    if (r.status === "acquired") return r.release;
    if (r.status === "alloc_busy") {
      await realSleep(allocRetryDelayMs(0), opts.signal);
      continue;
    }
    await realSleep(opts.pollMs, opts.signal);
  }
}

/**
 * One attempt at a hard-link lock that is not a run slot (git worktree mutations).
 * The holder pid is the liveness check: a dead pid is taken over, same as a repo slot.
 */
export async function tryPathLock<T>(
  lockFile: string,
  holder: string,
  fn: () => Promise<T> | T,
  opts?: { waitMs?: number; pollMs?: number },
): Promise<{ ok: true; value: T } | { ok: false }> {
  const waitMs = opts?.waitMs ?? 0;
  const pollMs = opts?.pollMs ?? 20;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const release = tryClaim(lockFile, holder);
    if (release) {
      try {
        return { ok: true, value: await fn() };
      } finally {
        release();
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false };
    await realSleep(Math.min(pollMs, left));
  }
}

/** Live lock holders (running runs and resumes), one per held slot. */
export function activeHolders(factoryHome: string): LockHolder[] {
  const dir = locksDir(factoryHome);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".lock"))
    .map((n) => join(dir, n))
    .filter(holderAlive)
    .map((p) => readHolder(p)!)
    .filter(Boolean);
}
