import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHub } from "../gh.js";
import { updateMemory } from "../memory.js";
import { listProposals, saveProposal } from "../proposals.js";
import type { RunRecord } from "../runs.js";
import { type ProposalItem, STALE_DAYS } from "../schemas/proposal.js";

export interface LifecycleChange {
  id: string;
  status: "resolved" | "dropped";
  reason: string;
  pr: string | null;
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
 */
export function runsFor(p: ProposalItem, createdAt: string, runs: RunRecord[]): RunRecord[] {
  const created = Date.parse(createdAt);
  const refs = new Set(p.references.findings);
  return runs.filter((r) => {
    if (r.started_at.getTime() < created) return false;
    if (r.state?.task?.ref && resolve(r.state.task.ref) === resolve(p.plan_path)) return true;
    const plan = runPlan(r);
    if (!plan) return false;
    return plan.goal === p.plan.goal || (plan.resolves_findings ?? []).some((k) => refs.has(k));
  });
}

/**
 * Lifecycle of earlier proposals, each on its own: a merged factory PR resolves the proposal and its
 * entries; a PR closed unmerged, or no merged/open PR within `STALE_DAYS`, drops it and reopens its
 * `proposed` entries (only those it still owns: `ref` = its id).
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
      proposals.push({ ...p, status: change.status, resolution: { at: opts.now.toISOString(), status: change.status, reason: change.reason, run_id: change.run_id, pr: change.pr } });
      changes.push({ id: change.id, status: change.status, reason: change.reason, pr: change.pr });
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
  const prs: { pr: string; run_id: string; state: string }[] = [];
  for (const r of runsFor(p, createdAt, opts.runs)) {
    const pr = r.result?.pr;
    if (!pr || prs.some((x) => x.pr === pr)) continue;
    const state = await opts.github.prStatus(opts.repoDir, pr).then((s) => s.state, () => "unknown");
    prs.push({ pr, run_id: r.run_id, state });
  }
  const merged = prs.find((x) => x.state === "merged");
  const ageDays = (opts.now.getTime() - Date.parse(createdAt)) / 86_400_000;
  if (merged) return { id: p.id, status: "resolved", reason: "factory PR merged", pr: merged.pr, run_id: merged.run_id };
  if (prs.length && prs.every((x) => x.state === "closed")) return { id: p.id, status: "dropped", reason: "factory PR closed without merge", pr: prs.at(-1)!.pr, run_id: prs.at(-1)!.run_id };
  if (!prs.some((x) => x.state === "open" || x.state === "unknown") && ageDays > STALE_DAYS) {
    return { id: p.id, status: "dropped", reason: `no merged factory PR within ${STALE_DAYS} days`, pr: null, run_id: null };
  }
  return undefined;
}
