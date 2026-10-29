import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDir } from "./memory.js";
import { type Proposal, type ProposalItem, ProposalSchema } from "./schemas/proposal.js";

export function proposalsDir(factoryHome: string, repoId: string): string {
  return join(memoryDir(factoryHome, repoId), "proposals");
}

/** Free id for a new proposal of the day: `<date>[-adopt]`, then `-2`, `-3` … */
export function nextProposalId(dir: string, date: string, kind: Proposal["kind"]): string {
  const stem = kind === "adopt" ? `${date}-adopt` : date;
  if (!existsSync(join(dir, `${stem}.json`))) return stem;
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${stem}-${n}.json`))) return `${stem}-${n}`;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export type ProposalDraft = Omit<Proposal, "proposals"> & { proposals: Omit<ProposalItem, "plan_path" | "id" | "rank">[] };

/** Writes `<id>.json` and one `<id>.<rank>.plan.json` per proposal (the plan alone, for `factory run --plan`). */
export function writeProposal(factoryHome: string, t: ProposalDraft): Proposal {
  const dir = proposalsDir(factoryHome, t.repo);
  mkdirSync(dir, { recursive: true });
  const proposals = t.proposals.map((p, i) => ({ ...p, rank: i + 1, id: `${t.id}.${i + 1}`, plan_path: join(dir, `${t.id}.${i + 1}.plan.json`) }));
  const full = ProposalSchema.parse({ ...t, proposals });
  for (const p of full.proposals) writeAtomic(p.plan_path, JSON.stringify(p.plan, null, 2) + "\n");
  writeAtomic(join(dir, `${t.id}.json`), JSON.stringify(full, null, 2) + "\n");
  return full;
}

export function saveProposal(factoryHome: string, p: Proposal): void {
  writeAtomic(join(proposalsDir(factoryHome, p.repo), `${p.id}.json`), JSON.stringify(ProposalSchema.parse(p), null, 2) + "\n");
}

/** All readable proposals of a repo, oldest first (unreadable files are skipped). */
export function listProposals(factoryHome: string, repoId: string): Proposal[] {
  const dir = proposalsDir(factoryHome, repoId);
  if (!existsSync(dir)) return [];
  const out: Proposal[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f.endsWith(".plan.json")) continue;
    try {
      const p = ProposalSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (p.success) out.push(p.data);
    } catch {
      // half-written or foreign file
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
