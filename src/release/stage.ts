import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { NODE_ENGINE } from "../node-runtime.js";
import { candidateDir, candidateExists, candidateId, DATA_VERSIONS, readCandidate, releasesDir, treeDigest, writeCandidate, type Candidate, type Reads, type Writes } from "./state.js";

/**
 * Staging a release candidate (#187): a version-pinned, tested, immutable tree under
 * `$FACTORY_HOME/releases/candidates/<id>`, built outside the executing installation.
 *
 * Staging never activates anything and never writes into a live `dist/`. The digest of the built tree
 * is recorded and the tree is sealed read-only, so activation can prove that what runs is the
 * artifact that was tested and approved.
 */

export interface StageCheck {
  name: string;
  run: (dir: string) => void | Promise<void>;
}

export interface StageOptions {
  home: string;
  /** Full commit this candidate was built from. A short sha or a branch name is not a pin. */
  commit: string;
  /** Package version. Read from the built tree's `package.json` when omitted. */
  version?: string;
  /** Tag or branch the operator named; reported, never re-resolved. */
  ref?: string;
  /** Fills the candidate directory (copy or build of `commit`), never the executing install. */
  install: (dir: string) => void | Promise<void>;
  /** Checks (build, test, smoke) that must pass over this exact tree before it can be activated. */
  checks?: StageCheck[];
  /** Durable state this release can read; defaults to what this code reads. */
  reads?: Partial<Reads>;
  /** Durable state this release writes; defaults to what this code writes. */
  writes?: Partial<Writes>;
  now?: () => number;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

function readPackage(dir: string): { version?: string; node_engine?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string; engines?: { node?: string } };
    return { version: pkg.version, node_engine: pkg.engines?.node };
  } catch {
    return {};
  }
}

/** Sealed: the owner cannot write into the staged tree without reopening it deliberately. */
function seal(dir: string): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) seal(abs);
    else chmodSync(abs, 0o444);
  }
  chmodSync(dir, 0o555);
}

export async function stageCandidate(opts: StageOptions): Promise<Candidate> {
  if (!FULL_SHA.test(opts.commit)) throw new Error(`a candidate is pinned to a full commit (40 hex chars), got "${opts.commit}"`);
  mkdirSync(releasesDir(opts.home), { recursive: true });
  const staging = join(releasesDir(opts.home), `.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(staging, { recursive: true });
  try {
    await opts.install(staging);
    const version = opts.version ?? readPackage(staging).version;
    if (!version) throw new Error("the built tree names no package version and none was given");
    const id = candidateId(version, opts.commit);
    if (candidateExists(opts.home, id)) throw new Error(`candidate ${id} is already staged (immutable: build a new commit)`);

    const passed: string[] = [];
    for (const check of opts.checks ?? []) {
      try {
        await check.run(staging);
      } catch (e) {
        throw new Error(`candidate ${id} is not activatable: check "${check.name}" failed: ${(e as Error).message}`, { cause: e });
      }
      passed.push(check.name);
    }

    const dir = candidateDir(opts.home, id);
    mkdirSync(join(dir, ".."), { recursive: true });
    renameSync(staging, dir);
    const digest = treeDigest(dir);
    seal(dir);
    const candidate: Candidate = {
      id,
      version,
      commit: opts.commit,
      ...(opts.ref ? { ref: opts.ref } : {}),
      staged_at: new Date(opts.now?.() ?? Date.now()).toISOString(),
      checks_passed: passed,
      tested: passed.length > 0,
      digest,
      reads: { queue: [...DATA_VERSIONS.reads.queue], run_state: [...DATA_VERSIONS.reads.run_state], plan: [...DATA_VERSIONS.reads.plan], ...(opts.reads ?? {}) },
      writes: { ...DATA_VERSIONS.writes, ...(opts.writes ?? {}) },
      node_engine: readPackage(dir).node_engine ?? NODE_ENGINE,
    };
    return writeCandidate(opts.home, candidate);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Recomputes the tree digest. A missing or changed tree is never the tested artifact. */
export function verifyArtifact(home: string, id: string): { ok: true; digest: string } | { ok: false; reason: string } {
  const candidate = readCandidate(home, id);
  if (!candidate) return { ok: false, reason: `candidate ${id} is not staged` };
  const dir = candidateDir(home, id);
  if (!existsSync(dir)) return { ok: false, reason: `candidate ${id} has no build tree at ${dir}` };
  const digest = treeDigest(dir);
  if (digest !== candidate.digest) {
    return { ok: false, reason: `candidate ${id} changed after it was staged (tree digest ${digest.slice(0, 12)}, expected ${candidate.digest.slice(0, 12)})` };
  }
  return { ok: true, digest };
}

/** Permission to activate this exact artifact. Publishing a build is not that permission. */
export function approveCandidate(home: string, id: string): Candidate {
  const candidate = readCandidate(home, id);
  if (!candidate) throw new Error(`candidate ${id} is not staged`);
  if (!candidate.tested) throw new Error(`candidate ${id} is not tested: no check ran over this build`);
  const check = verifyArtifact(home, id);
  if (!check.ok) throw new Error(check.reason);
  return writeCandidate(home, { ...candidate, approval: { at: new Date().toISOString(), digest: candidate.digest } });
}
