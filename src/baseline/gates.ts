import { tmpdir } from "node:os";
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
 * stay in CI). They get PATH and HOME, not the repo's secrets. A missing binary is a skip, not a
 * red gate: doctor warns, and a box without the tool can still finish a run.
 */

const fail = (name: string, detail: string): BuiltinResult => ({ name, ok: false, detail });
const pass = (name: string, detail: string): BuiltinResult => ({ name, ok: true, detail });

export interface PlannedGate {
  name: string;
  bin: string;
  command: string;
}

const SKIP_SCAN = /(?:^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|uv\.lock|Cargo\.lock)$|\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function semgrepPaths(changed: string[]): string[] {
  const paths = changed.filter((f) => !SKIP_SCAN.test(f) && !f.includes("\n") && !f.includes("\0"));
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
  const paths = semgrepPaths(input.changed);
  if (paths.length) {
    planned.push({
      name: "semgrep",
      bin: "semgrep",
      command: `semgrep scan --metrics=off --error --disable-version-check --quiet --config ${quote(rules)} ${paths.map(quote).join(" ")}`,
    });
  }
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
    if (!(await binExists(gate.bin))) {
      out.push(pass(gate.name, `skipped: ${gate.bin} is not on PATH (factory doctor warns; nothing was scanned)`));
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
