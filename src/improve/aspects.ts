import type { GitHub } from "../gh.js";
import { baseRef, revParse } from "../git.js";
import { appendMetrics, computeMetrics, latestMetrics } from "../harden/metrics.js";
import {
  checklistSignals,
  ciAudit,
  factoryPrNumbers,
  findingSignals,
  reverts,
  stubText,
  WINDOW_DAYS,
} from "../harden/signals.js";
import { loadMemory, type MemoryFile } from "../memory.js";
import type { RunRecord } from "../runs.js";
import type { ProfileRole } from "../schemas/profile.js";
import type { Metrics } from "../schemas/proposal.js";
import { type ImproveAspect, type RepoConfig } from "../schemas/repo.js";
import { statsReport } from "../commands/stats.js";
import { CI_RUN_LIMIT, FACTORY_REPO } from "../commands/harden.js";

/**
 * One entry per aspect. A follow-up (`ci`, `tests`) is a signal function, `roles/improve-<aspect>.md`,
 * a value on `IMPROVE_ASPECTS`, and a line here. `role` is an existing profile role (the model chain);
 * the prompt file is independent, so the addition does not need a new profile role.
 */
export const ASPECTS: Record<ImproveAspect, { role: ProfileRole; prompt: string }> = {
  findings: { role: "harden", prompt: "improve-findings" },
  security: { role: "audit_security", prompt: "improve-security" },
  performance: { role: "audit_performance", prompt: "improve-performance" },
  structure: { role: "audit_refactor", prompt: "improve-structure" },
};

export interface AspectInput {
  signals: Record<string, unknown>;
  /** Memory keys a plan may name, including findings already on an open proposal of this aspect. */
  keys: Set<string>;
  /** When set, a returned checklist item must be one of these (findings / unmarked standards). */
  checklist?: Set<string>;
  /** False: nothing to act on, so the model is not called. */
  worth: boolean;
  metrics: Metrics | null;
}

export interface AspectContext {
  repoDir: string;
  repo: RepoConfig;
  factoryHome: string;
  repoId: string;
  now: Date;
  github: GitHub;
  runs: RunRecord[];
  /** Findings already named by an open proposal or issue of this aspect (a refresh, not a new key). */
  refresh: string[];
}

function openFindings(mem: MemoryFile) {
  return mem.entries
    .filter((e) => e.status === "open")
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((e) => ({ key: e.key, text: e.text, reviewer: e.reviewer, count: e.count, checkable: e.checkable, check_sketch: e.check_sketch }));
}

function refreshEntries(mem: MemoryFile, refresh: string[]) {
  const want = new Set(refresh);
  return mem.entries.filter((e) => want.has(e.key)).map((e) => ({ key: e.key, text: e.text, status: e.status }));
}

/** Signals the aspect's prompt sees. Findings also appends a metrics line (CI minutes stay unset; that aspect is later). */
export async function collectAspect(aspect: ImproveAspect, ctx: AspectContext): Promise<AspectInput> {
  const mem = loadMemory(ctx.factoryHome, ctx.repoId);
  const refresh = refreshEntries(mem, ctx.refresh);
  if (aspect === "findings") return collectFindings(ctx, mem, refresh);
  const findings = openFindings(mem);
  const metrics = latestMetrics(ctx.factoryHome, ctx.repoId);
  const signals: Record<string, unknown> = { findings, metrics, refresh_findings: refresh };
  if (aspect === "performance") {
    const since = new Date(ctx.now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    try {
      const [ciRuns, latest] = await Promise.all([
        ctx.github.ciRuns(ctx.repoDir, since, CI_RUN_LIMIT),
        ctx.github.latestTag(ctx.repoDir, FACTORY_REPO).catch(() => null),
      ]);
      signals.ci = ciAudit(ciRuns, ctx.repo, stubText(ctx.repoDir), latest);
    } catch (e) {
      signals.ci = { error: (e as Error).message.split("\n")[0]!.slice(0, 200) };
    }
  }
  return {
    signals,
    keys: new Set([...findings.map((f) => f.key), ...ctx.refresh]),
    worth: true,
    metrics,
  };
}

async function collectFindings(ctx: AspectContext, mem: MemoryFile, refresh: { key: string; text: string; status: string }[]): Promise<AspectInput> {
  const since = new Date(ctx.now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const base = await revParse(ctx.repoDir, await baseRef(ctx.repoDir, ctx.repo.base_branch));
  const windowRuns = ctx.runs.filter((r) => r.started_at.toISOString() >= since);
  const prs = factoryPrNumbers(windowRuns);
  const findings = findingSignals(mem);
  const unmarked = checklistSignals(ctx.repoDir, ctx.repo);
  const period = statsReport({ factoryHome: ctx.factoryHome, since: `${WINDOW_DAYS}d`, repo: ctx.repoDir, now: () => ctx.now.getTime() }).current;
  const reverted = await reverts(ctx.repoDir, base, since, prs);
  const signals = {
    findings,
    flaky_checks: period.flaky_checks,
    unmarked_standards: unmarked,
    reverts: reverted,
    refresh_findings: refresh,
  };
  const metrics = computeMetrics({
    ts: ctx.now.toISOString(),
    repoId: ctx.repoId,
    repo: ctx.repo,
    mem,
    signals: {
      findings,
      checklist: unmarked,
      ci: { error: "ci is a separate aspect" },
      runs: {
        runs: period.runs,
        by_result: period.by_result,
        done_rate: period.done_rate,
        rounds: period.rounds,
        gate_failures: period.gate_failures,
        flaky_checks: period.flaky_checks,
        reasons: period.reasons,
        lane_escalations: period.lane_escalations,
      },
      evaluator: [],
      stale_guides: [],
      reverts: reverted,
    },
    factoryPrs: prs.size,
  });
  appendMetrics(ctx.factoryHome, ctx.repoId, metrics);
  const worth = findings.length > 0 || unmarked.length > 0 || reverted.length > 0 || Object.keys(period.flaky_checks ?? {}).length > 0 || refresh.length > 0;
  return {
    signals,
    keys: new Set([...findings.map((f) => f.key), ...ctx.refresh]),
    checklist: new Set(unmarked),
    worth,
    metrics,
  };
}
