import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "../gh.js";
import { updateMemory } from "../memory.js";
import { listProposals, saveProposal } from "../proposals.js";
import type { RunRecord } from "../runs.js";
import { type Proposal, STALE_DAYS } from "../schemas/proposal.js";

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

/** Runs that worked on a proposal: started after it and resolving its findings or carrying its goal. */
export function runsFor(p: Proposal, runs: RunRecord[]): RunRecord[] {
  const created = Date.parse(p.created_at);
  const refs = new Set(p.references.findings);
  return runs.filter((r) => {
    if (r.started_at.getTime() < created) return false;
    const plan = runPlan(r);
    if (!plan) return false;
    return plan.goal === p.plan.goal || (plan.resolves_findings ?? []).some((k) => refs.has(k));
  });
}

/**
 * SPEC §11 step 5 for earlier proposals: a merged factory PR resolves the proposal and its entries; a PR
 * closed unmerged, or no merged PR within `STALE_DAYS`, drops it and reopens its `proposed` entries.
 */
export async function resolveProposals(opts: { factoryHome: string; repoId: string; repoDir: string; runs: RunRecord[]; github: GitHub; now: Date }): Promise<LifecycleChange[]> {
  const changes: LifecycleChange[] = [];
  for (const p of listProposals(opts.factoryHome, opts.repoId).filter((x) => x.status === "open")) {
    const related = runsFor(p, opts.runs);
    const prs: { pr: string; run_id: string; state: string }[] = [];
    for (const r of related) {
      const pr = r.result?.pr;
      if (!pr || prs.some((x) => x.pr === pr)) continue;
      const state = await opts.github.prStatus(opts.repoDir, pr).then((s) => s.state, () => "unknown");
      prs.push({ pr, run_id: r.run_id, state });
    }
    const merged = prs.find((x) => x.state === "merged");
    const ageDays = (opts.now.getTime() - Date.parse(p.created_at)) / 86_400_000;
    let change: (LifecycleChange & { run_id: string | null }) | undefined;
    if (merged) change = { id: p.id, status: "resolved", reason: "factory PR merged", pr: merged.pr, run_id: merged.run_id };
    else if (prs.length && prs.every((x) => x.state === "closed")) change = { id: p.id, status: "dropped", reason: "factory PR closed without merge", pr: prs.at(-1)!.pr, run_id: prs.at(-1)!.run_id };
    else if (!prs.some((x) => x.state === "open" || x.state === "unknown") && ageDays > STALE_DAYS) {
      change = { id: p.id, status: "dropped", reason: `no merged factory PR within ${STALE_DAYS} days`, pr: null, run_id: null };
    }
    if (!change) continue;
    const refs = new Set(p.references.findings);
    updateMemory(opts.factoryHome, opts.repoId, (mem) => {
      for (const e of mem.entries) {
        if (!refs.has(e.key) || e.status !== "proposed") continue;
        if (change.status === "resolved") {
          e.status = "resolved";
          e.ref = change.pr;
        } else {
          e.status = "open";
          e.ref = null;
        }
      }
    });
    saveProposal(opts.factoryHome, { ...p, status: change.status, resolution: { at: opts.now.toISOString(), status: change.status, reason: change.reason, run_id: change.run_id, pr: change.pr } });
    changes.push({ id: change.id, status: change.status, reason: change.reason, pr: change.pr });
  }
  return changes;
}
