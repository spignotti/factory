import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResultSchema, type RunResult } from "../events.js";
import { listRuns } from "../runs.js";
import type { StartedRun } from "./worker.js";

/** `dist/cli.js` next to this module when the built CLI runs; the built file when tests import the source. */
export function factoryCliScript(): string {
  const nextTo = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(nextTo)) return nextTo;
  const built = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  if (existsSync(built)) return built;
  throw new Error(`factory CLI not found at ${nextTo} (run pnpm build)`);
}

/**
 * Real `queue run` child: `node dist/cli.js run --issue N --no-notify`.
 * Detached so the worker can exit (restart, Ctrl-C) and the run keeps its lock. The next worker adopts it.
 */
export function spawnFactoryRun(req: { repo: string; issue: number; factoryHome: string }): StartedRun {
  const child = spawn(process.execPath, [factoryCliScript(), "run", "--repo", req.repo, "--issue", String(req.issue), "--no-notify"], {
    cwd: req.repo,
    env: { ...process.env, FACTORY_HOME: req.factoryHome },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
    if (out.length > 1_000_000) out = out.slice(-200_000);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    if (line) process.stderr.write(line);
  });
  let runId: string | undefined;
  const done = new Promise<RunResult>((resolveResult, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      const parsed = parseStdout(out) ?? readIssueResult(req.factoryHome, req.repo, req.issue);
      if (parsed) {
        runId = parsed.run_id;
        resolveResult(parsed);
        return;
      }
      reject(err ?? new Error(`run for #${req.issue} ended without result.json`));
    };
    child.on("error", (e) => finish(e));
    child.on("close", () => finish());
  });
  return {
    done,
    pid: child.pid ?? 0,
    runId: () => runId ?? discoverRunId(req.factoryHome, req.repo, req.issue),
    kill: (signal = "SIGTERM") => {
      if (!child.pid) return;
      try {
        process.kill(child.pid, signal);
      } catch {
        // already gone
      }
    },
    unref: () => detach(child),
  };
}

function detach(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function parseStdout(text: string): RunResult | undefined {
  for (const line of text.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed = ResultSchema.safeParse(JSON.parse(t));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function discoverRunId(factoryHome: string, repo: string, issue: number): string | undefined {
  const matches = listRuns(factoryHome).filter((r) => r.state?.task.issue === issue && sameRepo(r.state?.repo ?? r.result?.repo, repo) && !r.result);
  return matches.at(-1)?.run_id;
}

function readIssueResult(factoryHome: string, repo: string, issue: number): RunResult | undefined {
  const matches = listRuns(factoryHome).filter((r) => r.state?.task.issue === issue && sameRepo(r.state?.repo ?? r.result?.repo, repo) && r.result);
  const parsed = ResultSchema.safeParse(matches.at(-1)?.result);
  return parsed.success ? parsed.data : undefined;
}

function sameRepo(a: string | undefined, b: string): boolean {
  return a !== undefined && resolve(a) === resolve(b);
}
