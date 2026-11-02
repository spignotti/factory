import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

/** Documented fallback when node is not on PATH (e.g. after /usr/local was wiped on restore). */
export const FACTORY_NODE_FALLBACK = join(homedir(), ".local/share/factory-node/bin/node");

export type NodeSource = "FACTORY_NODE" | "PATH" | "fallback";

export interface ResolvedNode {
  path: string;
  version: string;
  source: NodeSource;
}

const pkg = JSON.parse(readFileSync(req.resolve("../package.json"), "utf8")) as { engines?: { node?: string } };
/** Required range from package.json `engines.node` (same floor CI uses). */
export const NODE_ENGINE = pkg.engines?.node ?? ">=22.19.0";

export const NODE_FIX_HINT = `set FACTORY_NODE, put node on PATH, or install to ${FACTORY_NODE_FALLBACK}`;

interface NodeTriple {
  major: number;
  minor: number;
  patch: number;
}

/** Parses `v22.19.0` / `22.19.0`; returns null when not a semver-like release. */
export function parseNodeVersion(raw: string): NodeTriple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a: NodeTriple, b: NodeTriple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Supports the factory's `>=x.y.z` engine field only. */
export function satisfiesNodeEngine(version: string, engine: string = NODE_ENGINE): boolean {
  const v = parseNodeVersion(version);
  if (!v) return false;
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(engine.trim());
  if (!m) return false;
  const floor: NodeTriple = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  return cmp(v, floor) >= 0;
}

export interface ResolveNodeOptions {
  env?: NodeJS.ProcessEnv;
  fallback?: string;
  exists?: (p: string) => boolean;
  versionOf?: (bin: string) => string | undefined;
}

function findOnPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  const pathVar = env.PATH ?? "";
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, name);
    if (exists(cand)) return cand;
  }
  return undefined;
}

function defaultVersionOf(bin: string): string | undefined {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Same resolution order as scripts/resolve-node.sh. */
export function resolveNode(opts: ResolveNodeOptions = {}): ResolvedNode | { error: string } {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const fallback = opts.fallback ?? FACTORY_NODE_FALLBACK;
  const versionOf = opts.versionOf ?? defaultVersionOf;

  let path: string | undefined;
  let source: NodeSource | undefined;

  const explicit = env.FACTORY_NODE?.trim();
  if (explicit && exists(explicit)) {
    path = explicit;
    source = "FACTORY_NODE";
  } else {
    const onPath = findOnPath(env, exists);
    if (onPath) {
      path = onPath;
      source = "PATH";
    } else if (exists(fallback)) {
      path = fallback;
      source = "fallback";
    }
  }

  if (!path || !source) return { error: `node not found: ${NODE_FIX_HINT}` };

  const version = versionOf(path);
  if (!version) return { error: `node at ${path} does not run: ${NODE_FIX_HINT}` };

  return { path, version, source };
}

/** `factory doctor` check: resolved node path, version and engines floor. */
export function nodeCheck(opts: ResolveNodeOptions = {}): { name: "node"; status: "ok" | "fail"; detail: string } {
  const r = resolveNode(opts);
  if ("error" in r) return { name: "node", status: "fail", detail: r.error };
  const via = r.source === "FACTORY_NODE" ? "FACTORY_NODE" : r.source === "PATH" ? "PATH" : "fallback";
  if (!satisfiesNodeEngine(r.version)) {
    return {
      name: "node",
      status: "fail",
      detail: `${r.path} is ${r.version}; factory requires node ${NODE_ENGINE} (${NODE_FIX_HINT})`,
    };
  }
  return { name: "node", status: "ok", detail: `${r.path} (${r.version}, via ${via})` };
}
