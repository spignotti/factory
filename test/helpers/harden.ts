import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CiRun } from "../../src/gh.js";
import type { Plan } from "../../src/schemas/plan.js";
import { updateMemory, type MemoryEntry } from "../../src/memory.js";

export function entry(key: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { key, text: `finding ${key}`, reviewer: "plan", checkable: "no", check_sketch: "", count: 1, first_seen: "2026-10-01T00:00:00.000Z", last_seen: "2026-10-20T00:00:00.000Z", runs: [`r-${key}`], status: "open", ref: null, ...over };
}

export function seedMemory(home: string, repoId: string, entries: MemoryEntry[]): void {
  updateMemory(home, repoId, (m) => {
    m.entries = entries;
  });
}

/** A finished run directory as `listRuns` reads it (UTC run id from `at`). */
export function seedRun(home: string, repo: string, at: Date, opts: { pr?: string | null; plan?: Record<string, unknown>; result?: string; rounds?: number }): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const runId = `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = join(home, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, run_id: runId, repo }));
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      run_id: runId, repo, task: "t", type: "chore", lane: "standard", result: opts.result ?? "done", risk: "low", merge_policy: "human_review",
      pr: opts.pr ?? null, rounds: opts.rounds ?? 1, minutes: 5, cost_usd: 0.1, reason: "", branch: null, worktree: null, run_dir: dir,
    }),
  );
  if (opts.plan) writeFileSync(join(dir, "plan.json"), JSON.stringify(opts.plan));
  return runId;
}

let id = 1;
export function ciRun(sha: string, created: string, jobs: [string, string, number][], workflow = "factory"): CiRun {
  return { id: id++, sha, workflow, event: "pull_request", conclusion: jobs.some((j) => j[1] === "failure") ? "failure" : "success", created_at: created, jobs: jobs.map(([name, conclusion, seconds]) => ({ name, conclusion, seconds })) };
}

export const PLAN = (goal: string, resolves: string[] = []): Plan => ({
  version: 1,
  type: "chore",
  goal,
  context: "",
  packages: [{ id: "P1", title: "check", description: "add the check", files: ["scripts/check.sh"], depends_on: [], changes_flows: [] }],
  acceptance: [{ id: "A1", package: "P1", text: "the check fails on the pattern", verify: "check", kind: "behavior", risk: false }],
  out_of_scope: [],
  resolves_findings: resolves,
});
