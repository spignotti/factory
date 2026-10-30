import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "./schemas/repo.js";

/**
 * Language toolchains the CI stub installs on a bare runner (ubuntu-latest has node and python3,
 * but neither pnpm nor uv) before `factory gates --run`. The stub is identical in every repo, so
 * what a repo needs is resolved at CI time by `factory gates --toolchains`: repo.yaml
 * `ci.toolchains` when set, otherwise detected from the repo's files.
 */
export interface Toolchains {
  /** setup-node version; never below the factory's own floor, the stub runs the factory with it. */
  node: string;
  pnpm: boolean;
  /** pnpm/action-setup `version`; "" = from package.json `packageManager`. */
  pnpm_version: string;
  /** actions/setup-python `python-version`; "" = no setup-python (runner python3, or uv picks one). */
  python: string;
  uv: boolean;
  /** astral-sh/setup-uv `version`; "" = uv's `required-version` or the latest release. */
  uv_version: string;
}

/** The factory itself needs node >= 22.19; `22` resolves to the latest 22.x on setup-node. */
export const NODE_FLOOR = 22;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._*/+-]{0,39}$/;

const read = (dir: string, f: string): string | undefined => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
const firstLine = (t: string | undefined) => t?.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));

function packageManagerField(dir: string): string | undefined {
  try {
    const pm = (JSON.parse(read(dir, "package.json") ?? "{}") as { packageManager?: unknown }).packageManager;
    return typeof pm === "string" ? pm : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit node versions below the floor are raised to it (with a note): the stub runs the factory on this node. */
function nodeVersion(v: string | undefined, notes: string[], source: string): string {
  if (!v) return String(NODE_FLOOR);
  const major = /^v?(\d+)/.exec(v)?.[1];
  if (major && Number(major) < NODE_FLOOR) {
    notes.push(`${source} asks for node ${v}; CI uses node ${NODE_FLOOR} (the factory needs >= 22.19)`);
    return String(NODE_FLOOR);
  }
  return v.replace(/^v(?=\d)/, "");
}

/** What the repo's files say: lockfiles, `packageManager`, `.nvmrc`/`.node-version`, `.python-version`, `[tool.uv]`. */
export function detectToolchains(dir: string, notes: string[] = []): Toolchains {
  const pm = packageManagerField(dir);
  const pnpm = existsSync(join(dir, "pnpm-lock.yaml")) || pm?.startsWith("pnpm@") === true;
  const pyproject = read(dir, "pyproject.toml") ?? "";
  const uv = existsSync(join(dir, "uv.lock")) || /^\s*\[tool\.uv[.\]]/m.test(pyproject);
  const nodeFile = [".nvmrc", ".node-version"].find((f) => firstLine(read(dir, f)));
  const nodeRaw = nodeFile ? firstLine(read(dir, nodeFile)) : undefined;
  const python = firstLine(read(dir, ".python-version")) ?? "";
  return {
    node: nodeRaw && VERSION.test(nodeRaw) && /^v?\d/.test(nodeRaw) ? nodeVersion(nodeRaw, notes, nodeFile!) : String(NODE_FLOOR),
    pnpm,
    // pnpm/action-setup reads `packageManager` itself and fails when a second version is given.
    pnpm_version: pnpm && !pm?.startsWith("pnpm@") ? "10" : "",
    python: VERSION.test(python) ? python : "",
    uv,
    uv_version: "",
  };
}

/** repo.yaml `ci.toolchains` replaces detection field by field; unset fields stay detected. */
export function resolveToolchains(dir: string, repo: Pick<RepoConfig, "ci">): { toolchains: Toolchains; notes: string[] } {
  const notes: string[] = [];
  const t = detectToolchains(dir, notes);
  const want = repo.ci?.toolchains;
  if (!want) return { toolchains: t, notes };
  if (want.node !== undefined) t.node = nodeVersion(want.node, notes, "ci.toolchains.node");
  if (want.python !== undefined) t.python = want.python === false ? "" : want.python;
  for (const tool of ["pnpm", "uv"] as const) {
    const v = want[tool];
    if (v === undefined) continue;
    t[tool] = v !== false;
    t[`${tool}_version`] = typeof v === "string" ? v : "";
  }
  const pinned = packageManagerField(dir)?.startsWith("pnpm@") === true;
  if (t.pnpm && pinned && t.pnpm_version) {
    notes.push("ci.toolchains.pnpm sets a version but package.json packageManager pins pnpm; the packageManager version is used");
    t.pnpm_version = "";
  }
  if (t.pnpm && !pinned && !t.pnpm_version) t.pnpm_version = "10";
  if (!t.pnpm) t.pnpm_version = "";
  if (!t.uv) t.uv_version = "";
  return { toolchains: t, notes };
}

/** One line for doctor and the adopt PR, e.g. `node 22, pnpm (packageManager), uv`. */
export function describeToolchains(t: Toolchains): string {
  return [
    `node ${t.node}`,
    t.pnpm ? `pnpm ${t.pnpm_version || "(packageManager)"}` : "",
    t.python ? `python ${t.python}` : "",
    t.uv ? `uv${t.uv_version ? ` ${t.uv_version}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
