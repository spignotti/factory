import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redact } from "../events.js";
import { sh, type ShResult } from "../exec.js";
import type { BuiltinResult } from "../gates/builtin.js";
import type { Toolchains } from "../toolchains.js";
import { isNpmProject, isPnpmProject, isPythonProject, semgrepRulesDir } from "./spec.js";

/**
 * Fast and full security gates. Trivy image scans and hadolint stay in CI: they need an image
 * build or a Dockerfile lint that the run does not have.
 *
 * The commands are not jailed. The shipped semgrep rules live in the factory install, which the
 * sandbox does not bind, and these scanners do not execute repository code (repo semgrep rules
 * stay in CI). They get PATH and HOME, not the repo's secrets. A missing binary is a skip whose
 * detail starts with `SKIPPED` (listed on the run result). `baseline.require_tools` makes it fail.
 */

const fail = (name: string, detail: string): BuiltinResult => ({ name, ok: false, detail });
const pass = (name: string, detail: string): BuiltinResult => ({ name, ok: true, detail });

export interface PlannedGate {
  name: string;
  bin: string;
  /** Empty when `passDetail` is set: the gate is a pass and the command is not run. */
  command: string;
  /** Set when there is nothing to scan. The binary is not required. */
  passDetail?: string;
}

const SKIP_SCAN = /(?:^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|Cargo\.lock)$|\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;

/** Semgrep with no remaining targets. Not a whole-repo scan. */
const NO_SCAN = "no scan needed";

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Changed paths a file-list scanner may be given (semgrep, and the same list if a later gate
 * such as shellcheck, hadolint or ruff points at files). Deletions and the old path of a rename
 * are not in the worktree; semgrep exits 2 ("Invalid scanning root") when one is passed.
 * Absolute paths and `..` are dropped so a path cannot escape the worktree.
 */
export function existingScanPaths(dir: string, changed: string[]): string[] {
  const root = resolve(dir);
  const out: string[] = [];
  for (const file of changed) {
    if (!file || file.includes("\0") || file.includes("\n") || isAbsolute(file)) continue;
    if (file.split("/").some((segment) => segment === "..")) continue;
    const abs = resolve(root, file);
    const rel = relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (!existsSync(abs)) continue;
    out.push(file);
  }
  return out;
}

function semgrepPaths(dir: string, changed: string[]): string[] {
  const paths = existingScanPaths(dir, changed).filter((f) => !SKIP_SCAN.test(f));
  // Above 200 paths the argument list scans the worktree root. An empty list must not:
  // `.` would scan every file, including ones the diff never touched.
  return paths.length > 200 ? ["."] : paths;
}

/**
 * Which baseline gates a tier runs, and the exact command. Semgrep points at the shipped rules
 * (`--metrics=off`, no registry id) so the scan works offline.
 */
export function planBaselineGates(input: {
  tier: "fast" | "full";
  changed: string[];
  baseSha: string;
  dir: string;
  toolchains: Pick<Toolchains, "python" | "uv" | "pnpm">;
  rulesDir?: string;
}): PlannedGate[] | { error: string } {
  if (!/^[0-9a-f]{7,64}$/i.test(input.baseSha)) return { error: "base revision is not a git sha" };
  const rules = input.rulesDir ?? semgrepRulesDir();
  const planned: PlannedGate[] = [
    {
      name: "gitleaks",
      bin: "gitleaks",
      command: `gitleaks detect --source . --log-opts=${quote(`${input.baseSha}..HEAD`)} --redact --no-banner`,
    },
  ];
  const paths = semgrepPaths(input.dir, input.changed);
  planned.push(
    paths.length
      ? {
          name: "semgrep",
          bin: "semgrep",
          command: `semgrep scan --metrics=off --error --disable-version-check --quiet --config ${quote(rules)} ${paths.map(quote).join(" ")}`,
        }
      : { name: "semgrep", bin: "semgrep", command: "", passDetail: NO_SCAN },
  );
  if (input.tier === "fast") return planned;
  if (isPythonProject(input.dir, input.toolchains)) {
    planned.push({ name: "pip-audit", bin: "pip-audit", command: "pip-audit --progress-spinner off" });
  }
  if (isPnpmProject(input.dir, input.toolchains)) {
    planned.push({ name: "pnpm-audit", bin: "pnpm", command: "pnpm audit --audit-level high" });
  } else if (isNpmProject(input.dir, false)) {
    planned.push({ name: "npm-audit", bin: "npm", command: "npm audit --audit-level=high" });
  }
  const workflows = input.changed.some((f) => f.startsWith(".github/workflows/") || f.startsWith(".github/actions/"));
  if (workflows) {
    planned.push({ name: "actionlint", bin: "actionlint", command: "actionlint" });
    planned.push({ name: "zizmor", bin: "zizmor", command: "zizmor --offline --format plain .github/workflows" });
  }
  return planned;
}

function scannerEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", SEMGREP_SEND_METRICS: "off" };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function defaultBinExists(bin: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._+-]+$/.test(bin)) return false;
  const found = await sh(`command -v ${bin}`, { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
  return found.code === 0 && found.output.trim().length > 0;
}

/** Runs the planned gates. `run` and `binExists` are injectable so tests never spawn the real tools. */
export async function runBaselineGates(opts: {
  cwd: string;
  tier: "fast" | "full";
  changed: string[];
  baseSha: string;
  toolchains: Pick<Toolchains, "python" | "uv" | "pnpm">;
  timeoutMs: number;
  secrets?: string[];
  rulesDir?: string;
  /** Missing binary fails the gate. Default: a pass whose detail starts with `SKIPPED`. */
  requireTools?: boolean;
  run?: (command: string) => Promise<ShResult>;
  binExists?: (bin: string) => Promise<boolean>;
}): Promise<BuiltinResult[]> {
  const planned = planBaselineGates({
    tier: opts.tier,
    changed: opts.changed,
    baseSha: opts.baseSha,
    dir: opts.cwd,
    toolchains: opts.toolchains,
    rulesDir: opts.rulesDir,
  });
  if ("error" in planned) return [fail("gitleaks", planned.error)];
  const run = opts.run ?? ((command: string) => sh(command, { cwd: opts.cwd, env: scannerEnv(), timeoutMs: opts.timeoutMs }));
  const binExists = opts.binExists ?? defaultBinExists;
  const out: BuiltinResult[] = [];
  for (const gate of planned) {
    if (gate.passDetail) {
      out.push(pass(gate.name, gate.passDetail));
      continue;
    }
    if (!(await binExists(gate.bin))) {
      const detail = `SKIPPED ${gate.bin} is not on PATH (factory doctor warns; nothing was scanned)`;
      out.push(opts.requireTools ? fail(gate.name, `${detail}; baseline.require_tools is on`) : pass(gate.name, detail));
      continue;
    }
    const result = await run(gate.command);
    const detail = redact(result.output.trim(), opts.secrets ?? []).slice(-2000);
    if (result.output.includes("[factory] timed out after ")) {
      out.push(fail(gate.name, detail || "timed out"));
      continue;
    }
    out.push(result.code === 0 ? pass(gate.name, detail) : fail(gate.name, detail || `exit ${result.code}`));
  }
  return out;
}
