import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv, prepareAgentHome } from "../agents/env.js";
import { sh, tail } from "../exec.js";
import { git, gitOk } from "../git.js";
import { gitCommonDir, type Sandbox } from "../sandbox/sandbox.js";

export interface Measurement {
  name: string;
  /** null: not run (setup failed or measuring was skipped). */
  ok: boolean | null;
  seconds: number | null;
  detail: string;
  /** Tracked files the check changed (a check must not write); null when not measured or not a git worktree. */
  mutated?: string[] | null;
}

export interface MeasureResult {
  setup: { ok: boolean; seconds: number; detail: string } | null;
  checks: Measurement[];
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

/** State of the tracked files: the diff against HEAD (setup may already have changed some). */
async function trackedState(dir: string): Promise<{ hash: string; files: Set<string>; patch: string } | null> {
  if (!(await gitOk(dir, ["rev-parse", "--verify", "-q", "HEAD"]))) return null;
  const patch = await git(dir, ["diff", "HEAD", "--binary"]);
  const files = new Set((await git(dir, ["diff", "HEAD", "--name-only"])).split("\n").filter(Boolean));
  return { hash: createHash("sha256").update(patch).digest("hex"), files, patch };
}

/** Puts tracked files back to `base` after a check changed them, so the next check sees the base state. */
async function restore(dir: string, base: { patch: string }, tmp: string): Promise<void> {
  await git(dir, ["checkout", "-q", "HEAD", "--", "."]);
  if (base.patch) {
    const file = join(tmp, "base.patch");
    writeFileSync(file, base.patch);
    await gitOk(dir, ["apply", "--binary", file]);
  }
}

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
    const base = await trackedState(dir);
    for (const c of checks) {
      const r = await sh(c.run, { cwd: dir, env, jail, timeoutMs });
      let mutated: string[] | null = null;
      if (base) {
        const after = await trackedState(dir);
        mutated = [];
        if (after && after.hash !== base.hash) {
          const changed = await git(dir, ["diff", "HEAD", "--name-only"]);
          mutated = changed.split("\n").filter((f) => f && !base.files.has(f));
          if (!mutated.length) mutated = [...after.files].slice(0, 20); // a file setup had changed was changed again
          await restore(dir, base, tmp);
        }
      }
      out.push({ name: c.name, ok: r.code === 0, seconds: secs(r.durationMs), detail: r.code === 0 ? "" : tail(r.output, 5), mutated });
    }
    return { setup: setupResult, checks: out };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
