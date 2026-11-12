import { createHash } from "node:crypto";
import { FACTORY_PROPOSAL_LABEL } from "../improve/issues.js";
import { FACTORY_READY_LABEL, NEEDS_PLAN_LABEL } from "./store.js";

/** Issue needs a human decision before a coding run. */
export const NEEDS_DECISION_LABEL = "needs-decision";

/** A normal ticket waiting at least this long starts ahead of a newer higher-priority one. */
export const FAIR_WAIT_MS = 24 * 60 * 60 * 1000;

const BUNDLE_REF = /factory-bundle:\s*#(\d+)/g;
const FULFILLS_REF = /fulfills #(\d+)/g;

export interface AdmitIssue {
  state?: "open" | "closed";
  labels: string[];
  title?: string;
  body?: string;
}

/**
 * Why this issue must not be started, or undefined when it may run.
 * The wording matches `queue add` (`#N ` + this text).
 */
export function admissionBlock(issue: AdmitIssue): string | undefined {
  if ((issue.state ?? "open") === "closed") return "is closed";
  if (!issue.labels.includes(FACTORY_READY_LABEL)) return `lacks the ${FACTORY_READY_LABEL} label`;
  if (issue.labels.includes(NEEDS_PLAN_LABEL)) return `carries ${NEEDS_PLAN_LABEL}`;
  if (issue.labels.includes(NEEDS_DECISION_LABEL)) return `carries ${NEEDS_DECISION_LABEL}`;
  if (issue.labels.includes(FACTORY_PROPOSAL_LABEL)) return `carries ${FACTORY_PROPOSAL_LABEL}`;
  if (!issue.title?.trim() || !issue.body?.trim()) return "task is not sufficient";
  return undefined;
}

/** `priority:high` is 2, `priority:low` is 0, anything else is normal (1). */
export function priorityRank(labels: string[]): number {
  if (labels.includes("priority:high")) return 2;
  if (labels.includes("priority:low")) return 0;
  return 1;
}

/** Hash of the title and body. A change means a saved plan is no longer the same task. */
export function issueRevision(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`).digest("hex").slice(0, 16);
}

export interface RankItem {
  issue: number;
  addedAt: string;
  /** Position in the queue file. Ties keep that order. */
  index: number;
  priority: number;
}

function priorityName(priority: number): string {
  if (priority >= 2) return "high";
  if (priority <= 0) return "low";
  return "normal";
}

/**
 * Start order without a model call. A ticket waiting {@link FAIR_WAIT_MS} goes first (oldest first).
 * Otherwise higher priority, then older `addedAt`, then the queue-file index.
 */
export function rankPending(items: RankItem[], nowMs: number): { issue: number; choice: string }[] {
  const ageMs = (item: RankItem) => nowMs - Date.parse(item.addedAt);
  const starved = (item: RankItem) => Number.isFinite(ageMs(item)) && ageMs(item) >= FAIR_WAIT_MS;
  const byAge = (a: RankItem, b: RankItem) => a.addedAt.localeCompare(b.addedAt) || a.index - b.index;
  const fair = items.filter(starved).sort(byAge);
  const rest = items.filter((item) => !starved(item)).sort((a, b) => b.priority - a.priority || byAge(a, b));
  return [...fair, ...rest].map((item) => {
    const hours = Number.isFinite(ageMs(item)) ? Math.max(0, Math.floor(ageMs(item) / 3_600_000)) : 0;
    const note = starved(item) ? ", fair wait" : "";
    return { issue: item.issue, choice: `priority ${priorityName(item.priority)}, waiting ${hours}h${note}` };
  });
}

export interface AfterLink {
  issue: number;
  after?: number;
  status: string;
}

/**
 * Pending issues whose `after` links form a cycle. The reason names the cycle.
 * Acyclic waits are not included; the caller keeps those pending.
 */
export function cycleReasons(entries: AfterLink[]): Map<number, string> {
  const byIssue = new Map(entries.map((e) => [e.issue, e]));
  const out = new Map<number, string>();
  const color = new Map<number, 0 | 1 | 2>();
  const walk = (n: number, stack: number[]): void => {
    if (out.has(n) || color.get(n) === 2) return;
    if (color.get(n) === 1) {
      const at = stack.indexOf(n);
      const cycle = [...stack.slice(at), n];
      const reason = `dependency cycle: ${cycle.map((x) => `#${x}`).join(" -> ")}`;
      for (const x of cycle.slice(0, -1)) out.set(x, reason);
      return;
    }
    color.set(n, 1);
    const after = byIssue.get(n)?.after;
    if (after !== undefined && byIssue.has(after)) walk(after, [...stack, n]);
    color.set(n, 2);
  };
  for (const entry of entries) {
    if (entry.status === "pending" && entry.after !== undefined) walk(entry.issue, []);
  }
  return out;
}

function bundleRefs(body: string): number[] {
  return [...body.matchAll(BUNDLE_REF)].map((m) => Number(m[1]));
}

/**
 * Issues that name each other with `factory-bundle: #N`. A one-way mention is not a bundle.
 * File overlap is not considered here.
 */
export function mutualBundle(issues: { number: number; body: string }[], issue: number): number[] {
  const byNumber = new Map(issues.map((row) => [row.number, row]));
  const self = byNumber.get(issue);
  if (!self) return [];
  const out: number[] = [];
  for (const n of bundleRefs(self.body)) {
    if (n === issue || out.includes(n)) continue;
    const other = byNumber.get(n);
    if (!other) continue;
    if (bundleRefs(other.body).includes(issue)) out.push(n);
  }
  return out;
}

export interface FulfillPlan {
  acceptance: { id: string; text: string }[];
}

/** Issue numbers named by evidenced acceptance lines (`fulfills #N`). */
export function fulfilledIssues(plan: FulfillPlan, evidencedIds: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (const row of plan.acceptance) {
    if (!evidencedIds.has(row.id)) continue;
    for (const match of row.text.matchAll(FULFILLS_REF)) {
      const n = Number(match[1]);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** `Closes` lines for the primary issue plus evidenced bundle extras. Empty unless the run is done. */
export function closesFooter(primary: number | undefined, result: string, extras: number[]): string {
  if (primary === undefined || result !== "done") return "";
  const nums = [primary, ...extras.filter((n) => n !== primary)];
  return `\n${nums.map((n) => `Closes #${n}`).join("\n")}\n`;
}

/** A branch update that cannot be retried: the PR does not apply cleanly. */
export function updateNeedsDecision(message: string): boolean {
  return /conflict|not mergeable/i.test(message);
}
