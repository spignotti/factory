import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResultSchema, type RunResult } from "../events.js";
import { newRunId } from "../pipeline/run.js";
import { listRuns, type RunRecord } from "../runs.js";
import type { StartedRun, StartRunRequest } from "./worker.js";

/** `dist/cli.js` next to this module when the built CLI runs; the built file when tests import the source. */
export function factoryCliScript(): string {
  const nextTo = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(nextTo)) return nextTo;
  const built = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  if (existsSync(built)) return built;
  throw new Error(`factory CLI not found at ${nextTo} (run pnpm build)`);
}

/** Args for the detached `factory run`. The run id is on the command line so `ps -o command=` can match a restarted worker's pid. */
export function factoryRunArgs(script: string, req: { repo: string; issue: number; runId: string }): string[] {
  return [script, "run", "--repo", req.repo, "--issue", String(req.issue), "--no-notify", "--run-id", req.runId];
}

/** Args for a detached `factory resume`. `--no-notify` matches `factory run` from the queue. */
export function factoryResumeArgs(script: string, runId: string): string[] {
  return [script, "resume", runId, "--no-notify"];
}

/**
 * Real `queue run` child: `node dist/cli.js run --issue N --no-notify --run-id <id>`.
 * Detached, stdio ignored, so the worker can exit (restart, Ctrl-C) without closing the child's pipes
 * and the run keeps its lock. The next worker adopts it. Outcome is `result.json`, not stdout.
 */
export function spawnFactoryRun(req: StartRunRequest): StartedRun {
  if (req.resumeRunId) return spawnResume(req);
  const prior = new Set(issueRuns(req.factoryHome, req.repo, req.issue).map((r) => r.run_id));
  const plannedId = req.runId ?? newRunId(Date.now());
  const child = spawn(process.execPath, factoryRunArgs(factoryCliScript(), { repo: req.repo, issue: req.issue, runId: plannedId }), {
    cwd: req.repo,
    env: { ...process.env, FACTORY_HOME: req.factoryHome },
    stdio: "ignore",
    detached: true,
  });
  let runId: string | undefined = plannedId;
  const done = new Promise<RunResult>((resolveResult, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      const parsed = readNewResult(req.factoryHome, req.repo, req.issue, prior);
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
    runId: () => runId,
    kill: (signal = "SIGTERM") => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          process.kill(child.pid, signal);
        } catch {
          // already gone
        }
      }
    },
    unref: () => child.unref(),
  };
}

function spawnResume(req: StartRunRequest): StartedRun {
  const runId = req.resumeRunId ?? "";
  const child = spawn(process.execPath, factoryResumeArgs(factoryCliScript(), runId), {
    cwd: req.repo,
    env: { ...process.env, FACTORY_HOME: req.factoryHome },
    stdio: "ignore",
    detached: true,
  });
  const done = new Promise<RunResult>((resolveResult, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      const parsed = readResult(req.factoryHome, runId);
      if (parsed) resolveResult(parsed);
      else reject(err ?? new Error(`resume ${runId} ended without result.json`));
    };
    child.on("error", (e) => finish(e));
    child.on("close", () => finish());
  });
  return { done, pid: child.pid ?? 0, runId: () => runId, kill: signalChild(child.pid), unref: () => child.unref() };
}

function signalChild(pid: number | undefined): (signal?: NodeJS.Signals) => void {
  return (signal = "SIGTERM") => {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  };
}

function readResult(factoryHome: string, runId: string): RunResult | undefined {
  const run = listRuns(factoryHome).find((r) => r.run_id === runId);
  const parsed = ResultSchema.safeParse(run?.result);
  return parsed.success ? parsed.data : undefined;
}

function readNewResult(factoryHome: string, repo: string, issue: number, prior: Set<string>): RunResult | undefined {
  const mine = issueRuns(factoryHome, repo, issue).filter((r) => !prior.has(r.run_id) && r.result);
  const parsed = ResultSchema.safeParse(mine.at(-1)?.result);
  return parsed.success ? parsed.data : undefined;
}

function issueRuns(factoryHome: string, repo: string, issue: number): RunRecord[] {
  return listRuns(factoryHome).filter((r) => (r.state?.task.issue === issue || r.result?.task === `#${issue}`) && sameRepo(r.state?.repo ?? r.result?.repo, repo));
}

function sameRepo(a: string | undefined, b: string): boolean {
  return a !== undefined && resolve(a) === resolve(b);
}
