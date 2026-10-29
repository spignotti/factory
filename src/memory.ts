import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeClaim, type TrackedFinding } from "./pipeline/merge.js";

/**
 * Findings memory (SPEC §10): recurring review findings and flaky checks per repository, outside the
 * repo in `$FACTORY_HOME/memory/<repo-id>/findings.json`. Fed after every run; the top open entries brief
 * the implementer and the reviewers; `harden` (M3) turns them into checks (`proposed`, `resolved`).
 */
export const MemoryEntrySchema = z.object({
  key: z.string().min(1),
  text: z.string(),
  reviewer: z.string(),
  checkable: z.enum(["lint", "test", "script", "no"]),
  check_sketch: z.string(),
  count: z.number().int().min(1),
  first_seen: z.string(),
  last_seen: z.string(),
  runs: z.array(z.string()),
  status: z.enum(["open", "proposed", "resolved"]),
  ref: z.string().nullable(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MemoryFileSchema = z.object({
  version: z.literal(1),
  repo: z.string(),
  entries: z.array(MemoryEntrySchema),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;

/** Most runs remembered per entry (counts keep growing). */
const MAX_RUNS = 20;
export const BRIEFING_SIZE = 10;

/**
 * Canonical repo id from `remote.origin.url`: `host/owner/repo` for ssh, scp-like and https URLs
 * (credentials, `.git` and case of the host dropped); a local path when there is no origin.
 */
export function canonicalRepoId(originUrl: string, repoDir: string): string {
  const url = originUrl.trim();
  if (!url) return `local${repoDir}`;
  const m = /^[\w.-]+@([^:/]+):(.+)$/.exec(url); // git@github.com:owner/repo.git
  let host: string;
  let path: string;
  if (m) {
    host = m[1]!;
    path = m[2]!;
  } else {
    try {
      const u = new URL(url);
      host = u.hostname;
      path = u.pathname;
      if (u.protocol === "file:") host = "file";
    } catch {
      host = "path";
      path = url;
    }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return `${host.toLowerCase()}/${path}`;
}

/** Directory-safe form of a repo id. */
export function repoDirName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `${safe}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

export function memoryPath(factoryHome: string, repoId: string): string {
  return join(factoryHome, "memory", repoDirName(repoId), "findings.json");
}

export function loadMemory(factoryHome: string, repoId: string): MemoryFile {
  const path = memoryPath(factoryHome, repoId);
  if (!existsSync(path)) return { version: 1, repo: repoId, entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const parsed = MemoryFileSchema.safeParse(raw);
  // A broken file is kept aside rather than silently overwritten.
  if (!parsed.success) {
    renameSync(path, `${path}.broken-${Date.now()}`);
    return { version: 1, repo: repoId, entries: [] };
  }
  return parsed.data;
}

/** Stable key of a finding across runs: reviewer, file and normalized claim (lines move). */
export function memoryKey(f: Pick<TrackedFinding, "reviewer" | "file" | "claim">): string {
  return createHash("sha256").update(`${f.reviewer}\n${f.file}\n${normalizeClaim(f.claim)}`).digest("hex").slice(0, 16);
}

export interface Observation {
  key: string;
  text: string;
  reviewer: string;
  checkable: MemoryEntry["checkable"];
  check_sketch: string;
}

/** Open non-nit findings at exit plus flaky checks, as memory observations. */
export function observations(findings: TrackedFinding[], flakyChecks: string[]): Observation[] {
  const out: Observation[] = findings
    .filter((f) => f.status === "open" && f.severity !== "nit")
    .map((f) => ({
      key: memoryKey(f),
      text: `${f.claim}${f.file ? ` (${f.file})` : ""}`,
      reviewer: f.reviewer,
      checkable: f.checkable,
      check_sketch: f.check_sketch,
    }));
  for (const name of flakyChecks) {
    out.push({ key: `flaky:${name}`, text: `check "${name}" was flaky (red, then green on re-run)`, reviewer: "gates", checkable: "test", check_sketch: "" });
  }
  return out;
}

function withLock<T>(path: string, fn: () => T): T {
  mkdirSync(join(path, ".."), { recursive: true });
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock older than 30 s belongs to a crashed writer.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 30_000 || Date.now() - started > 10_000) rmSync(lock, { force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Upserts this run's observations by key (locked, atomic). A run counts once per entry, so a resumed
 * run does not inflate counts. A `resolved` entry seen again is reopened.
 */
export function flushMemory(opts: { factoryHome: string; repoId: string; runId: string; now: Date; observations: Observation[] }): MemoryFile {
  const path = memoryPath(opts.factoryHome, opts.repoId);
  return withLock(path, () => {
    const mem = loadMemory(opts.factoryHome, opts.repoId);
    const ts = opts.now.toISOString();
    const byKey = new Map(mem.entries.map((e) => [e.key, e]));
    for (const o of opts.observations) {
      const e = byKey.get(o.key);
      if (!e) {
        const entry: MemoryEntry = { ...o, count: 1, first_seen: ts, last_seen: ts, runs: [opts.runId], status: "open", ref: null };
        mem.entries.push(entry);
        byKey.set(o.key, entry);
        continue;
      }
      e.last_seen = ts;
      if (!e.runs.includes(opts.runId)) {
        e.count += 1;
        e.runs = [...e.runs, opts.runId].slice(-MAX_RUNS);
      }
      if (e.status === "resolved") e.status = "open";
      if (o.check_sketch && !e.check_sketch) e.check_sketch = o.check_sketch;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(mem, null, 2) + "\n");
    renameSync(tmp, path);
    return mem;
  });
}

/** Top open entries (most frequent, then most recent) for the implement and review prompts. */
export function briefing(mem: MemoryFile, n = BRIEFING_SIZE): string {
  const top = mem.entries
    .filter((e) => e.status === "open")
    .sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen))
    .slice(0, n);
  return top.map((e) => `- (${e.reviewer}, seen ${e.count}×) ${e.text}`).join("\n");
}
