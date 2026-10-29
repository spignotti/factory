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

const SELECT_SHAPE = `Return a single \`\`\`json block: {"rationale":"<2-4 sentences naming the signals>","checklist":["<checklist item text the plan turns into a check>"],"plan":<plan.json>}.
${PLAN_SHAPE.split("\nor ")[0]}
plan.resolves_findings: memory keys from the findings signal. Do not return questions.`;

async function select(
  shot: OneShot,
  repoDir: string,
  repo: RepoConfig,
  signals: Signals,
  metrics: unknown,
  prompts: HardenDeps["prompts"],
): Promise<{ rationale: string; plan: Plan; checklist: string[] } | { error: string }> {
  const keys = new Set(signals.findings.map((f) => f.key));
  const items = new Set(signals.checklist);
  const base = [
    asData("signals", JSON.stringify(signals, null, 2)),
    asData("metrics", JSON.stringify(metrics, null, 2)),
    asData("checks", JSON.stringify(repo.checks, null, 2)),
    SELECT_SHAPE,
  ].join("\n\n");
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = errors.length ? `${base}\n\nYour previous answer was rejected:\n- ${errors.join("\n- ")}` : base;
    const res = await shot.call("harden", { role: "harden", cwd: repoDir, tools: "read_only", system: rolePrompt("harden", prompts), prompt });
    const json = extractJson(res.text) as { rationale?: unknown; plan?: unknown; checklist?: unknown } | undefined;
    errors = [];
    if (!json || typeof json !== "object") {
      errors.push("no JSON object in output");
      continue;
    }
    const rationale = typeof json.rationale === "string" ? json.rationale.trim() : "";
    if (!rationale) errors.push("rationale is missing");
    const checklist = Array.isArray(json.checklist) ? json.checklist.filter((x): x is string => typeof x === "string") : [];
    for (const c of checklist) if (!items.has(c)) errors.push(`checklist item not in the signals: ${c.slice(0, 80)}`);
    const v = validatePlan(json.plan, { repo });
    if (!v.ok) errors.push(...v.errors);
    else for (const k of v.plan.resolves_findings ?? []) if (!keys.has(k)) errors.push(`resolves_findings names ${k}, which is not a signalled memory key`);
    if (!errors.length && v.ok) return { rationale, plan: v.plan, checklist };
  }
  return { error: `harden selection invalid after retry: ${errors.join("; ")}` };
}

/** `factory harden` (SPEC §11): lifecycle, compaction, signals, metrics, at most one proposal. */
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
      evaluator: [],
      stale_guides: await staleGuides(repoDir, repo, base),
      reverts: await reverts(repoDir, base, since, prs),
    };
    const metrics = computeMetrics({ ts: now.toISOString(), repoId, repo, mem, signals, factoryPrs: prs.size });
    appendMetrics(deps.factoryHome, repoId, metrics);

    const report: HardenReport = { generated_at: now.toISOString(), repo: repoId, lifecycle, compaction, signals: { ...signals }, metrics, proposal: null, path: null, error: null };
    if (!hasSignals(signals)) return HardenReportSchema.parse(report);
    const chosen = await select(shot, repoDir, repo, signals, metrics, deps.prompts).catch((e: Error) => ({ error: `harden selection failed: ${e.message.slice(0, 200)}` }));
    if ("error" in chosen) return HardenReportSchema.parse({ ...report, error: chosen.error });
    const findings = chosen.plan.resolves_findings ?? [];
    const p = writeProposal(deps.factoryHome, {
      version: 1,
      kind: "harden",
      id: nextProposalId(proposalsDir(deps.factoryHome, repoId), now.toISOString().slice(0, 10), "harden"),
      repo: repoId,
      created_at: now.toISOString(),
      status: "open",
      rationale: chosen.rationale,
      plan: chosen.plan,
      references: { findings, checklist: chosen.checklist },
      signals: { ...signals },
      metrics: { ...metrics },
      resolution: null,
    });
    const refs = new Set(findings);
    updateMemory(deps.factoryHome, repoId, (m) => {
      for (const e of m.entries) {
        if (refs.has(e.key) && e.status === "open") {
          e.status = "proposed";
          e.ref = p.id;
        }
      }
    });
    return HardenReportSchema.parse({ ...report, proposal: p, path: join(proposalsDir(deps.factoryHome, repoId), `${p.id}.json`) });
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
    io.out(r.proposal ? `proposal ${r.proposal.id}: ${r.proposal.plan.goal}\n  ${r.path}\n  run: factory run --repo ${opts.repo} --plan ${r.proposal.plan_path}\n` : r.error ? `no proposal: ${r.error}\n` : "no proposal: no signals\n");
  }
  return r.error ? 1 : 0;
}
