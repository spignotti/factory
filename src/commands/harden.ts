import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { OneShot, type OneShotDeps } from "../agents/oneshot.js";
import { extractJson } from "../agents/runner.js";
import type { GitHub } from "../gh.js";
import { baseRef, originUrl, revParse } from "../git.js";
import { applyCompaction, CompactionSchema, validateCompaction } from "../harden/compact.js";
import { resolveProposals } from "../harden/lifecycle.js";
import { appendMetrics, computeMetrics } from "../harden/metrics.js";
import {
  checklistSignals,
  ciAudit,
  factoryPrNumbers,
  findingSignals,
  evaluatorSignals,
  hasSignals,
  reverts,
  type Signals,
  staleGuides,
  stubText,
  WINDOW_DAYS,
} from "../harden/signals.js";
import { canonicalRepoId, loadMemory, updateMemory } from "../memory.js";
import { asData, rolePrompt } from "../prompts.js";
import { nextProposalId, proposalsDir, writeProposal } from "../proposals.js";
import { listRuns, type RunRecord } from "../runs.js";
import { type Plan, validatePlan } from "../schemas/plan.js";
import { type HardenReport, HardenReportSchema } from "../schemas/proposal.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
import { PLAN_SHAPE } from "../steps/plan.js";
import { statsReport } from "./stats.js";
import type { Io } from "./gates.js";

export const FACTORY_REPO = "spignotti/factory";
/** Most CI runs the audit reads (each needs one `gh run view`). */
export const CI_RUN_LIMIT = 200;

export interface HardenOptions {
  repo: string;
  compact: boolean;
  /** Overrides `repo.yaml` `harden.max_proposals` (1–10). */
  max?: number;
}

export type HardenDeps = OneShotDeps & { github: GitHub };

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function repoRuns(factoryHome: string, repoDir: string): RunRecord[] {
  const me = real(repoDir);
  return listRuns(factoryHome).filter((r) => real(r.state?.repo ?? r.result?.repo ?? "") === me);
}

async function compact(shot: OneShot, factoryHome: string, repoId: string, repoDir: string, prompts: HardenDeps["prompts"]): Promise<{ merged: number; error: string | null }> {
  const open = loadMemory(factoryHome, repoId).entries.filter((e) => e.status === "open");
  if (open.length < 2) return { merged: 0, error: null };
  try {
    const entries = open.map((e) => ({ key: e.key, reviewer: e.reviewer, checkable: e.checkable, count: e.count, text: e.text }));
    const res = await shot.call("compact", { role: "plan_medium", cwd: repoDir, tools: "none", system: rolePrompt("compact", prompts), prompt: asData("entries", JSON.stringify(entries, null, 2)) });
    const parsed = CompactionSchema.safeParse(extractJson(res.text));
    if (!parsed.success) return { merged: 0, error: `invalid compaction output: ${parsed.error.issues[0]?.message ?? "no JSON"}` };
    let merged = 0;
    let errors: string[] = [];
    updateMemory(factoryHome, repoId, (mem) => {
      errors = validateCompaction(mem, parsed.data);
      if (!errors.length) merged = applyCompaction(mem, parsed.data);
    });
    return { merged, error: errors.length ? `compaction rejected: ${errors.slice(0, 3).join("; ")}` : null };
  } catch (e) {
    return { merged: 0, error: `compaction failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

const selectShape = (max: number) => `Return a single \`\`\`json block: {"proposals":[{"rationale":"<2-4 sentences naming the signals>","checklist":["<checklist item text the plan turns into a check>"],"plan":<plan.json>}, …]}.
Up to ${max} proposals, ranked: the most valuable first. Each is its own factory run and PR: distinct goals, and a
memory key or checklist item belongs to at most one proposal. Fewer is fine when the signals do not justify more.
${PLAN_SHAPE.split("\nor ")[0]}
plan.resolves_findings: memory keys from the findings signal. Do not return questions.`;

export interface Selected {
  rationale: string;
  plan: Plan;
  checklist: string[];
}

/**
 * Validates the ranked list in order: an item is accepted when its own plan is valid and it shares no goal,
 * memory key or checklist item with an accepted one. Returns accepted items and per-item errors.
 */
export function validateSelection(
  json: unknown,
  ctx: { repo: RepoConfig; keys: Set<string>; items: Set<string>; max: number },
): { accepted: Selected[]; errors: string[] } {
  const errors: string[] = [];
  const list = json && typeof json === "object" && Array.isArray((json as { proposals?: unknown }).proposals) ? ((json as { proposals: unknown[] }).proposals) : undefined;
  if (!list) return { accepted: [], errors: ["no {\"proposals\": [...]} object in output"] };
  if (!list.length) return { accepted: [], errors: ["proposals is empty"] };
  if (list.length > ctx.max) errors.push(`${list.length} proposals, at most ${ctx.max} allowed: the ones after ${ctx.max} were dropped`);
  const accepted: Selected[] = [];
  const goals = new Set<string>();
  const usedKeys = new Set<string>();
  const usedItems = new Set<string>();
  list.slice(0, ctx.max).forEach((raw, i) => {
    const at = `proposal ${i + 1}`;
    const own: string[] = [];
    const item = (raw && typeof raw === "object" ? raw : {}) as { rationale?: unknown; plan?: unknown; checklist?: unknown };
    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
    if (!rationale) own.push("rationale is missing");
    const checklist = Array.isArray(item.checklist) ? item.checklist.filter((x): x is string => typeof x === "string") : [];
    for (const c of checklist) {
      if (!ctx.items.has(c)) own.push(`checklist item not in the signals: ${c.slice(0, 80)}`);
      else if (usedItems.has(c)) own.push(`checklist item already in an earlier proposal: ${c.slice(0, 80)}`);
    }
    const v = validatePlan(item.plan, { repo: ctx.repo });
    if (!v.ok) own.push(...v.errors);
    else {
      if (goals.has(v.plan.goal)) own.push(`goal repeats an earlier proposal: ${v.plan.goal.slice(0, 80)}`);
      for (const k of v.plan.resolves_findings ?? []) {
        if (!ctx.keys.has(k)) own.push(`resolves_findings names ${k}, which is not a signalled memory key`);
        else if (usedKeys.has(k)) own.push(`resolves_findings names ${k}, already resolved by an earlier proposal`);
      }
    }
    if (own.length || !v.ok) {
      errors.push(...own.map((e) => `${at}: ${e}`));
      return;
    }
    goals.add(v.plan.goal);
    for (const k of v.plan.resolves_findings ?? []) usedKeys.add(k);
    for (const c of checklist) usedItems.add(c);
    accepted.push({ rationale, plan: v.plan, checklist });
  });
  return { accepted, errors };
}

async function select(
  shot: OneShot,
  repoDir: string,
  repo: RepoConfig,
  signals: Signals,
  metrics: unknown,
  prompts: HardenDeps["prompts"],
  max: number,
): Promise<{ accepted: Selected[]; rejected: string[] } | { error: string }> {
  const ctx = { repo, keys: new Set(signals.findings.map((f) => f.key)), items: new Set(signals.checklist), max };
  const base = [
    asData("signals", JSON.stringify(signals, null, 2)),
    asData("metrics", JSON.stringify(metrics, null, 2)),
    asData("checks", JSON.stringify(repo.checks, null, 2)),
    selectShape(max),
  ].join("\n\n");
  let last: { accepted: Selected[]; errors: string[] } = { accepted: [], errors: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = last.errors.length ? `${base}\n\nYour previous answer was rejected:\n- ${last.errors.join("\n- ")}` : base;
    const res = await shot.call("harden", { role: "harden", cwd: repoDir, tools: "read_only", system: rolePrompt("harden", prompts), prompt });
    last = validateSelection(extractJson(res.text), ctx);
    if (!last.errors.length) return { accepted: last.accepted, rejected: [] };
  }
  // After the retry the valid proposals stand; the rest are reported.
  if (last.accepted.length) return { accepted: last.accepted, rejected: last.errors };
  return { error: `harden selection invalid after retry: ${last.errors.join("; ")}` };
}

/** `factory harden`: lifecycle, compaction, signals, metrics, at most one proposal. */
export async function harden(opts: HardenOptions, deps: HardenDeps): Promise<HardenReport> {
  const repoDir = resolve(opts.repo);
  const now = new Date((deps.now ?? Date.now)());
  const repo = loadRepoConfig(repoDir);
  const repoId = canonicalRepoId(await originUrl(repoDir).catch(() => ""), repoDir);
  const base = await revParse(repoDir, await baseRef(repoDir, repo.base_branch));
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const runs = repoRuns(deps.factoryHome, repoDir);
  const lifecycle = await resolveProposals({ factoryHome: deps.factoryHome, repoId, repoDir, runs, github: deps.github, now });

  const shot = new OneShot(deps, join(deps.factoryHome, "harden", repoId.replace(/[^\w.-]+/g, "_")), `harden-${now.toISOString().replace(/[:.]/g, "-")}`, repo);
  try {
    const compaction = opts.compact ? await compact(shot, deps.factoryHome, repoId, repoDir, deps.prompts) : { merged: 0, error: null };
    const mem = loadMemory(deps.factoryHome, repoId);
    let ci: Signals["ci"];
    try {
      const [ciRuns, latest] = await Promise.all([deps.github.ciRuns(repoDir, since, CI_RUN_LIMIT), deps.github.latestTag(repoDir, FACTORY_REPO).catch(() => null)]);
      ci = ciAudit(ciRuns, repo, stubText(repoDir), latest);
    } catch (e) {
      ci = { error: (e as Error).message.split("\n")[0]!.slice(0, 200) };
    }
    const period = statsReport({ factoryHome: deps.factoryHome, since: `${WINDOW_DAYS}d`, repo: repoDir, now: () => now.getTime() }).current;
    const windowRuns = runs.filter((r) => r.started_at.toISOString() >= since);
    const prs = factoryPrNumbers(windowRuns);
    const signals: Signals = {
      findings: findingSignals(mem),
      checklist: checklistSignals(repoDir, repo),
      ci,
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
      evaluator: evaluatorSignals(windowRuns, repo),
      stale_guides: await staleGuides(repoDir, repo, base),
      reverts: await reverts(repoDir, base, since, prs),
    };
    const metrics = computeMetrics({ ts: now.toISOString(), repoId, repo, mem, signals, factoryPrs: prs.size });
    appendMetrics(deps.factoryHome, repoId, metrics);

    const report: HardenReport = { generated_at: now.toISOString(), repo: repoId, lifecycle, compaction, signals: { ...signals }, metrics, ticket: null, path: null, rejected: [], error: null };
    if (!hasSignals(signals)) return HardenReportSchema.parse(report);
    const max = opts.max ?? repo.harden.max_proposals;
    const chosen = await select(shot, repoDir, repo, signals, metrics, deps.prompts, max).catch((e: Error) => ({ error: `harden selection failed: ${e.message.slice(0, 200)}` }));
    if ("error" in chosen) return HardenReportSchema.parse({ ...report, error: chosen.error });
    const t = writeProposal(deps.factoryHome, {
      version: 1,
      kind: "harden",
      id: nextProposalId(proposalsDir(deps.factoryHome, repoId), now.toISOString().slice(0, 10), "harden"),
      repo: repoId,
      created_at: now.toISOString(),
      proposals: chosen.accepted.map((c) => ({
        status: "open" as const,
        rationale: c.rationale,
        plan: c.plan,
        references: { findings: c.plan.resolves_findings ?? [], checklist: c.checklist },
        resolution: null,
      })),
      signals: { ...signals },
      metrics: { ...metrics },
    });
    const owner = new Map(t.proposals.flatMap((p) => p.references.findings.map((k) => [k, p.id] as const)));
    updateMemory(deps.factoryHome, repoId, (m) => {
      for (const e of m.entries) {
        const id = owner.get(e.key);
        if (id && e.status === "open") {
          e.status = "proposed";
          e.ref = id;
        }
      }
    });
    return HardenReportSchema.parse({ ...report, ticket: t, path: join(proposalsDir(deps.factoryHome, repoId), `${t.id}.json`), rejected: chosen.rejected });
  } finally {
    shot.close();
  }
}

export async function hardenCommand(opts: HardenOptions & { json: boolean }, deps: HardenDeps, io: Io): Promise<number> {
  const r = await harden(opts, deps);
  if (opts.json) io.out(JSON.stringify(r) + "\n");
  else {
    for (const c of r.lifecycle) io.out(`proposal ${c.id}: ${c.status} (${c.reason})\n`);
    if (r.compaction.merged || r.compaction.error) io.out(`compaction: ${r.compaction.merged} merged${r.compaction.error ? `; ${r.compaction.error}` : ""}\n`);
    io.out(`metrics: determinism ${r.metrics.determinism_ratio ?? "–"}, open findings ${r.metrics.open_findings}, CI min/week ${r.metrics.ci_minutes_per_week ?? "–"}\n`);
    if (r.ticket) {
      io.out(`ticket ${r.path}: ${r.ticket.proposals.length} proposal(s)\n`);
      for (const p of r.ticket.proposals) io.out(`  ${p.rank}. ${p.plan.goal}\n     run: factory run --repo ${opts.repo} --plan ${p.plan_path}\n`);
      for (const x of r.rejected) io.out(`  rejected: ${x}\n`);
    } else io.out(r.error ? `no proposal: ${r.error}\n` : "no proposal: no signals\n");
  }
  return r.error ? 1 : 0;
}
