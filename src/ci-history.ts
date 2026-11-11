/**
 * Paged workflow-run history for `factory improve` (`ci`, `tests`).
 * List rows use the verified `gh run list --json` shape. `headBranch` is extra (UNVERIFIED).
 * Pages come from the Actions runs API because `gh run list` has no page flag (UNVERIFIED).
 */

export const CI_PAGE_SIZE = 100;
/** 30 pages cover a busy month (800+ runs) and stop a pathological repo. */
export const CI_MAX_PAGES = 30;

export interface RunListRow {
  id: number;
  sha: string;
  workflow: string;
  event: string;
  conclusion: string | null;
  created_at: string;
  head_branch: string | null;
}

export interface ParsedJob {
  name: string;
  conclusion: string | null;
  seconds: number | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One page of `gh run list --json databaseId,headSha,workflowName,event,conclusion,createdAt,headBranch`. */
export function parseRunList(raw: unknown): RunListRow[] {
  if (!Array.isArray(raw)) throw new Error("gh run list was not a JSON array");
  const out: RunListRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.databaseId === "number" ? row.databaseId : typeof row.id === "number" ? row.id : undefined;
    const sha = str(row.headSha) || str(row.head_sha);
    const workflow = str(row.workflowName) || str(row.workflow_name) || str(row.name);
    const created = str(row.createdAt) || str(row.created_at);
    if (id === undefined || !sha || !workflow || !created) continue;
    const branch = str(row.headBranch) || str(row.head_branch);
    out.push({
      id,
      sha,
      workflow,
      event: str(row.event) || "unknown",
      conclusion: str(row.conclusion) || null,
      created_at: created,
      head_branch: branch || null,
    });
  }
  return out;
}

/** `gh run view --json jobs`: name, conclusion, startedAt, completedAt. */
export function parseRunView(raw: unknown): ParsedJob[] {
  const jobs = raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs) ? (raw as { jobs: unknown[] }).jobs : [];
  const out: ParsedJob[] = [];
  for (const item of jobs) {
    if (!item || typeof item !== "object") continue;
    const job = item as Record<string, unknown>;
    const name = str(job.name);
    if (!name) continue;
    const started = str(job.startedAt) || str(job.started_at) || null;
    const completed = str(job.completedAt) || str(job.completed_at) || null;
    out.push({ name, conclusion: str(job.conclusion) || null, seconds: jobSeconds(started, completed) });
  }
  return out;
}

export function jobSeconds(started: string | null, completed: string | null): number | null {
  if (!started || !completed) return null;
  const ms = Date.parse(completed) - Date.parse(started);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/**
 * Concatenate list pages. A short page ends the window. A full page at the cap is truncated:
 * older runs in the window were not read.
 */
export function foldRunListPages(pages: unknown[], perPage: number, maxPages: number): { rows: RunListRow[]; truncated: boolean } {
  const rows: RunListRow[] = [];
  const seen = new Set<number>();
  const limited = pages.slice(0, maxPages);
  for (let i = 0; i < limited.length; i++) {
    const batch = parseRunList(limited[i]);
    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (batch.length < perPage) return { rows, truncated: false };
    if (i + 1 === maxPages) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}

/** Fetch pages until a short one or the cap. `fetchPage` returns one `gh run list` JSON array. */
export async function paginateRunList(
  fetchPage: (page: number, perPage: number) => Promise<unknown>,
  opts?: { perPage?: number; maxPages?: number },
): Promise<{ rows: RunListRow[]; truncated: boolean }> {
  const perPage = opts?.perPage ?? CI_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? CI_MAX_PAGES;
  const pages: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchPage(page, perPage);
    pages.push(raw);
    if (parseRunList(raw).length < perPage) break;
  }
  return foldRunListPages(pages, perPage, maxPages);
}

/**
 * One Actions runs page, jq'd into the `gh run list --json` shape.
 * UNVERIFIED: live `gh api` paging and `head_branch`.
 */
export function ciRunListArgs(sinceDay: string, page: number, perPage: number): string[] {
  const created = encodeURIComponent(`>=${sinceDay}`);
  return [
    "api",
    "--method",
    "GET",
    `repos/{owner}/{repo}/actions/runs?per_page=${perPage}&page=${page}&created=${created}`,
    "--jq",
    "[.workflow_runs[] | {databaseId: .id, headSha: .head_sha, workflowName: .name, event: .event, conclusion: .conclusion, createdAt: .created_at, headBranch: .head_branch}]",
  ];
}

export function ciRunViewArgs(id: number): string[] {
  return ["run", "view", String(id), "--json", "jobs"];
}
