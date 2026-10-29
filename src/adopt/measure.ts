import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv, prepareAgentHome } from "../agents/env.js";
import { sh, tail } from "../exec.js";
import { gitCommonDir, type Sandbox } from "../sandbox/sandbox.js";

export interface Measurement {
  name: string;
  /** null: not run (setup failed or measuring was skipped). */
  ok: boolean | null;
  seconds: number | null;
  detail: string;
}

export interface MeasureResult {
  setup: { ok: boolean; seconds: number; detail: string } | null;
  checks: Measurement[];
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

/**
 * Runs setup and every candidate check once in `dir` (a clean base worktree), with the sandbox and env
 * allowlist of a run (SPEC §12 step 1: "run once, with durations"). Never throws for a failing command.
 */
export async function measureChecks(
  dir: string,
  setup: string,
  checks: { name: string; run: string }[],
  opts: { sandbox?: Sandbox; factoryHome: string; timeoutMs?: number; agentEnv?: string[] },
): Promise<MeasureResult> {
  const tmp = mkdtempSync(join(tmpdir(), "factory-adopt-measure-"));
  try {
    const home = prepareAgentHome(tmp);
    const env = buildAgentEnv(process.env, { home, extra: opts.agentEnv ?? [] });
    const common = gitCommonDir(dir);
    const jail = !opts.sandbox || opts.sandbox.mode === "off" ? undefined : { sandbox: opts.sandbox, rw: [dir, home], ro: common ? [common] : [], hide: [opts.factoryHome] };
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    let setupResult: MeasureResult["setup"] = null;
    if (setup) {
      const r = await sh(setup, { cwd: dir, env, jail, timeoutMs });
      setupResult = { ok: r.code === 0, seconds: secs(r.durationMs), detail: r.code === 0 ? "" : tail(r.output, 5) };
      if (r.code !== 0) return { setup: setupResult, checks: checks.map((c) => ({ name: c.name, ok: null, seconds: null, detail: "setup failed" })) };
    }
    const out: Measurement[] = [];
    for (const c of checks) {
      const r = await sh(c.run, { cwd: dir, env, jail, timeoutMs });
      out.push({ name: c.name, ok: r.code === 0, seconds: secs(r.durationMs), detail: r.code === 0 ? "" : tail(r.output, 5) });
    }
    return { setup: setupResult, checks: out };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
