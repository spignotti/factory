/**
 * Paged workflow-run history for `factory improve` (`ci`, `tests`).
 * List rows use the verified `gh run list --json` shape. `headBranch` is extra (UNVERIFIED).
 * Pages come from the Actions runs API because `gh run list` has no page flag (UNVERIFIED).
 */

export const CI_PAGE_SIZE = 100;
/**
 * Actions returns at most 1000 workflow runs. Page 11 (`per_page` 100) is HTTP 422, not a short page.
 * Stop at 10 pages so that cap cannot fail the aspect.
 */
export const CI_MAX_PAGES = 10;

export interface RunListRow {
  id: number;
  sha: string;
  /** Workflow file path when the runs API sent `path`; otherwise the workflow name (`gh run list` `workflowName`). Never the run name. */
  workflow: string;
  /** Workflow file path (`.github/workflows/ci.yml`). Null on the `gh run list` shape, which has no path. */
  path: string | null;
  event: string;
  conclusion: string | null;
  created_at: string;
  head_branch: string | null;
}

export interface ParsedStep {
  name: string;
  conclusion: string | null;
  seconds: number | null;
}

export interface ParsedJob {
  name: string;
  conclusion: string | null;
  seconds: number | null;
  /** Empty when the view omitted steps. UNVERIFIED: live `gh run view` step timestamps. */
  steps: ParsedStep[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Workflow path as the runs API returns it (`./` and backslashes stripped). */
export function normalizeWorkflowPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * One page of `gh run list --json databaseId,headSha,workflowName,...` or the runs-API jq shape (`path`, not `.name`).
 * `.name` on a workflow run is the run name (`run-name`, else the workflow name). It is not an identity.
 */
export function parseRunList(raw: unknown): RunListRow[] {
  if (!Array.isArray(raw)) throw new Error("gh run list was not a JSON array");
  const out: RunListRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.databaseId === "number" ? row.databaseId : typeof row.id === "number" ? row.id : undefined;
    const sha = str(row.headSha) || str(row.head_sha);
    const path = normalizeWorkflowPath(str(row.path));
    // `workflowName` is the workflow name on `gh run list`. Do not fall back to `.name` (the run name).
    const listed = str(row.workflowName) || str(row.workflow_name);
    const workflow = path || listed;
    const created = str(row.createdAt) || str(row.created_at);
    if (id === undefined || !sha || !workflow || !created) continue;
    const branch = str(row.headBranch) || str(row.head_branch);
    out.push({
      id,
      sha,
      workflow,
      path: path || null,
      event: str(row.event) || "unknown",
      conclusion: str(row.conclusion) || null,
      created_at: created,
      head_branch: branch || null,
    });
  }
  return out;
}

/** Workflow `name` for a path, from the workflows API (or `gh run list` `workflowName` when there is no path). */
export function resolveRunWorkflow(row: RunListRow, names: ReadonlyMap<string, string>): { workflow: string; path: string | null } {
  if (!row.path) return { path: null, workflow: row.workflow };
  const path = normalizeWorkflowPath(row.path);
  return { path, workflow: names.get(path) || path };
}

/** `GET /repos/{owner}/{repo}/actions/workflows` page. `.name` here is the workflow name, not a run name. */
export function parseWorkflowNames(raw: unknown): { name: string; path: string }[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { workflows?: unknown }).workflows)
      ? (raw as { workflows: unknown[] }).workflows
      : [];
  const out: { name: string; path: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = str(row.name);
    const path = normalizeWorkflowPath(str(row.path));
    if (!name || !path) continue;
    out.push({ name, path });
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
    out.push({ name, conclusion: str(job.conclusion) || null, seconds: jobSeconds(started, completed), steps: parseSteps(job) });
  }
  return out;
}

function parseSteps(job: Record<string, unknown>): ParsedStep[] {
  if (!Array.isArray(job.steps)) return [];
  const out: ParsedStep[] = [];
  for (const item of job.steps) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const name = str(step.name);
    if (!name) continue;
    const started = str(step.startedAt) || str(step.started_at) || null;
    const completed = str(step.completedAt) || str(step.completed_at) || null;
    out.push({ name, conclusion: str(step.conclusion) || null, seconds: jobSeconds(started, completed) });
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
  const maxPages = Math.min(opts?.maxPages ?? CI_MAX_PAGES, CI_MAX_PAGES);
  const pages: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let raw: unknown;
    try {
      raw = await fetchPage(page, perPage);
    } catch (e) {
      // Page 11 is HTTP 422 once 1000 runs are listed. Keep the pages already read.
      if (pages.length > 0 && isActionsRunPageCap(e)) {
        const folded = foldRunListPages(pages, perPage, pages.length);
        return { rows: folded.rows, truncated: true };
      }
      throw e;
    }
    pages.push(raw);
    if (parseRunList(raw).length < perPage) break;
  }
  return foldRunListPages(pages, perPage, maxPages);
}

/** True when a runs-list page hit the Actions 1000-result cap (HTTP 422), including through `gh`'s wrapper. */
export function isActionsRunPageCap(e: unknown): boolean {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as { message?: unknown; stderr?: unknown; cause?: unknown };
    if (typeof rec.message === "string") parts.push(rec.message);
    if (typeof rec.stderr === "string") parts.push(rec.stderr);
    cur = rec.cause;
  }
  return /\b422\b/.test(parts.join("\n"));
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
    "[.workflow_runs[] | {databaseId: .id, headSha: .head_sha, path: .path, event: .event, conclusion: .conclusion, createdAt: .created_at, headBranch: .head_branch}]",
  ];
}

export function ciRunViewArgs(id: number): string[] {
  return ["run", "view", String(id), "--json", "jobs"];
}

export interface AttachedRun {
  id: number;
  sha: string;
  workflow: string;
  path: string | null;
  event: string;
  conclusion: string | null;
  created_at: string;
  head_branch: string | null;
  jobs: ParsedJob[];
}

/**
 * One `gh run view` per in-window row. A failed or unparsable view skips that run and counts it;
 * the rows already read stay. Rows before `sinceIso` are not viewed.
 */
export async function attachRunViews(
  rows: RunListRow[],
  sinceIso: string,
  names: ReadonlyMap<string, string>,
  view: (id: number) => Promise<string>,
): Promise<{ runs: AttachedRun[]; skipped: number }> {
  const runs: AttachedRun[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.created_at < sinceIso) continue;
    let jobs: ParsedJob[];
    try {
      jobs = parseRunView(JSON.parse(await view(row.id)));
    } catch {
      skipped += 1;
      continue;
    }
    const identity = resolveRunWorkflow(row, names);
    runs.push({
      id: row.id,
      sha: row.sha,
      workflow: identity.workflow,
      path: identity.path,
      event: row.event,
      conclusion: row.conclusion,
      created_at: row.created_at,
      head_branch: row.head_branch,
      jobs,
    });
  }
  return { runs, skipped };
}

/** One page of workflow names. `.name` is the workflow name; `path` is the file. */
export function ciWorkflowListArgs(page: number, perPage = CI_PAGE_SIZE): string[] {
  return ["api", "--method", "GET", `repos/{owner}/{repo}/actions/workflows?per_page=${perPage}&page=${page}`, "--jq", ".workflows"];
}
