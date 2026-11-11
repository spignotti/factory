import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { OneShot, type OneShotDeps } from "../agents/oneshot.js";
import { extractJson } from "../agents/runner.js";
import { withRepoModels } from "../config.js";
import type { GitHub, Issue } from "../gh.js";
import { originUrl } from "../git.js";
import { resolveProposals } from "../harden/lifecycle.js";
import { ASPECTS, collectAspect } from "../improve/aspects.js";
import { dedupeProposals, issueWrite, matchingIssue, parseProposalIssue, proposalLabels } from "../improve/issues.js";
import { canonicalRepoId, markFindingsProposed, updateMemory } from "../memory.js";
import { asData, rolePrompt } from "../prompts.js";
import { listProposals, nextProposalId, proposalsDir, saveProposal, updateProposalItem, writeProposal } from "../proposals.js";
import { listRuns, type RunRecord } from "../runs.js";
import { type ImproveAspectResult, type ImproveIssue, type ImproveReport, ImproveReportSchema, type Proposal, type ProposalItem } from "../schemas/proposal.js";
import { THINKING_LEVELS, type Profile, type ProfileRole } from "../schemas/profile.js";
import {
  type AuditType,
  DEFAULT_IMPROVE_THINKING,
  IMPROVE_ASPECTS,
  type ImproveAspect,
  type ImproveConfig,
  loadRepoConfig,
  REPO_CONFIG_PATH,
  type RepoConfig,
} from "../schemas/repo.js";
import { PLAN_SHAPE } from "../steps/plan.js";
import { compactMemory, validateSelection, type Selected } from "./harden.js";
import type { Io } from "./gates.js";

export const CONFIG_DEPRECATION = "harden: and audit: are deprecated; use improve: in .factory/repo.yaml";
export const HARDEN_DEPRECATION = "factory: `harden` is deprecated; use `factory improve --aspect findings`.\n";

export function auditDeprecation(aspect: ImproveAspect): string {
  return `factory: \`audit\` is deprecated; use \`factory improve --aspect ${aspect}\`.\n`;
}

/** `audit` types collapse onto improve aspects. `refactor` and `simplify` are one role. */
export const AUDIT_ASPECT: Record<AuditType, ImproveAspect> = {
  security: "security",
  performance: "performance",
  refactor: "structure",
  simplify: "structure",
};

export interface ResolvedImprove {
  aspects: ImproveAspect[];
  maxProposals: number;
  thinking: ImproveConfig["thinking"];
  focus: ImproveConfig["focus"];
  warnings: string[];
}

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

/** `improve:` wins. Otherwise `harden:` enables findings and `audit.types` map onto aspects, with a warning. */
export function resolveImproveConfig(repo: RepoConfig, raw: Record<string, unknown>): ResolvedImprove {
  const warnings: string[] = [];
  const thinking = { ...DEFAULT_IMPROVE_THINKING, ...repo.improve?.thinking };
  const focus = { ...repo.improve?.focus };
  if (raw.improve !== undefined && repo.improve) {
    if (raw.harden !== undefined || raw.audit !== undefined) warnings.push("improve: is set; harden: and audit: are ignored");
    return { aspects: [...new Set(repo.improve.aspects)], maxProposals: repo.improve.max_proposals, thinking: repo.improve.thinking, focus: repo.improve.focus, warnings };
  }
  const hasHarden = raw.harden !== undefined;
  const hasAudit = raw.audit !== undefined;
  if (!hasHarden && !hasAudit) {
    return { aspects: [], maxProposals: repo.harden.max_proposals, thinking, focus: {}, warnings };
  }
  warnings.push(CONFIG_DEPRECATION);
  const aspects: ImproveAspect[] = [];
  if (hasHarden) aspects.push("findings");
  if (hasAudit) {
    for (const type of repo.audit.types) {
      const aspect = AUDIT_ASPECT[type];
      if (!aspects.includes(aspect)) aspects.push(aspect);
    }
  }
  const max = hasAudit && hasHarden ? Math.max(repo.harden.max_proposals, repo.audit.max_proposals) : hasAudit ? repo.audit.max_proposals : repo.harden.max_proposals;
  if (hasAudit) {
    thinking.security = repo.audit.thinking.security;
    thinking.performance = repo.audit.thinking.performance;
    // Structure is both audit types. Use the higher level that is actually enabled, not refactor's alone.
    const structureLevels = [
      repo.audit.types.includes("refactor") ? repo.audit.thinking.refactor : undefined,
      repo.audit.types.includes("simplify") ? repo.audit.thinking.simplify : undefined,
    ].filter((level): level is (typeof THINKING_LEVELS)[number] => level !== undefined);
    if (structureLevels.length) {
      thinking.structure = structureLevels.reduce((a, b) => (THINKING_LEVELS.indexOf(a) >= THINKING_LEVELS.indexOf(b) ? a : b));
    }
    if (repo.audit.focus.security) focus.security = repo.audit.focus.security;
    if (repo.audit.focus.performance) focus.performance = repo.audit.focus.performance;
    const notes = [repo.audit.types.includes("refactor") ? repo.audit.focus.refactor : undefined, repo.audit.types.includes("simplify") ? repo.audit.focus.simplify : undefined].filter((n): n is string => !!n);
    if (notes.length) focus.structure = notes.join("\n\n");
  }
  return { aspects, maxProposals: max, thinking, focus, warnings };
}

function withThinking(profile: Profile, role: ProfileRole, thinking: ImproveConfig["thinking"][ImproveAspect]): Profile {
  return { ...profile, roles: { ...profile.roles, [role]: profile.roles[role].map((e) => ({ ...e, thinking })) } };
}

function selectShape(max: number, aspect: ImproveAspect, checklist: boolean): string {
  const fields = checklist
    ? `"rationale":"<2-4 sentences naming the evidence>","checklist":["<unmarked_standards text the plan turns into a check>"],"plan":<plan.json>`
    : `"rationale":"<2-4 sentences naming the evidence>","plan":<plan.json>`;
  return `Return a single \`\`\`json block: {"proposals":[{${fields}}, …]}.
Up to ${max} ${aspect} proposals, ranked: the most valuable first. Each is its own factory run and PR: distinct goals, and a
memory key${checklist ? " or checklist item" : ""} belongs to at most one proposal. Fewer is fine when the signals do not justify more.
${PLAN_SHAPE.split("\nor ")[0]}
plan.resolves_findings: memory keys from the signals (including refresh_findings), or []. Do not return questions.`;
}

function userPrompt(input: { signals: unknown; checks: unknown; max: number; aspect: ImproveAspect; focus?: string; checklist: boolean }): string {
  const parts = [asData("signals", JSON.stringify(input.signals, null, 2)), asData("checks", JSON.stringify(input.checks, null, 2))];
  if (input.focus) parts.push(asData("focus", input.focus));
  parts.push(selectShape(input.max, input.aspect, input.checklist));
  return parts.join("\n\n");
}

export interface ImproveOptions {
  repo: string;
  /** Omit to run every configured aspect. */
  aspects?: ImproveAspect[];
  max?: number;
  dryRun?: boolean;
  /** Run the requested aspects even when the repo has not enabled them (`factory harden`). */
  force?: boolean;
  /** Compact open findings before the findings aspect. Default: on when findings runs. */
  compact?: boolean;
}

export type ImproveDeps = OneShotDeps & { github: GitHub };

function blank(now: Date, repoId: string, over: Partial<ImproveReport> = {}): ImproveReport {
  return ImproveReportSchema.parse({
    generated_at: now.toISOString(),
    repo: repoId,
    aspects: [],
    warnings: [],
    dry_run: false,
    lifecycle: [],
    compaction: { merged: 0, error: null },
    results: [],
    error: null,
    ...over,
  });
}

function disabled(aspects: ImproveAspect[]): string {
  return `aspect ${aspects.join(", ")} is not enabled for this repo. Add it to improve.aspects in .factory/repo.yaml (${IMPROVE_ASPECTS.join(", ")}). With no improve block, harden: and audit: are still read.`;
}

function refreshKeys(factoryHome: string, repoId: string, aspect: ImproveAspect, issues: Issue[]): string[] {
  const keys = new Set<string>();
  for (const ticket of listProposals(factoryHome, repoId)) {
    for (const p of ticket.proposals) if (p.status === "open" && p.aspect === aspect) for (const k of p.references.findings) keys.add(k);
  }
  for (const issue of issues) {
    const parsed = parseProposalIssue(issue);
    if (parsed?.aspect === aspect) for (const k of parsed.findings) keys.add(k);
  }
  return [...keys];
}

/** A leftover open record with the same issue, key or findings is dropped. The record an open issue already has is updated in place and is not passed here as a new id. */
function replaceOpenMatches(factoryHome: string, repoId: string, published: ProposalItem, now: Date): void {
  for (const ticket of listProposals(factoryHome, repoId)) {
    let dirty = false;
    const proposals = ticket.proposals.map((p) => {
      if (p.status !== "open" || p.id === published.id) return p;
      const overlap = p.references.findings.some((k) => published.references.findings.includes(k));
      const same = (p.key && p.key === published.key) || (p.issue != null && p.issue === published.issue) || overlap;
      if (!same || p.aspect !== published.aspect) return p;
      dirty = true;
      const refs = new Set(p.references.findings);
      updateMemory(factoryHome, repoId, (mem) => {
        for (const e of mem.entries) {
          if (!refs.has(e.key) || e.status !== "proposed" || e.ref !== p.id) continue;
          e.status = "open";
          e.ref = null;
        }
      });
      return { ...p, status: "dropped" as const, resolution: { at: now.toISOString(), status: "dropped" as const, reason: "replaced by a newer proposal", run_id: null, pr: null } };
    });
    if (dirty) saveProposal(factoryHome, { ...ticket, proposals });
  }
}

/** Open proposal this issue already belongs to. The issue number wins; a key match must not point at a different issue. */
function findOpenProposal(factoryHome: string, repoId: string, aspect: ImproveAspect, key: string, issue: number): { ticketId: string; item: ProposalItem } | undefined {
  const open = listProposals(factoryHome, repoId).flatMap((ticket) =>
    ticket.proposals.filter((p) => p.status === "open" && p.aspect === aspect).map((item) => ({ ticketId: ticket.id, item })),
  );
  return open.find((e) => e.item.issue === issue) ?? open.find((e) => e.item.key === key && (e.item.issue == null || e.item.issue === issue));
}

interface PublishSlot {
  selected: Selected;
  key: string;
  match: Issue | undefined;
  /** Set when an open issue already has a proposal record. That record is updated; no new id is written. */
  existing?: { ticketId: string; item: ProposalItem };
}

function classify(factoryHome: string, repoId: string, aspect: ImproveAspect, kept: Selected[], open: Issue[], dryRun: boolean): PublishSlot[] {
  return kept.map((selected) => {
    const key = issueWrite(aspect, selected.rationale, selected.plan).key;
    if (dryRun) return { selected, key, match: undefined };
    const match = matchingIssue(open, key);
    const existing = match ? findOpenProposal(factoryHome, repoId, aspect, key, match.number) : undefined;
    return { selected, key, match, ...(existing ? { existing } : {}) };
  });
}

function proposalDraft(aspect: ImproveAspect, slot: PublishSlot) {
  return {
    status: "open" as const,
    aspect,
    key: slot.key,
    issue: null,
    rationale: slot.selected.rationale,
    plan: slot.selected.plan,
    references: { findings: slot.selected.plan.resolves_findings ?? [], checklist: slot.selected.checklist },
    resolution: null,
  };
}

function latestById(tickets: Proposal[]): Proposal[] {
  const byId = new Map<string, Proposal>();
  for (const t of tickets) byId.set(t.id, t);
  return [...byId.values()];
}

interface Published {
  issues: ImproveIssue[];
  error: string | null;
  owned: ProposalItem[];
  fresh: Proposal | null;
  updated: Proposal[];
}

/** Creates issues for new proposals. An open issue with the same marker updates that issue and its proposal record, keeping the id. */
async function publishSlots(
  github: GitHub,
  repoDir: string,
  factoryHome: string,
  repoId: string,
  aspect: ImproveAspect,
  slots: PublishSlot[],
  fresh: Proposal | null,
  open: Issue[],
  issuesComplete: boolean,
  signals: Proposal["signals"],
  metrics: Proposal["metrics"],
): Promise<Published> {
  const labels = proposalLabels(aspect);
  try {
    for (const label of labels) await github.ensureLabel(repoDir, label);
  } catch (e) {
    return { issues: [], owned: [], fresh, updated: [], error: `label create failed: ${(e as Error).message.slice(0, 200)}` };
  }
  const issues: ImproveIssue[] = [];
  const owned: ProposalItem[] = [];
  const updated: Proposal[] = [];
  let ticket = fresh;
  let freshIndex = 0;
  for (const slot of slots) {
    const write = issueWrite(aspect, slot.selected.rationale, slot.selected.plan);
    if (!slot.match && !issuesComplete) {
      if (ticket) saveProposal(factoryHome, ticket);
      return { issues, owned, fresh: ticket, updated, error: `open issue list may be incomplete; not creating an issue for ${slot.selected.plan.goal}` };
    }
    try {
      const issue = slot.match ? await github.updateIssue(repoDir, slot.match.number, write) : await github.createIssue(repoDir, write);
      const stored = { ...issue, labels: write.labels, state: "open" as const };
      const at = open.findIndex((x) => x.number === issue.number);
      if (at >= 0) open[at] = stored;
      else open.push(stored);
      const existing = slot.existing;
      if (existing) {
        const savedTicket = updateProposalItem(
          factoryHome,
          repoId,
          existing.ticketId,
          {
            ...existing.item,
            rationale: slot.selected.rationale,
            plan: slot.selected.plan,
            key: slot.key,
            issue: issue.number,
            references: { findings: slot.selected.plan.resolves_findings ?? [], checklist: slot.selected.checklist },
          },
          { signals, metrics },
        );
        updated.push(savedTicket);
        const saved = savedTicket.proposals.find((p) => p.id === existing.item.id)!;
        issues.push({ proposal_id: saved.id, number: issue.number, action: "updated" });
        owned.push(saved);
      } else if (ticket) {
        const current = ticket.proposals[freshIndex];
        if (!current) throw new Error("fresh proposal missing");
        ticket = { ...ticket, proposals: ticket.proposals.map((p, i) => (i === freshIndex ? { ...p, key: write.key, issue: issue.number } : p)) };
        freshIndex++;
        const saved = ticket.proposals[freshIndex - 1]!;
        issues.push({ proposal_id: saved.id, number: issue.number, action: slot.match ? "updated" : "created" });
        owned.push(saved);
      }
    } catch (e) {
      if (ticket) saveProposal(factoryHome, ticket);
      return { issues, owned, fresh: ticket, updated, error: `issue ${slot.match ? "update" : "create"} failed: ${(e as Error).message.slice(0, 200)}` };
    }
  }
  if (ticket) saveProposal(factoryHome, ticket);
  return { issues, owned, fresh: ticket, updated, error: null };
}

async function select(
  shot: OneShot,
  repoDir: string,
  repo: RepoConfig,
  aspect: ImproveAspect,
  prompt: string,
  role: ProfileRole,
  prompts: ImproveDeps["prompts"],
  ctx: { keys: Set<string>; items?: Set<string>; max: number },
): Promise<{ accepted: Selected[]; rejected: string[] } | { error: string }> {
  let last: { accepted: Selected[]; errors: string[] } = { accepted: [], errors: [] };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = last.errors.length ? `${prompt}\n\nYour previous answer was rejected:\n- ${last.errors.join("\n- ")}` : prompt;
      const res = await shot.call("improve", { role, cwd: repoDir, tools: "read_only", system: rolePrompt(ASPECTS[aspect].prompt, prompts), prompt: text });
      last = validateSelection(extractJson(res.text), { repo, keys: ctx.keys, ...(ctx.items ? { items: ctx.items } : {}), max: ctx.max });
      if (!last.errors.length) return { accepted: last.accepted, rejected: [] };
    }
  } catch (e) {
    return { error: `${aspect} selection failed: ${(e as Error).message.slice(0, 200)}` };
  }
  if (last.accepted.length) return { accepted: last.accepted, rejected: last.errors };
  return { error: `${aspect} selection invalid after retry: ${last.errors.join("; ")}` };
}

/** `factory improve`: one config block, one issue per valid proposal. */
export async function improve(opts: ImproveOptions, deps: ImproveDeps): Promise<ImproveReport> {
  const repoDir = resolve(opts.repo);
  const now = new Date((deps.now ?? Date.now)());
  const text = readFileSync(join(repoDir, REPO_CONFIG_PATH), "utf8");
  const repo = loadRepoConfig(repoDir);
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const repoId = canonicalRepoId(await originUrl(repoDir).catch(() => ""), repoDir);
  const resolved = resolveImproveConfig(repo, raw);
  const requested = opts.aspects?.length ? [...new Set(opts.aspects)] : undefined;
  const dryRun = opts.dryRun ?? false;
  if (requested) {
    const missing = requested.filter((aspect) => !resolved.aspects.includes(aspect));
    if (missing.length && !opts.force) return blank(now, repoId, { warnings: resolved.warnings, dry_run: dryRun, error: disabled(missing) });
  } else if (!resolved.aspects.length) {
    return blank(now, repoId, { warnings: resolved.warnings, dry_run: dryRun, error: "no improve.aspects configured. Add an improve: block to .factory/repo.yaml." });
  }
  const aspects = requested ?? resolved.aspects;
  const max = opts.max ?? resolved.maxProposals;
  const runs = repoRuns(deps.factoryHome, repoDir);
  // `--dry-run` writes proposal files only. Lifecycle reads issue and PR state from `gh`; skip it entirely.
  const lifecycle = dryRun ? [] : await resolveProposals({ factoryHome: deps.factoryHome, repoId, repoDir, runs, github: deps.github, now });
  const compact = opts.compact ?? aspects.includes("findings");
  let compaction = { merged: 0, error: null as string | null };
  const logDir = join(deps.factoryHome, "improve", repoId.replace(/[^\w.-]+/g, "_"));
  if (compact && aspects.includes("findings")) {
    const shot = new OneShot(deps, logDir, `improve-compact-${now.toISOString().replace(/[:.]/g, "-")}`, repo);
    try {
      compaction = await compactMemory(shot, deps.factoryHome, repoId, repoDir, deps.prompts);
    } finally {
      shot.close();
    }
  }
  let openIssues: Issue[] = [];
  let issuesComplete = true;
  if (!dryRun) {
    try {
      const listed = await deps.github.listOpenIssues(repoDir);
      openIssues = listed.issues;
      issuesComplete = listed.complete;
    } catch (e) {
      return blank(now, repoId, { aspects, warnings: resolved.warnings, dry_run: dryRun, lifecycle, compaction, error: `listing proposal issues failed: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  const profile = withRepoModels(deps.profile, repo.models);
  const results: ImproveAspectResult[] = [];
  for (const aspect of aspects) {
    const spec = ASPECTS[aspect];
    const refresh = refreshKeys(deps.factoryHome, repoId, aspect, openIssues);
    let input;
    try {
      input = await collectAspect(aspect, { repoDir, repo, factoryHome: deps.factoryHome, repoId, now, github: deps.github, runs, refresh, dryRun });
    } catch (e) {
      results.push({ aspect, signals: {}, ticket: null, path: null, rejected: [], issues: [], error: `${aspect} signals failed: ${(e as Error).message.slice(0, 200)}` });
      continue;
    }
    if (!input.worth) {
      results.push({ aspect, signals: input.signals, ticket: null, path: null, rejected: [], issues: [], error: null });
      continue;
    }
    const prompt = userPrompt({ signals: input.signals, checks: repo.checks, max, aspect, focus: resolved.focus[aspect], checklist: aspect === "findings" });
    const shot = new OneShot({ ...deps, profile: withThinking(profile, spec.role, resolved.thinking[aspect]) }, logDir, `improve-${aspect}-${now.toISOString().replace(/[:.]/g, "-")}`, repo);
    try {
      const chosen = await select(shot, repoDir, repo, aspect, prompt, spec.role, deps.prompts, { keys: input.keys, ...(input.checklist ? { items: input.checklist } : {}), max });
      if ("error" in chosen) {
        results.push({ aspect, signals: input.signals, ticket: null, path: null, rejected: [], issues: [], error: chosen.error });
        continue;
      }
      const unique = dedupeProposals(aspect, chosen.accepted);
      const rejected = [...chosen.rejected, ...unique.dropped];
      const slots = classify(deps.factoryHome, repoId, aspect, unique.kept, openIssues, dryRun);
      const freshSlots = slots.filter((s) => !s.existing);
      let ticket: Proposal | null = freshSlots.length
        ? writeProposal(deps.factoryHome, {
            version: 1,
            kind: "improve",
            id: nextProposalId(proposalsDir(deps.factoryHome, repoId), now.toISOString().slice(0, 10), "improve", undefined, aspect),
            repo: repoId,
            created_at: now.toISOString(),
            proposals: freshSlots.map((s) => proposalDraft(aspect, s)),
            signals: input.signals,
            metrics: input.metrics,
          })
        : null;
      let issues: ImproveIssue[] = [];
      let error: string | null = null;
      let owned: ProposalItem[] = [];
      let updated: Proposal[] = [];
      if (!dryRun) {
        const published = await publishSlots(deps.github, repoDir, deps.factoryHome, repoId, aspect, slots, ticket, openIssues, issuesComplete, input.signals, input.metrics);
        issues = published.issues;
        error = published.error;
        owned = published.owned;
        updated = latestById(published.updated);
        ticket = published.fresh;
      }
      const reported = ticket ?? (updated.length === 1 ? updated[0]! : null);
      if (!error) {
        const linked = dryRun ? (ticket?.proposals ?? []) : owned;
        if (!dryRun) for (const p of linked) if (p.issue) replaceOpenMatches(deps.factoryHome, repoId, p, now);
        markFindingsProposed(deps.factoryHome, repoId, new Map(linked.flatMap((p) => p.references.findings.map((k) => [k, p.id] as const))));
      }
      results.push({ aspect, signals: input.signals, ticket: reported, path: reported ? join(proposalsDir(deps.factoryHome, repoId), `${reported.id}.json`) : null, rejected, issues, error });
    } finally {
      shot.close();
    }
  }
  const failed = results.find((r) => r.error);
  return blank(now, repoId, { aspects, warnings: resolved.warnings, dry_run: dryRun, lifecycle, compaction, results, error: failed?.error ?? null });
}

export async function improveCommand(opts: ImproveOptions & { json: boolean }, deps: ImproveDeps, io: Io): Promise<number> {
  const r = await improve(opts, deps);
  for (const w of r.warnings) io.err(`factory: ${w}\n`);
  if (opts.json) io.out(JSON.stringify(r) + "\n");
  else {
    for (const c of r.lifecycle) io.out(`proposal ${c.id}: ${c.status} (${c.reason})\n`);
    if (r.compaction.merged || r.compaction.error) io.out(`compaction: ${r.compaction.merged} merged${r.compaction.error ? `; ${r.compaction.error}` : ""}\n`);
    if (r.dry_run) io.out("dry-run: proposal files only, no issues\n");
    for (const result of r.results) {
      if (result.ticket) {
        io.out(`aspect ${result.aspect}: ticket ${result.path}: ${result.ticket.proposals.length} proposal(s)\n`);
        for (const p of result.ticket.proposals) {
          const issue = result.issues.find((i) => i.proposal_id === p.id);
          io.out(`  ${p.rank}. ${p.plan.goal}${issue ? ` (#${issue.number} ${issue.action})` : ""}\n`);
        }
        for (const issue of result.issues) {
          if (result.ticket.proposals.some((p) => p.id === issue.proposal_id)) continue;
          io.out(`  ${issue.proposal_id} (#${issue.number} ${issue.action})\n`);
        }
        for (const x of result.rejected) io.out(`  rejected: ${x}\n`);
        if (result.error) io.out(`  ${result.error}\n`);
      } else if (result.issues.length) {
        io.out(`aspect ${result.aspect}: ${result.issues.length} existing proposal(s) updated\n`);
        for (const issue of result.issues) io.out(`  ${issue.proposal_id} (#${issue.number} ${issue.action})\n`);
        for (const x of result.rejected) io.out(`  rejected: ${x}\n`);
        if (result.error) io.out(`  ${result.error}\n`);
      } else io.out(result.error ? `aspect ${result.aspect}: no proposal: ${result.error}\n` : `aspect ${result.aspect}: no proposal: no signals\n`);
    }
    if (r.error && !r.results.some((result) => result.error === r.error)) io.out(`no proposal: ${r.error}\n`);
  }
  return r.error ? 1 : 0;
}

/** `factory harden`: deprecation note, then improve with the findings aspect. */
export async function hardenAlias(opts: { repo: string; compact: boolean; max?: number; json: boolean }, deps: ImproveDeps, io: Io): Promise<number> {
  io.err(HARDEN_DEPRECATION);
  return improveCommand({ repo: opts.repo, aspects: ["findings"], compact: opts.compact, json: opts.json, force: true, ...(opts.max ? { max: opts.max } : {}) }, deps, io);
}

/** `factory audit`: deprecation note, then improve with the mapped aspect. */
export async function auditAlias(opts: { repo: string; type: AuditType; max?: number; json: boolean }, deps: ImproveDeps, io: Io): Promise<number> {
  const aspect = AUDIT_ASPECT[opts.type];
  io.err(auditDeprecation(aspect));
  return improveCommand({ repo: opts.repo, aspects: [aspect], compact: false, json: opts.json, ...(opts.max ? { max: opts.max } : {}) }, deps, io);
}


