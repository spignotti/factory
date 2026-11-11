import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDir } from "./memory.js";
import { type OpenAuditTicket, type Proposal, type ProposalItem, ProposalSchema } from "./schemas/proposal.js";
import type { AuditType, ImproveAspect } from "./schemas/repo.js";

export function proposalsDir(factoryHome: string, repoId: string): string {
  return join(memoryDir(factoryHome, repoId), "proposals");
}

/** Free id for a new proposal of the day: `<date>[-adopt|-audit-<type>|-improve-<aspect>]`, then `-2`, `-3` … */
export function nextProposalId(dir: string, date: string, kind: Proposal["kind"], auditType?: AuditType, aspect?: ImproveAspect): string {
  if (kind === "audit" && !auditType) throw new Error("audit proposals need a type");
  if (kind === "improve" && !aspect) throw new Error("improve proposals need an aspect");
  const stem = kind === "adopt" ? `${date}-adopt` : kind === "audit" ? `${date}-audit-${auditType}` : kind === "improve" ? `${date}-improve-${aspect}` : date;
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

/**
 * Rewrites one proposal inside its ticket and refreshes that proposal's plan file.
 * Id, rank and plan_path stay, so a run that already points at them still does.
 */
export function updateProposalItem(
  factoryHome: string,
  repoId: string,
  ticketId: string,
  item: ProposalItem,
  over: { signals?: Proposal["signals"]; metrics?: Proposal["metrics"] } = {},
): Proposal {
  const ticket = readTickets(proposalsDir(factoryHome, repoId)).find((t) => t.id === ticketId);
  if (!ticket) throw new Error(`proposal ticket ${ticketId} not found`);
  const stored = ticket.proposals.find((p) => p.id === item.id);
  if (!stored) throw new Error(`proposal ${item.id} is not in ${ticketId}`);
  const next = { ...item, rank: stored.rank, id: stored.id, plan_path: stored.plan_path };
  const full = ProposalSchema.parse({ ...ticket, ...over, proposals: ticket.proposals.map((p) => (p.id === stored.id ? next : p)) });
  const saved = full.proposals.find((p) => p.id === stored.id)!;
  writeAtomic(saved.plan_path, JSON.stringify(saved.plan, null, 2) + "\n");
  writeAtomic(join(proposalsDir(factoryHome, full.repo), `${full.id}.json`), JSON.stringify(full, null, 2) + "\n");
  return full;
}

function readTickets(dir: string): Proposal[] {
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
  return out;
}

/** All readable proposals of a repo, oldest first (unreadable files are skipped). */
export function listProposals(factoryHome: string, repoId: string): Proposal[] {
  return readTickets(proposalsDir(factoryHome, repoId)).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Every readable proposal under `$FACTORY_HOME/memory`, oldest first. */
export function listAllProposals(factoryHome: string): Proposal[] {
  const root = join(factoryHome, "memory");
  if (!existsSync(root)) return [];
  const out: Proposal[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    out.push(...readTickets(join(root, name.name, "proposals")));
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id));
}

/** Open audit proposals, optionally for one canonical repo id. */
export function openAuditTickets(factoryHome: string, repoId?: string): OpenAuditTicket[] {
  return listAllProposals(factoryHome).flatMap((t) => {
    if (t.kind !== "audit" || (repoId !== undefined && t.repo !== repoId)) return [];
    return t.proposals.flatMap((p) =>
      p.status === "open" && p.type ? [{ repo: t.repo, id: p.id, type: p.type, rank: p.rank, goal: p.plan.goal, plan_path: p.plan_path }] : [],
    );
  });
}
