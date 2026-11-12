import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { OneShot, type OneShotDeps } from "../agents/oneshot.js";
import { extractJson } from "../agents/runner.js";
import { withRepoModels } from "../config.js";
import type { GitHub } from "../gh.js";
import { originUrl } from "../git.js";
import { formatLifecycle, resolveProposals } from "../harden/lifecycle.js";
import { latestMetrics } from "../harden/metrics.js";
import { ciAudit, stubText, WINDOW_DAYS } from "../harden/signals.js";
import { canonicalRepoId, loadMemory, markFindingsProposed } from "../memory.js";
import { asData, rolePrompt } from "../prompts.js";
import { nextProposalId, proposalsDir, writeProposal } from "../proposals.js";
import { listRuns } from "../runs.js";
import { type AuditReport, AuditReportSchema } from "../schemas/proposal.js";
import { type Profile, type ProfileRole } from "../schemas/profile.js";
import { type AuditType, loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
import { PLAN_SHAPE } from "../steps/plan.js";
import { CI_RUN_LIMIT, FACTORY_REPO, validateSelection, type Selected } from "./harden.js";
import type { Io } from "./gates.js";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export interface AuditOptions {
  repo: string;
  type: AuditType;
  /** Overrides `repo.yaml` `audit.max_proposals` (1–10). */
  max?: number;
}

export type AuditDeps = OneShotDeps & { github: GitHub };

const ROLE: Record<AuditType, ProfileRole> = {
  security: "audit_security",
  performance: "audit_performance",
  refactor: "audit_refactor",
  simplify: "audit_simplify",
};

function disabledMessage(type: AuditType): string {
  return `audit type "${type}" is not enabled for this repo. Add it to audit.types in .factory/repo.yaml (security, performance, refactor, simplify). With no audit block every type is refused.`;
}

/** `audit.thinking` replaces the chain's thinking level; the models stay the profile's. */
function withThinking(profile: Profile, role: ProfileRole, thinking: RepoConfig["audit"]["thinking"][AuditType]): Profile {
  return { ...profile, roles: { ...profile.roles, [role]: profile.roles[role].map((e) => ({ ...e, thinking })) } };
}

const selectShape = (max: number, type: AuditType) => `Return a single \`\`\`json block: {"proposals":[{"rationale":"<2-4 sentences naming the evidence, with file:line>","plan":<plan.json>}, …]}.
Up to ${max} ${type} proposals, ranked: the most valuable first. Each is its own factory run and PR: distinct goals, and a
memory key belongs to at most one proposal. Fewer is fine when the repository does not justify more.
${PLAN_SHAPE.split("\nor ")[0]}
plan.resolves_findings: memory keys from the open findings, or []. Do not return questions.`;

/**
 * User prompt for one audit type. `focus` is that type's note only; omitting it keeps the historical
 * three-part prompt (signals, checks, selection shape) byte for byte.
 */
export function auditUserPrompt(input: { signals: unknown; checks: unknown; max: number; type: AuditType; focus?: string }): string {
  const parts = [asData("signals", JSON.stringify(input.signals, null, 2)), asData("checks", JSON.stringify(input.checks, null, 2))];
  if (input.focus) parts.push(asData("focus", input.focus));
  parts.push(selectShape(input.max, input.type));
  return parts.join("\n\n");
}

function repoRuns(factoryHome: string, repoDir: string) {
  const me = real(repoDir);
  return listRuns(factoryHome).filter((r) => real(r.state?.repo ?? r.result?.repo ?? "") === me);
}

/** `factory audit`: one read-only session, one ticket of ranked plans. */
export async function audit(opts: AuditOptions, deps: AuditDeps): Promise<AuditReport> {
  const repoDir = real(opts.repo);
  const now = new Date((deps.now ?? Date.now)());
  const repo = loadRepoConfig(repoDir);
  const repoId = canonicalRepoId(await originUrl(repoDir).catch(() => ""), repoDir);
  const blank: AuditReport = {
    generated_at: now.toISOString(),
    repo: repoId,
    type: opts.type,
    lifecycle: [],
    signals: {},
    ticket: null,
    path: null,
    rejected: [],
    error: null,
  };
  if (!repo.audit.types.includes(opts.type)) return AuditReportSchema.parse({ ...blank, error: disabledMessage(opts.type) });

  const runs = repoRuns(deps.factoryHome, repoDir);
  const lifecycle = await resolveProposals({ factoryHome: deps.factoryHome, repoId, repoDir, runs, github: deps.github, now });
  const role = ROLE[opts.type];
  const profile = withThinking(withRepoModels(deps.profile, repo.models), role, repo.audit.thinking[opts.type]);
  const shot = new OneShot({ ...deps, profile }, join(deps.factoryHome, "audit", repoId.replace(/[^\w.-]+/g, "_")), `audit-${opts.type}-${now.toISOString().replace(/[:.]/g, "-")}`, repo);
  try {
    const mem = loadMemory(deps.factoryHome, repoId);
    const findings = mem.entries
      .filter((e) => e.status === "open" && (e.disposition ?? "confirmed") === "confirmed")
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .map((e) => ({ key: e.key, text: e.text, reviewer: e.reviewer, count: e.count, checkable: e.checkable, check_sketch: e.check_sketch }));
    const metrics = latestMetrics(deps.factoryHome, repoId);
    const signals: Record<string, unknown> = { findings, metrics };
    if (opts.type === "performance") {
      const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
      try {
        const [ciRuns, latest] = await Promise.all([deps.github.ciRuns(repoDir, since, CI_RUN_LIMIT), deps.github.latestTag(repoDir, FACTORY_REPO).catch(() => null)]);
        signals.ci = ciAudit(ciRuns, repo, stubText(repoDir), latest);
      } catch (e) {
        signals.ci = { error: (e as Error).message.split("\n")[0]!.slice(0, 200) };
      }
    }
    const report: AuditReport = { ...blank, lifecycle, signals };
    const max = opts.max ?? repo.audit.max_proposals;
    const keys = new Set(findings.map((f) => f.key));
    const base = auditUserPrompt({ signals, checks: repo.checks, max, type: opts.type, focus: repo.audit.focus[opts.type] });
    let last: { accepted: Selected[]; errors: string[] } = { accepted: [], errors: [] };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt = last.errors.length ? `${base}\n\nYour previous answer was rejected:\n- ${last.errors.join("\n- ")}` : base;
        const res = await shot.call("audit", { role, cwd: repoDir, tools: "read_only", system: rolePrompt(`audit-${opts.type}`, deps.prompts), prompt });
        last = validateSelection(extractJson(res.text), { repo, keys, max });
        if (!last.errors.length) break;
      }
    } catch (e) {
      return AuditReportSchema.parse({ ...report, error: `audit selection failed: ${(e as Error).message.slice(0, 200)}` });
    }
    if (!last.accepted.length) {
      return AuditReportSchema.parse({ ...report, error: `audit selection invalid after retry: ${last.errors.join("; ")}` });
    }
    const t = writeProposal(deps.factoryHome, {
      version: 1,
      kind: "audit",
      id: nextProposalId(proposalsDir(deps.factoryHome, repoId), now.toISOString().slice(0, 10), "audit", opts.type),
      repo: repoId,
      created_at: now.toISOString(),
      proposals: last.accepted.map((c) => ({
        status: "open" as const,
        type: opts.type,
        rationale: c.rationale,
        plan: c.plan,
        references: { findings: c.plan.resolves_findings ?? [], checklist: c.checklist },
        resolution: null,
      })),
      signals,
      metrics,
    });
    markFindingsProposed(deps.factoryHome, repoId, new Map(t.proposals.flatMap((p) => p.references.findings.map((k) => [k, p.id] as const))));
    return AuditReportSchema.parse({
      ...report,
      ticket: t,
      path: join(proposalsDir(deps.factoryHome, repoId), `${t.id}.json`),
      rejected: last.errors,
    });
  } finally {
    shot.close();
  }
}

export async function auditCommand(opts: AuditOptions & { json: boolean }, deps: AuditDeps, io: Io): Promise<number> {
  const r = await audit(opts, deps);
  if (opts.json) io.out(JSON.stringify(r) + "\n");
  else {
    for (const c of r.lifecycle) io.out(formatLifecycle(c));
    if (r.ticket) {
      io.out(`ticket ${r.path}: ${r.ticket.proposals.length} proposal(s)\n`);
      for (const p of r.ticket.proposals) io.out(`  ${p.rank}. ${p.plan.goal}\n     run: factory run --repo ${opts.repo} --plan ${p.plan_path}\n`);
      for (const x of r.rejected) io.out(`  rejected: ${x}\n`);
    } else io.out(r.error ? `no proposal: ${r.error}\n` : "no proposal\n");
  }
  return r.error ? 1 : 0;
}
