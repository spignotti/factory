import { resolve } from "node:path";
import { sh } from "../exec.js";
import { baseRef, changedFiles } from "../git.js";
import { selectChecks } from "../gates/select.js";
import { loadRepoConfig, type Tier, TierSchema } from "../schemas/repo.js";
import { type CheckResult, runChecks } from "../steps/gates.js";

export interface GatesOptions {
  repo: string;
  select: boolean;
  run?: string;
  tier: string;
  base?: string;
  json: boolean;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/**
 * `factory gates --select | --run <check|selected>`: the same selection as the pipeline, for local use and CI.
 * Checks run with the caller's environment (CI or the user), not the agent allowlist.
 */
export async function gatesCommand(opts: GatesOptions, io: Io): Promise<number> {
  const repoDir = resolve(opts.repo);
  const repo = loadRepoConfig(repoDir);
  const tier: Tier = TierSchema.parse(opts.tier);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

  const selected = async () => {
    const base = opts.base ?? (await baseRef(repoDir, repo.base_branch));
    return selectChecks(repo.checks, tier, await changedFiles(repoDir, base));
  };

  if (opts.select) {
    const names = (await selected()).map((c) => c.name);
    io.out(opts.json ? JSON.stringify(names) + "\n" : names.map((n) => n + "\n").join(""));
    return 0;
  }
  if (!opts.run) {
    io.err("gates: one of --select or --run <check|selected> is required\n");
    return 2;
  }
  const checks = opts.run === "selected" ? await selected() : repo.checks.filter((c) => c.name === opts.run);
  if (checks.length === 0 && opts.run !== "selected") {
    io.err(`gates: unknown check ${opts.run}\n`);
    return 2;
  }
  if (repo.setup) {
    const setup = await sh(repo.setup, { cwd: repoDir, env });
    if (setup.code !== 0) {
      io.err(`gates: setup failed\n${setup.output}`);
      return 1;
    }
  }
  const results: CheckResult[] = await runChecks(checks, { cwd: repoDir, env, envCommand: repo.env_command });
  const green = results.every((r) => r.status !== "fail");
  if (opts.json) io.out(JSON.stringify({ green, checks: results }) + "\n");
  else for (const r of results) io.out(`${r.status.padEnd(5)} ${r.name}${r.output_tail ? "\n" + r.output_tail : ""}\n`);
  return green ? 0 : 1;
}
