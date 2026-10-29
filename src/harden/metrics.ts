import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryDir, type MemoryFile } from "../memory.js";
import { type Metrics, MetricsSchema } from "../schemas/proposal.js";
import type { RepoConfig } from "../schemas/repo.js";
import type { Signals } from "./signals.js";

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export function computeMetrics(input: { ts: string; repoId: string; repo: RepoConfig; mem: MemoryFile; signals: Signals; factoryPrs: number }): Metrics {
  const checks = input.repo.checks.length;
  const openCheckable = input.mem.entries.filter((e) => e.status === "open" && e.checkable !== "no" && !e.key.startsWith("flaky:")).length;
  const llm = input.signals.checklist.length + openCheckable;
  const ci = "error" in input.signals.ci ? null : input.signals.ci;
  return MetricsSchema.parse({
    ts: input.ts,
    repo: input.repoId,
    determinism_ratio: checks + llm ? round(checks / (checks + llm)) : null,
    deterministic_checks: checks,
    llm_verified_items: llm,
    open_findings: input.mem.entries.filter((e) => e.status === "open").length,
    ci_minutes_per_week: ci ? ci.minutes_per_week : null,
    flaky_rate: ci ? ci.flaky_rate : null,
    done_rate: input.signals.runs.done_rate,
    median_rounds: input.signals.runs.rounds.median,
    revert_rate: input.factoryPrs ? round(input.signals.reverts.length / input.factoryPrs) : null,
  });
}

export function appendMetrics(factoryHome: string, repoId: string, m: Metrics): string {
  const dir = memoryDir(factoryHome, repoId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "metrics.jsonl");
  appendFileSync(path, JSON.stringify(m) + "\n");
  return path;
}
