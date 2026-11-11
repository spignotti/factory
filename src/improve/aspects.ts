import type { CiRun, GitHub } from "../gh.js";
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
import { ciSignals, ciWorth, readCiWorkflows } from "./ci-signals.js";
import { collectTestSignals, testWorth } from "./test-signals.js";

/**
 * One entry per aspect. `role` is an existing profile role (the model chain); the prompt file is
 * independent, so an aspect does not need a new profile role.
 */
export const ASPECTS: Record<ImproveAspect, { role: ProfileRole; prompt: string }> = {
  findings: { role: "harden", prompt: "improve-findings" },
  security: { role: "audit_security", prompt: "improve-security" },
  performance: { role: "audit_performance", prompt: "improve-performance" },
  structure: { role: "audit_refactor", prompt: "improve-structure" },
  ci: { role: "audit_performance", prompt: "improve-ci" },
  tests: { role: "harden", prompt: "improve-tests" },
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
  /** `improve --dry-run`: do not call GitHub. */
  dryRun?: boolean;
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

function clip(e: unknown): string {
  return ((e as Error).message || String(e)).split("\n")[0]!.slice(0, 200);
}

function windowSince(now: Date): string {
  return new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
}

export async function collectAspect(aspect: ImproveAspect, ctx: AspectContext): Promise<AspectInput> {
  const mem = loadMemory(ctx.factoryHome, ctx.repoId);
  const refresh = refreshEntries(mem, ctx.refresh);
  if (aspect === "findings") return collectFindings(ctx, mem, refresh);
  if (aspect === "ci") return collectCi(ctx);
  if (aspect === "tests") return collectTests(ctx, mem, refresh);
  const findings = openFindings(mem);
  const metrics = latestMetrics(ctx.factoryHome, ctx.repoId);
  const signals: Record<string, unknown> = { findings, metrics, refresh_findings: refresh };
  if (aspect === "performance") {
    if (ctx.dryRun) {
      signals.ci = { error: "dry-run: no gh calls" };
    } else {
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
  }
  return {
    signals,
    keys: new Set([...findings.map((f) => f.key), ...ctx.refresh]),
    worth: true,
    metrics,
  };
}

async function collectCi(ctx: AspectContext): Promise<AspectInput> {
  if (ctx.dryRun) return { signals: { error: "dry-run: no gh calls" }, keys: new Set(ctx.refresh), worth: false, metrics: null };
  const since = windowSince(ctx.now);
  let window: { runs: CiRun[]; truncated: boolean };
  try {
    window = await ctx.github.ciRunsInWindow(ctx.repoDir, since);
  } catch (e) {
    throw new Error(`ci runs: ${clip(e)}`, { cause: e });
  }
  const signal = ciSignals({ runs: window.runs, truncated: window.truncated, workflows: readCiWorkflows(ctx.repoDir), baseBranch: ctx.repo.base_branch, now: ctx.now });
  return {
    signals: signal as unknown as Record<string, unknown>,
    keys: new Set(ctx.refresh),
    worth: ciWorth(signal) || ctx.refresh.length > 0,
    metrics: null,
  };
}

async function collectTests(ctx: AspectContext, mem: MemoryFile, refresh: { key: string; text: string; status: string }[]): Promise<AspectInput> {
  let runs: CiRun[] = [];
  let ciError: string | null = null;
  if (!ctx.dryRun) {
    try {
      runs = (await ctx.github.ciRunsInWindow(ctx.repoDir, windowSince(ctx.now))).runs;
    } catch (e) {
      ciError = clip(e);
    }
  }
  const signal = await collectTestSignals({ repoDir: ctx.repoDir, repo: ctx.repo, mem, runs, dryRun: ctx.dryRun });
  const worth = testWorth(signal, refresh.length);
  if (ciError && !worth) throw new Error(`ci runs: ${ciError}`);
  return {
    signals: { ...(signal as unknown as Record<string, unknown>), ...(ciError ? { ci_error: ciError } : {}) },
    keys: new Set([...signal.flaky.map((f) => f.key), ...ctx.refresh]),
    worth,
    metrics: null,
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
