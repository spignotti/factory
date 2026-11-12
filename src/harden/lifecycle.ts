import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub } from "../gh.js";
import { updateMemory } from "../memory.js";
import { listProposals, saveProposal } from "../proposals.js";
import type { RunRecord } from "../runs.js";
import { type ProposalItem, STALE_DAYS } from "../schemas/proposal.js";

export type EffectStatus = "confirmed" | "negative" | "unclear";

export interface LifecycleChange {
  id: string;
  status: "resolved" | "dropped";
  reason: string;
  pr: string | null;
  /** Set when a merged PR implemented the proposal. Confirmed only when its effect checks passed. */
  effect?: EffectStatus;
}

/** A merged PR is a proven improvement only when the proposal's effect checks passed. */
export function provenImprovement(effect: EffectStatus | undefined): boolean {
  return effect === "confirmed";
}

export function formatLifecycle(c: Pick<LifecycleChange, "id" | "status" | "reason" | "effect">): string {
  if (c.status === "resolved" && c.effect) {
    const proof = provenImprovement(c.effect) ? "effect confirmed" : "not a proven improvement";
    return `proposal ${c.id}: implemented (${c.reason}; effect ${c.effect}; ${proof})\n`;
  }
  return `proposal ${c.id}: ${c.status} (${c.reason})\n`;
}

/** Names written as `effect check: <name>` in acceptance text. No name means the effect is unclear. */
export function effectCheckNames(plan: { acceptance?: readonly { text: string }[] }): string[] {
  const names = new Set<string>();
  for (const item of plan.acceptance ?? []) {
    for (const match of item.text.matchAll(/\beffect check:\s*([A-Za-z0-9_-]+)/g)) names.add(match[1]!);
  }
  return [...names];
}

export function effectStatus(plan: { acceptance?: readonly { text: string }[] }, checks: readonly { name: string; status: string }[] | null): EffectStatus {
  const names = effectCheckNames(plan);
  if (names.length === 0 || checks === null) return "unclear";
  const byName = new Map(checks.map((check) => [check.name, check.status]));
  if (names.some((name) => !byName.has(name))) return "unclear";
  if (names.some((name) => byName.get(name) !== "pass")) return "negative";
  return "confirmed";
}

function latestGateChecks(dir: string): { name: string; status: string }[] | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { n: number; checks: { name: string; status: string }[] } | null = null;
  for (const name of names) {
    const match = /^gates-(\d+)\.json$/.exec(name);
    if (!match) continue;
    let report: { n?: number; checks?: { name: string; status: string }[] };
    try {
      report = JSON.parse(readFileSync(join(dir, name), "utf8")) as { n?: number; checks?: { name: string; status: string }[] };
    } catch {
      continue;
    }
    const n = typeof report.n === "number" ? report.n : Number(match[1]);
    if (!best || n >= best.n) best = { n, checks: report.checks ?? [] };
  }
  return best?.checks ?? null;
}

function runPlan(run: RunRecord): { goal?: string; resolves_findings?: string[] } | undefined {
  const path = join(run.dir, "plan.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { goal?: string; resolves_findings?: string[] };
  } catch {
    return undefined;
  }
}

/**
 * Runs that worked on a proposal: started after its ticket and run from its plan file, or carrying its goal,
 * or resolving one of its findings (keys are disjoint across the proposals of a ticket).
 * A run on the proposal's issue counts even when it started earlier. A later improve keeps that issue,
 * and the merged PR still closes it.
 */
export function runsFor(p: ProposalItem, createdAt: string, runs: RunRecord[]): RunRecord[] {
  const created = Date.parse(createdAt);
  const refs = new Set(p.references.findings);
  return runs.filter((r) => {
    if (p.issue && (r.state?.task?.issue === p.issue || r.result?.task === `#${p.issue}`)) return true;
    if (r.started_at.getTime() < created) return false;
    if (r.state?.task?.ref && resolve(r.state.task.ref) === resolve(p.plan_path)) return true;
    const plan = runPlan(r);
    if (!plan) return false;
    return plan.goal === p.plan.goal || (plan.resolves_findings ?? []).some((k) => refs.has(k));
  });
}

/**
 * Lifecycle of earlier proposals, each on its own: a merged factory PR resolves the proposal and its
 * entries. That includes a PR which closes the proposal's issue, whatever the run's start time.
 * An improve issue closed without that PR, a PR closed unmerged, or no merged/open PR within
 * `STALE_DAYS`, drops it and reopens its `proposed` entries (only those it still owns: `ref` = its id).
 * A `gh` error while reading the issue is unknown: the proposal stays as it is, and is not dropped.
 */
export async function resolveProposals(opts: { factoryHome: string; repoId: string; repoDir: string; runs: RunRecord[]; github: GitHub; now: Date }): Promise<LifecycleChange[]> {
  const changes: LifecycleChange[] = [];
  for (const ticket of listProposals(opts.factoryHome, opts.repoId)) {
    let dirty = false;
    const proposals: ProposalItem[] = [];
    for (const p of ticket.proposals) {
      const change = p.status === "open" ? await decide(p, ticket.created_at, opts) : undefined;
      if (!change) {
        proposals.push(p);
        continue;
      }
      dirty = true;
      const refs = new Set(p.references.findings);
      updateMemory(opts.factoryHome, opts.repoId, (mem) => {
        for (const e of mem.entries) {
          if (!refs.has(e.key) || e.status !== "proposed" || e.ref !== p.id) continue;
          if (change.status === "resolved") {
            e.status = "resolved";
            e.ref = change.pr;
          } else {
            e.status = "open";
            e.ref = null;
          }
        }
      });
      proposals.push({
        ...p,
        status: change.status,
        resolution: {
          at: opts.now.toISOString(),
          status: change.status,
          reason: change.reason,
          run_id: change.run_id,
          pr: change.pr,
          ...(change.effect ? { effect: change.effect } : {}),
        },
      });
      changes.push({ id: change.id, status: change.status, reason: change.reason, pr: change.pr, ...(change.effect ? { effect: change.effect } : {}) });
    }
    if (dirty) saveProposal(opts.factoryHome, { ...ticket, proposals });
  }
  return changes;
}

async function decide(
  p: ProposalItem,
  createdAt: string,
  opts: { repoDir: string; runs: RunRecord[]; github: GitHub; now: Date },
): Promise<(LifecycleChange & { run_id: string | null }) | undefined> {
  const prs: { pr: string; run_id: string; state: string; dir: string }[] = [];
  for (const r of runsFor(p, createdAt, opts.runs)) {
    const pr = r.result?.pr;
    if (!pr || prs.some((x) => x.pr === pr)) continue;
    const state = await opts.github.prStatus(opts.repoDir, pr).then((s) => s.state, () => "unknown");
    prs.push({ pr, run_id: r.run_id, state, dir: r.dir });
  }
  const merged = prs.find((x) => x.state === "merged");
  const ageDays = (opts.now.getTime() - Date.parse(createdAt)) / 86_400_000;
  if (merged) {
    return {
      id: p.id,
      status: "resolved",
      reason: "factory PR merged",
      pr: merged.pr,
      run_id: merged.run_id,
      effect: effectStatus(p.plan, latestGateChecks(merged.dir)),
    };
  }
  if (p.issue) {
    // A failed read is unknown, not closed. Do not drop, and do not fall through to the stale drop.
    const issue = await opts.github.getIssue(opts.repoDir, p.issue).then(
      (found) => found,
      () => undefined,
    );
    if (issue === undefined) return undefined;
    if (issue.state === "closed") {
      return { id: p.id, status: "dropped", reason: "issue closed without merged PR", pr: prs.at(-1)?.pr ?? null, run_id: prs.at(-1)?.run_id ?? null };
    }
  }
  if (prs.length && prs.every((x) => x.state === "closed")) return { id: p.id, status: "dropped", reason: "factory PR closed without merge", pr: prs.at(-1)!.pr, run_id: prs.at(-1)!.run_id };
  if (!prs.some((x) => x.state === "open" || x.state === "unknown") && ageDays > STALE_DAYS) {
    return { id: p.id, status: "dropped", reason: `no merged factory PR within ${STALE_DAYS} days`, pr: null, run_id: null };
  }
  return undefined;
}
