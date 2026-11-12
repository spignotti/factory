import { execFileSync } from "node:child_process";
import { attachRunViews, CI_MAX_PAGES, CI_PAGE_SIZE, ciRunListArgs, ciRunViewArgs, ciWorkflowListArgs, paginateRunList, parseRunView, parseWorkflowNames } from "./ci-history.js";
import { CommandTimeoutError, execFileTimed } from "./exec.js";
import { GIT_LOCAL_TIMEOUT_MS, git } from "./git.js";
import { aggregateCheckRuns, type CheckRunView } from "./pipeline/ci-status.js";

export interface RawCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  id?: number;
  suite?: number | null;
  app?: string | null;
}

/**
 * Base CI is GitHub Actions only. Other apps (Dependabot's config validation, external services) can sit
 * in `queued` for hours and would hold every run as pending. Rows without an app slug are kept.
 */
export function actionsCheckRuns(raw: RawCheckRun[]): RawCheckRun[] {
  return raw.filter((r) => !r.app || r.app === "github-actions");
}

/** How long a run from before markReady counts as pending while its workflow may still start again. */
export const READY_GRACE_MS = 3 * 60_000;

/**
 * PR CI after markReady. A repo workflow may fail on purpose while the PR is a draft; that run stays on
 * the head SHA. A run created before `since` is dropped when the same workflow has a run created at or
 * after it; while none has appeared yet and the grace period is running, it counts as pending; after
 * that its own result stands (a workflow that does not run on ready_for_review keeps its verdict).
 * `since` is compared at whole seconds minus one (Actions timestamps have second precision, clocks skew).
 */
export function checkRunsSince(runs: CheckRunView[], since?: string, now = Date.now()): CheckRunView[] {
  if (!since) return runs;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return runs;
  const cut = Math.floor(t / 1000) * 1000 - 1000;
  const at = (r: CheckRunView) => Date.parse(r.created_at ?? r.started_at ?? "");
  const key = (r: CheckRunView) => r.workflow ?? r.name;
  const fresh = new Set(runs.filter((r) => Number.isFinite(at(r)) && at(r) >= cut).map(key));
  const out: CheckRunView[] = [];
  for (const r of runs) {
    const a = at(r);
    if (!Number.isFinite(a) || a >= cut) {
      out.push(r);
      continue;
    }
    if (fresh.has(key(r))) continue;
    if (now - t < READY_GRACE_MS) out.push({ ...r, status: "queued", conclusion: null });
    else out.push(r);
  }
  return out;
}

async function hasRemote(repoDir: string): Promise<boolean> {
  const stdout = await git(repoDir, ["remote"]);
  return stdout.trim() !== "";
}

/** `gh` calls. A hang is killed; the error names the timeout instead of waiting forever. */
export const GH_TIMEOUT_MS = 2 * 60_000;

export async function ghCommand(cwd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? GH_TIMEOUT_MS;
  try {
    const { stdout } = await execFileTimed("gh", args, { cwd, timeoutMs, maxBuffer: 16 * 1024 * 1024, env: opts?.env });
    return stdout;
  } catch (e) {
    if (e instanceof CommandTimeoutError) throw new Error(e.message, { cause: e });
    const err = e as { stderr?: string; message?: string };
    // Empty stderr must not hide `spawn gh ENOENT` or `killed by SIGKILL` on `message`.
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const detail = stderr || (err.message ?? String(e)).trim();
    throw new Error(`gh ${args[0] ?? ""} failed: ${detail}`, { cause: e });
  }
}

export type BaseStatus = "green" | "red" | "pending" | "none";

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** Absent on older fixtures: treated as open. */
  state?: "open" | "closed";
}

/** Open issues from a full pagination. `complete` is false when a later page may still exist. */
export interface OpenIssueList {
  issues: Issue[];
  complete: boolean;
}

export interface IssueWrite {
  title: string;
  body: string;
  labels?: string[];
}

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export interface PrRequest {
  repoDir: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  /** Labels to add (created if missing). */
  labels?: string[];
}

/** Everything the factory does on GitHub. Only the factory process calls it. */
export interface GitHub {
  /** `since`: ignore check runs created before this time (PR CI after markReady: the draft-hold run is not the verdict). */
  baseStatus(repoDir: string, sha: string, opts?: { since?: string }): Promise<BaseStatus>;
  getIssue(repoDir: string, n: number): Promise<Issue>;
  /** Open (or any state) issues, newest page only (`--limit 100`). Not a full set. */
  listIssues(repoDir: string, query: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]>;
  /**
   * Every open issue, no label filter, paginated. `complete` is false when a later page may exist:
   * callers must not create an issue from a partial list. `improve` matches proposal markers here,
   * including after a relabel off `factory-proposal`.
   */
  listOpenIssues(repoDir: string): Promise<OpenIssueList>;
  /** Creates a label if missing (`--force`). */
  ensureLabel(repoDir: string, spec: LabelSpec): Promise<void>;
  /** Opens an issue. Labels must already exist. */
  createIssue(repoDir: string, req: IssueWrite & { labels: string[] }): Promise<Issue>;
  /** Replaces title and body; adds labels, never removes one. */
  updateIssue(repoDir: string, n: number, req: IssueWrite): Promise<Issue>;
  /**
   * Factory PR for this issue (`factory/<n>` or `factory/<n>-*`), any state. Null when there is none.
   * Queue `--after` when the dependency is not in the queue. Open wins over merged.
   */
  findFactoryPr(repoDir: string, issue: number): Promise<FactoryPrRef | null>;
  push(repoDir: string, branch: string): Promise<void>;
  createPr(req: PrRequest): Promise<string>;
  /** Sha of `branch` on origin, null when it does not exist there. Throws when origin cannot be asked. */
  remoteBranchSha(repoDir: string, branch: string): Promise<string | null>;
  /** The open PR whose head is `branch` (same repo), null when there is none. */
  findOpenPr(repoDir: string, branch: string): Promise<OpenPr | null>;
  /**
   * Open pull requests on `factory/*` branches in this repo, with the files each one changes.
   * A finished run no longer holds a path claim; these files still block another run on the same paths.
   */
  openFactoryPrFiles(repoDir: string): Promise<OpenFactoryPr[]>;
  /** `gh pr merge --auto --squash --match-head-commit <sha>`. A later push does not match that SHA. */
  enableAutoMerge(repoDir: string, pr: string, sha: string): Promise<void>;
  /** `gh pr merge --disable-auto`. Not an error when auto-merge was not enabled. */
  disableAutoMerge(repoDir: string, pr: string): Promise<void>;
  /**
   * Commit status `factory` = success on a SHA the run verified. The required `done` job
   * fails a pull request without it, including while this process is not running.
   */
  approveHead(repoDir: string, sha: string): Promise<void>;
  /**
   * Parent SHAs of `sha`, first parent first. Null when the commit cannot be read.
   * An `update-branch` merge has the previous head as its first parent and the base as the second.
   */
  commitParents(repoDir: string, sha: string): Promise<string[] | null>;
  /** Adds a label to a PR, creating it if missing; best effort. */
  addLabel(repoDir: string, pr: string, label: string): Promise<void>;
  /** Resume: refresh title/body of the run's existing PR. */
  updatePr(repoDir: string, pr: string, update: { title: string; body: string }): Promise<void>;
  /** Resume: a draft PR whose run is now done becomes ready for review. */
  markReady(repoDir: string, pr: string): Promise<void>;
  /** A ready PR whose run is not done, or whose next push must stay cheap, becomes a draft. */
  markDraft(repoDir: string, pr: string): Promise<void>;
  /** `status` / `gc`: current state of a factory PR. */
  prStatus(repoDir: string, pr: string): Promise<PrStatus>;
  /**
   * Merge the base into an open PR (`gh pr update-branch`, no `--rebase`). Never a force-push.
   * Queue worker: a `done` factory PR that is `BEHIND`. The new head is a different commit; auto-merge
   * stays off until that head is approved again and CI passes on it.
   */
  updateBranch(repoDir: string, pr: string): Promise<void>;
  /** `doctor`: is `gh` logged in (no token is read or printed)? */
  authenticated(repoDir: string): Promise<boolean>;
  /** `doctor` hints; readable without admin rights. Unknown values are null. */
  repoSettings(repoDir: string, branch: string): Promise<RepoSettings>;
  /** `harden` CI audit: workflow runs created since `since` (ISO date), newest first, with their jobs; at most `limit`. */
  ciRuns(repoDir: string, since: string, limit: number): Promise<CiRun[]>;
  /**
   * improve `ci` / `tests`: every workflow run in the window, newest first.
   * At most 1000 runs (10 pages). `truncated` when the page cap or an HTTP 422 stopped the list.
   * A failed `gh run view` skips that run (`skipped`) and keeps the rest. Workflow identity is the
   * file path, named from the workflows API, never the run name.
   */
  ciRunsInWindow(repoDir: string, since: string): Promise<{ runs: CiRun[]; truncated: boolean; skipped: number }>;
  /** `harden`: newest release tag of the factory itself (`owner/repo`), null when there is none. */
  latestTag(repoDir: string, ownerRepo: string): Promise<string | null>;
}

export interface CiJob {
  name: string;
  /** success | failure | cancelled | skipped | … ; null while running. */
  conclusion: string | null;
  seconds: number | null;
  /** Present when `gh run view` included steps. */
  steps?: { name: string; conclusion: string | null; seconds: number | null }[];
}

export interface CiRun {
  id: number;
  sha: string;
  workflow: string;
  event: string;
  conclusion: string | null;
  created_at: string;
  /** Branch or tag. Absent when the list did not include `headBranch`. */
  head_branch?: string | null;
  /** Workflow file path when the runs API provided it. */
  path?: string | null;
  jobs: CiJob[];
}

/** Highest `v<semver>`-like tag (numeric compare), else null. */
export function newestTag(tags: string[]): string | null {
  const parse = (t: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number);
  const valid = tags.filter((t) => parse(t));
  valid.sort((a, b) => {
    const x = parse(a)!;
    const y = parse(b)!;
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  return valid.at(-1) ?? null;
}

export interface RepoSettings {
  private: boolean | null;
  auto_merge_allowed: boolean | null;
  branch_protected: boolean | null;
  required_checks: string[] | null;
  /**
   * `required_status_checks.strict`. Null when the branch is unprotected or the field was not readable.
   * UNVERIFIED: live GitHub response shape (see docs/VERIFY.md).
   */
  strict_required_checks?: boolean | null;
  /** GitHub secret scanning. Null when the API omits `security_and_analysis` (non-admin tokens). UNVERIFIED. */
  secret_scanning?: boolean | null;
  /** Push protection for secrets. Null when not readable. UNVERIFIED. */
  push_protection?: boolean | null;
  error?: string;
}

export interface OpenPr {
  url: string;
  draft: boolean;
  /** Head commit as GitHub sees it. */
  headSha: string | null;
}

/** An open PR on a `factory/*` branch, and the files it changes. */
export interface OpenFactoryPr {
  number: number;
  /** Head branch (`factory/…`). */
  branch: string;
  files: string[];
  /** Absent when the list payload had no `isDraft` (older callers). */
  draft?: boolean;
  /** Newest of the head commit time and `updatedAt`. Absent when neither was listed. */
  headChangedAt?: string;
}

function filePaths(files: unknown): string[] {
  const rows = Array.isArray(files) ? files : files && typeof files === "object" && Array.isArray((files as { nodes?: unknown }).nodes) ? (files as { nodes: unknown[] }).nodes : [];
  const out: string[] = [];
  for (const file of rows) {
    if (typeof file === "string" && file) out.push(file);
    else if (file && typeof file === "object") {
      const path = (file as { path?: unknown; filename?: unknown }).path ?? (file as { filename?: unknown }).filename;
      if (typeof path === "string" && path) out.push(path);
    }
  }
  return out;
}

/** `gh pr list` page size for the overlap check. Hitting it means the page is not the full open set. */
export const OPEN_FACTORY_PR_LIMIT = 1000;

/** The open-PR list filled the page, so a later factory PR may be missing. Not a clearance. */
export class IncompletePrListError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`open PR list hit the limit (${limit}); refusing to treat it as complete`);
    this.name = "IncompletePrListError";
    this.limit = limit;
  }
}

export function openFactoryPrListArgs(limit = OPEN_FACTORY_PR_LIMIT): string[] {
  return ["pr", "list", "--state", "open", "--limit", String(limit), "--json", "number,headRefName,isCrossRepository,isDraft,updatedAt,files"];
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Latest head commit time. `commits` may be a list or `{ nodes: [...] }`. */
function latestCommitAt(commits: unknown): string | undefined {
  const rows = Array.isArray(commits) ? commits : commits && typeof commits === "object" && Array.isArray((commits as { nodes?: unknown }).nodes) ? (commits as { nodes: unknown[] }).nodes : [];
  let best = 0;
  let iso: string | undefined;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = (row as { committedDate?: unknown; committed_date?: unknown }).committedDate ?? (row as { committed_date?: unknown }).committed_date;
    const at = isoDate(raw);
    if (!at) continue;
    const t = Date.parse(at);
    if (t >= best) {
      best = t;
      iso = at;
    }
  }
  return iso;
}

/** Later of two ISO timestamps. Either side may be absent. */
function newerIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * `gh pr list --json number,headRefName,isCrossRepository,isDraft,updatedAt,files`. No `commits`: with
 * `files` it exceeds GitHub's GraphQL node limit; `updatedAt` moves on every push. Commits are still read when present.
 * Keeps same-repo `factory/*` heads. `files` and `commits` may be a flat list or `{ nodes: [...] }`.
 * A payload that is not an array, or that fills `limit`, is incomplete: callers must block, not treat it as every open PR.
 */
export function readOpenFactoryPrs(payload: unknown, limit = OPEN_FACTORY_PR_LIMIT): OpenFactoryPr[] {
  if (!Array.isArray(payload)) throw new Error("open PR list was not a JSON array");
  if (payload.length >= limit) throw new IncompletePrListError(limit);
  return parseOpenFactoryPrs(payload);
}

export function parseOpenFactoryPrs(payload: unknown): OpenFactoryPr[] {
  if (!Array.isArray(payload)) return [];
  const out: OpenFactoryPr[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    const pr = row as { number?: unknown; headRefName?: unknown; isCrossRepository?: unknown; files?: unknown; isDraft?: unknown; updatedAt?: unknown; commits?: unknown };
    if (pr.isCrossRepository === true) continue;
    if (typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number <= 0) continue;
    if (typeof pr.headRefName !== "string" || !pr.headRefName.startsWith("factory/")) continue;
    const headChangedAt = newerIso(latestCommitAt(pr.commits), isoDate(pr.updatedAt));
    out.push({
      number: pr.number,
      branch: pr.headRefName,
      files: filePaths(pr.files),
      ...(pr.isDraft === true ? { draft: true } : pr.isDraft === false ? { draft: false } : {}),
      ...(headChangedAt ? { headChangedAt } : {}),
    });
  }
  return out;
}

export interface FactoryPrRef {
  number: number;
  state: "open" | "merged" | "closed";
}

export interface PrStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** Head checks. Absent when this status was stored without a rollup (older callers). */
  ci?: "green" | "red" | "pending" | "none";
  /** `mergeStateStatus` BEHIND. */
  behind?: boolean;
  /** `mergeable` CONFLICTING or `mergeStateStatus` DIRTY. */
  conflicting?: boolean;
}

function factoryIssueNumber(branch: string): number | undefined {
  const m = /^factory\/(\d+)(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

function pickFactoryPr(raw: unknown, issue: number): FactoryPrRef | null {
  if (!Array.isArray(raw)) return null;
  const mine: FactoryPrRef[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const pr = row as { number?: unknown; state?: unknown; headRefName?: unknown };
    if (typeof pr.number !== "number" || typeof pr.headRefName !== "string") continue;
    if (factoryIssueNumber(pr.headRefName) !== issue) continue;
    const rawState = String(pr.state ?? "open").toLowerCase();
    const state: FactoryPrRef["state"] = rawState === "merged" || rawState === "closed" ? rawState : "open";
    mine.push({ number: pr.number, state });
  }
  return mine.find((p) => p.state === "open") ?? mine.find((p) => p.state === "merged") ?? mine[0] ?? null;
}

function rollupNodes(rollup: unknown): unknown[] {
  if (Array.isArray(rollup)) return rollup;
  if (rollup && typeof rollup === "object" && Array.isArray((rollup as { nodes?: unknown }).nodes)) return (rollup as { nodes: unknown[] }).nodes;
  return [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Check suite, or the Actions run id in `detailsUrl` when `gh pr view` omits the suite. */
function suiteOf(row: Record<string, unknown>): number | undefined {
  const direct = num(row.suite) ?? num(row.checkSuiteId);
  if (direct !== undefined) return direct;
  const nested = row.checkSuite ?? row.check_suite;
  if (nested && typeof nested === "object") {
    const suite = nested as Record<string, unknown>;
    const id = num(suite.databaseId) ?? num(suite.id);
    if (id !== undefined) return id;
  }
  const url = text(row.detailsUrl) || text(row.details_url) || text(row.targetUrl);
  const run = /\/actions\/runs\/(\d+)/.exec(url) ?? /\/runs\/(\d+)/.exec(url);
  return run ? Number(run[1]) : undefined;
}

/** Workflow `name:` when the payload has it. Absent means ci-status falls back to job names. */
function workflowOf(row: Record<string, unknown>): string | null {
  const direct = text(row.workflow) || text(row.workflowName) || text(row.workflow_name);
  if (direct) return direct;
  const nested = row.checkSuite ?? row.check_suite;
  if (!nested || typeof nested !== "object") return null;
  const run = (nested as Record<string, unknown>).workflowRun ?? (nested as Record<string, unknown>).workflow_run;
  if (!run || typeof run !== "object") return null;
  const record = run as Record<string, unknown>;
  const wf = record.workflow;
  if (wf && typeof wf === "object") {
    const name = text((wf as Record<string, unknown>).name);
    if (name) return name;
  }
  return text(record.name) || text(record.workflowName) || null;
}

/** Check suite finished. GraphQL uses `COMPLETED`. Absent means the check is not settled by the suite. */
function suiteCompleted(row: Record<string, unknown>): boolean {
  const nested = row.checkSuite ?? row.check_suite;
  if (!nested || typeof nested !== "object") return false;
  const status = text((nested as Record<string, unknown>).status).toLowerCase();
  return status === "completed" || status === "complete";
}

/** Check suite creation time, when the payload nests it. Not the check run's own timestamp. */
function suiteCreated(row: Record<string, unknown>): string | null {
  const nested = row.checkSuite ?? row.check_suite;
  if (!nested || typeof nested !== "object") return null;
  const suite = nested as Record<string, unknown>;
  return text(suite.createdAt) || text(suite.created_at) || null;
}

/** GraphQL rollup (upper-case, `startedAt`) and REST check-runs (`started_at`) into one shape. */
function rollupToCheckRuns(nodes: unknown[]): CheckRunView[] {
  const runs: CheckRunView[] = [];
  for (const [index, item] of nodes.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const conclusion = text(row.conclusion).toLowerCase();
    const status = text(row.status).toLowerCase();
    const state = text(row.state).toLowerCase();
    const name = text(row.name) || text(row.context);
    if (!name && !conclusion && !status && !state) continue;
    let mappedStatus = status === "complete" ? "completed" : status;
    let mappedConclusion: string | null = conclusion || null;
    if (!mappedStatus && (state === "success" || state === "failure" || state === "error" || state === "pending" || state === "expected")) {
      mappedStatus = state === "pending" || state === "expected" ? "pending" : "completed";
    }
    if (!mappedConclusion && (state === "failure" || state === "error")) mappedConclusion = "failure";
    if (!mappedConclusion && state === "success") mappedConclusion = "success";
    if (!mappedStatus) mappedStatus = mappedConclusion ? "completed" : "pending";
    runs.push({
      name: name || `check-${index}`,
      status: mappedStatus,
      conclusion: mappedConclusion,
      started_at: text(row.started_at) || text(row.startedAt) || null,
      created_at: suiteCreated(row),
      id: num(row.id) ?? num(row.databaseId),
      suite: suiteOf(row),
      workflow: workflowOf(row),
      ...(suiteCompleted(row) ? { suite_completed: true } : {}),
    });
  }
  return runs;
}

/**
 * `gh pr view --json state,isDraft,mergeable,mergeStateStatus,statusCheckRollup`.
 * CI uses `aggregateCheckRuns`: latest event of each name, draft hold, skipped `done` is not green.
 * An empty rollup is `none`, never green. `mergeStateStatus` UNSTABLE is red unless a draft hold is still pending.
 */
export function prStatusFromView(raw: {
  state?: string;
  isDraft?: boolean;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: unknown;
}): PrStatus {
  const stateRaw = (raw.state ?? "open").toLowerCase();
  const state = stateRaw === "merged" || stateRaw === "closed" ? stateRaw : "open";
  const fromRuns = aggregateCheckRuns(rollupToCheckRuns(rollupNodes(raw.statusCheckRollup)));
  const mergeable = (raw.mergeable ?? "").toUpperCase();
  const mergeState = (raw.mergeStateStatus ?? "").toUpperCase();
  const ci: NonNullable<PrStatus["ci"]> = mergeState === "UNSTABLE" && fromRuns !== "pending" ? "red" : fromRuns;
  return {
    state,
    draft: raw.isDraft === true,
    ci,
    behind: mergeState === "BEHIND",
    conflicting: mergeable === "CONFLICTING" || mergeState === "DIRTY",
  };
}

async function gh(cwd: string, args: string[]): Promise<string> {
  return ghCommand(cwd, args);
}

/** Check suite id → workflow run `created_at` and workflow `name`. One page: a SHA does not have 100 runs. */
interface WorkflowSuite {
  created_at: string | null;
  name: string | null;
}

/**
 * Join key is the check suite (`check_suite_id` on the workflow run, `check_suite.id` on the check run).
 * `name` is the workflow file's `name:` (not `display_title`). A missing Actions API leaves the map empty:
 * event order uses suite id, and ci-status falls back to job names. UNVERIFIED live.
 */
async function workflowSuites(repoDir: string, sha: string): Promise<Map<number, WorkflowSuite>> {
  const map = new Map<number, WorkflowSuite>();
  try {
    const out = await gh(repoDir, [
      "api",
      `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`,
      "--jq",
      "[.workflow_runs[] | {suite: .check_suite_id, created_at, name}]",
    ]);
    const rows = JSON.parse(out || "[]") as { suite?: number | null; created_at?: string | null; name?: string | null }[];
    if (!Array.isArray(rows)) return map;
    for (const row of rows) {
      if (typeof row?.suite !== "number") continue;
      const prev = map.get(row.suite);
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : (prev?.name ?? null);
      map.set(row.suite, { created_at: row.created_at || prev?.created_at || null, name });
    }
  } catch {
    // Event order falls back to check suite id. This must not hide the check runs themselves.
  }
  return map;
}

/** GitHub reports secret scanning as "enabled" or "disabled"; anything else is unknown. */
function securityFlag(value: string | undefined): boolean | null {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

export interface BranchRules {
  /** A `required_status_checks` rule applies to the branch. */
  present: boolean;
  contexts: string[];
  /** `strict_required_status_checks_policy`. Null when the rule omits it. True wins across rules. */
  strict: boolean | null;
}

/** `GET /repos/{owner}/{repo}/rules/branches/{branch}` payload. Non-arrays are ignored. */
export function parseBranchRules(payload: unknown): BranchRules {
  if (!Array.isArray(payload)) return { present: false, contexts: [], strict: null };
  let present = false;
  const contexts: string[] = [];
  let strict: boolean | null = null;
  for (const rule of payload) {
    if (!rule || typeof rule !== "object" || (rule as { type?: unknown }).type !== "required_status_checks") continue;
    present = true;
    const params = (rule as { parameters?: unknown }).parameters;
    if (!params || typeof params !== "object") continue;
    const row = params as { required_status_checks?: unknown; strict_required_status_checks_policy?: unknown };
    if (Array.isArray(row.required_status_checks)) {
      for (const check of row.required_status_checks) {
        const context = typeof check === "string" ? check : check && typeof check === "object" ? (check as { context?: unknown }).context : undefined;
        if (typeof context === "string" && context.trim()) contexts.push(context.trim());
      }
    }
    if (row.strict_required_status_checks_policy === true) strict = true;
    else if (row.strict_required_status_checks_policy === false && strict !== true) strict = false;
  }
  return { present, contexts: [...new Set(contexts)], strict };
}

/**
 * Classic branch protection does not carry ruleset status checks. Union the ruleset contexts
 * and treat the branch as protected when a required-status rule applies. Unknown payloads are a no-op.
 */
export function mergeBranchRules(settings: RepoSettings, payload: unknown): RepoSettings {
  const rules = parseBranchRules(payload);
  if (!rules.present) return settings;
  const strict =
    settings.strict_required_checks === true || rules.strict === true
      ? true
      : settings.strict_required_checks === false || rules.strict === false
        ? false
        : (settings.strict_required_checks ?? null);
  return {
    ...settings,
    branch_protected: true,
    required_checks: [...new Set([...(settings.required_checks ?? []), ...rules.contexts])],
    strict_required_checks: strict,
  };
}

/** `gh` CLI implementation. Not exercised in tests (see docs/VERIFY.md). */
function issueFromGh(raw: unknown): Issue {
  const j = raw as { number: number; title: string; body: string; labels: { name: string }[]; state?: string };
  return {
    number: j.number,
    title: j.title,
    body: j.body ?? "",
    labels: (j.labels ?? []).map((l) => l.name),
    state: (j.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
  };
}

/** GitHub's max page size for `GET /repos/{owner}/{repo}/issues`. */
export const OPEN_ISSUE_PAGE_SIZE = 100;

/** Stop after this many full pages and report the list incomplete rather than create from a partial set. */
export const OPEN_ISSUE_MAX_PAGES = 50;

/**
 * One page of `GET /repos/{owner}/{repo}/issues`. That list includes pull requests; they are not issues.
 * A payload that is not an array is an error, not an empty page.
 */
export function readIssuePage(payload: unknown): Issue[] {
  if (!Array.isArray(payload)) throw new Error("open issue list was not a JSON array");
  const out: Issue[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    if ("pull_request" in row && (row as { pull_request?: unknown }).pull_request) continue;
    const issue = issueFromGh(row);
    if (!Number.isInteger(issue.number) || issue.number < 1) continue;
    out.push(issue);
  }
  return out;
}

/**
 * Follow pages until a short page (complete) or `maxPages` full pages (incomplete: a later page may exist).
 * Completeness uses the raw page length, so a page of pull requests is not the end of the issue list.
 */
export async function paginateOpenIssues(
  fetchPage: (page: number) => Promise<unknown>,
  pageSize = OPEN_ISSUE_PAGE_SIZE,
  maxPages = OPEN_ISSUE_MAX_PAGES,
): Promise<OpenIssueList> {
  const issues: Issue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchPage(page);
    if (!Array.isArray(raw)) throw new Error("open issue list was not a JSON array");
    issues.push(...readIssuePage(raw));
    if (raw.length < pageSize) return { issues, complete: true };
  }
  return { issues, complete: false };
}

/**
 * Workflow file path → workflow name (`GET /actions/workflows`).
 * A failed page stops the lookup; the runs still identify by path. Never the run name.
 */
async function workflowNames(repoDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 1; page <= CI_MAX_PAGES; page++) {
    let batch: { name: string; path: string }[];
    try {
      batch = parseWorkflowNames(JSON.parse(await gh(repoDir, ciWorkflowListArgs(page))));
    } catch {
      break;
    }
    for (const row of batch) map.set(row.path, row.name);
    if (batch.length < CI_PAGE_SIZE) break;
  }
  return map;
}

/** GitHub says this when auto-merge is already on. A restarted runner asks again. */
export function autoMergeAlreadyEnabled(message: string): boolean {
  return /already enabled/i.test(message);
}

/** GitHub says this when auto-merge was not on. Disabling it again is a no-op. UNVERIFIED live wording. */
export function autoMergeNotEnabled(message: string): boolean {
  return /not enabled/i.test(message);
}

export class GhCli implements GitHub {
  async authenticated(repoDir: string): Promise<boolean> {
    try {
      await gh(repoDir, ["auth", "status", "--hostname", "github.com"]);
      return true;
    } catch {
      return false;
    }
  }

  async repoSettings(repoDir: string, branch: string): Promise<RepoSettings> {
    const out: RepoSettings = { private: null, auto_merge_allowed: null, branch_protected: null, required_checks: null };
    try {
      // UNVERIFIED: security_and_analysis is omitted for non-admin tokens; status strings are "enabled"|"disabled".
      const repo = JSON.parse(
        await gh(repoDir, [
          "api",
          "repos/{owner}/{repo}",
          "--jq",
          "{private, allow_auto_merge, secret_scanning: (.security_and_analysis.secret_scanning.status // \"\"), push_protection: (.security_and_analysis.secret_scanning_push_protection.status // \"\")}",
        ]),
      ) as { private?: boolean; allow_auto_merge?: boolean | null; secret_scanning?: string; push_protection?: string };
      out.private = repo.private ?? null;
      out.auto_merge_allowed = repo.allow_auto_merge ?? null;
      out.secret_scanning = securityFlag(repo.secret_scanning);
      out.push_protection = securityFlag(repo.push_protection);
      const b = JSON.parse(
        await gh(repoDir, [
          "api",
          `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`,
          "--jq",
          "{protected, strict: .protection.required_status_checks.strict, contexts: ((.protection.required_status_checks.contexts // []) + ((.protection.required_status_checks.checks // []) | map(.context)))}",
        ]),
      ) as { protected?: boolean; strict?: boolean | null; contexts?: string[] | null };
      out.branch_protected = b.protected ?? null;
      out.strict_required_checks = typeof b.strict === "boolean" ? b.strict : null;
      out.required_checks = b.contexts ?? null;
      // Rulesets do not fill protection.required_status_checks. UNVERIFIED live (docs/VERIFY.md).
      try {
        const rules = JSON.parse(await gh(repoDir, ["api", `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`]));
        const merged = mergeBranchRules(out, rules);
        out.branch_protected = merged.branch_protected;
        out.required_checks = merged.required_checks;
        out.strict_required_checks = merged.strict_required_checks;
      } catch {
        // A missing rules API keeps the classic result. It must not hide secret scanning.
      }
    } catch (e) {
      out.error = (e as Error).message.split("\n")[0]!.slice(0, 200);
    }
    return out;
  }

  async baseStatus(repoDir: string, sha: string, opts?: { since?: string }): Promise<BaseStatus> {
    // A repo without remotes has no GitHub checks (local probe runs).
    if (!(await hasRemote(repoDir))) return "none";
    const out = await gh(repoDir, ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, conclusion, started_at, id, suite: .check_suite.id, app: .app.slug}]"]);
    const raw = actionsCheckRuns(JSON.parse(out || "[]") as RawCheckRun[]);
    const suites = await workflowSuites(repoDir, sha);
    const runs: CheckRunView[] = [];
    for (const run of raw) {
      if (!run.name || !run.status) continue;
      const meta = run.suite != null ? suites.get(run.suite) : undefined;
      runs.push({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion || null,
        started_at: run.started_at,
        created_at: meta?.created_at ?? null,
        id: run.id,
        suite: run.suite,
        workflow: meta?.name ?? null,
      });
    }
    return aggregateCheckRuns(checkRunsSince(runs, opts?.since));
  }

  async getIssue(repoDir: string, n: number): Promise<Issue> {
    const out = await gh(repoDir, ["issue", "view", String(n), "--json", "number,title,body,labels,state"]);
    return issueFromGh(JSON.parse(out));
  }

  async listIssues(repoDir: string, query: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    const args = ["issue", "list", "--state", query.state ?? "open", "--limit", "100", "--json", "number,title,body,labels,state"];
    if (query.label) args.push("--label", query.label);
    const raw = JSON.parse((await gh(repoDir, args)) || "[]") as unknown[];
    return raw.map((j) => issueFromGh(j));
  }

  async listOpenIssues(repoDir: string): Promise<OpenIssueList> {
    // UNVERIFIED: `gh api repos/{owner}/{repo}/issues?state=open` pages (docs/VERIFY.md). Pull requests share this list.
    return paginateOpenIssues(async (page) => {
      const out = await gh(repoDir, ["api", `repos/{owner}/{repo}/issues?state=open&per_page=${OPEN_ISSUE_PAGE_SIZE}&page=${page}`]);
      return JSON.parse(out || "[]") as unknown;
    });
  }

  async ensureLabel(repoDir: string, spec: LabelSpec): Promise<void> {
    await gh(repoDir, ["label", "create", spec.name, "--force", "--color", spec.color, "--description", spec.description]);
  }

  async createIssue(repoDir: string, req: IssueWrite & { labels: string[] }): Promise<Issue> {
    const args = ["issue", "create", "--title", req.title, "--body", req.body];
    for (const label of req.labels) args.push("--label", label);
    const url = (await gh(repoDir, args)).trim();
    const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`gh issue create returned no issue number: ${url.slice(0, 200)}`);
    return this.getIssue(repoDir, n);
  }

  async updateIssue(repoDir: string, n: number, req: IssueWrite): Promise<Issue> {
    await gh(repoDir, ["issue", "edit", String(n), "--title", req.title, "--body", req.body]);
    for (const label of req.labels ?? []) await gh(repoDir, ["issue", "edit", String(n), "--add-label", label]);
    return this.getIssue(repoDir, n);
  }

  async findFactoryPr(repoDir: string, issue: number): Promise<FactoryPrRef | null> {
    if (!(await hasRemote(repoDir))) return null;
    // UNVERIFIED: `gh pr list --search head:factory/N` (docs/VERIFY.md). Client-side filter is exact.
    const out = await gh(repoDir, ["pr", "list", "--state", "all", "--limit", "20", "--json", "number,state,headRefName", "--search", `head:factory/${issue}`]);
    return pickFactoryPr(JSON.parse(out || "[]"), issue);
  }

  async push(repoDir: string, branch: string): Promise<void> {
    await git(repoDir, ["push", "-q", "-u", "origin", branch]);
  }

  async remoteBranchSha(repoDir: string, branch: string): Promise<string | null> {
    const stdout = await git(repoDir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    return /^([0-9a-f]{40,64})\s/m.exec(stdout)?.[1] ?? null;
  }

  async openFactoryPrFiles(repoDir: string): Promise<OpenFactoryPr[]> {
    // A repo without remotes has no PRs to overlap (local probe runs).
    if (!(await hasRemote(repoDir))) return [];
    // UNVERIFIED: `files[].path` from `gh pr list --json files` (docs/VERIFY.md). The page is not a clearance when it hits the limit.
    const out = await gh(repoDir, openFactoryPrListArgs());
    return readOpenFactoryPrs(JSON.parse(out || "[]"));
  }

  async findOpenPr(repoDir: string, branch: string): Promise<OpenPr | null> {
    const list = JSON.parse(await gh(repoDir, ["pr", "list", "--head", branch, "--state", "open", "--limit", "5", "--json", "url,isDraft,headRefOid,headRefName"]) || "[]") as {
      url: string;
      isDraft: boolean;
      headRefOid?: string;
      headRefName?: string;
    }[];
    const pr = list.find((p) => (p.headRefName ?? branch) === branch);
    return pr ? { url: pr.url, draft: pr.isDraft, headSha: pr.headRefOid ?? null } : null;
  }

  async createPr(req: PrRequest): Promise<string> {
    const args = ["pr", "create", "--head", req.head, "--base", req.base, "--title", req.title, "--body", req.body];
    if (req.draft) args.push("--draft");
    const url = (await gh(req.repoDir, args)).trim();
    for (const label of req.labels ?? []) await this.addLabel(req.repoDir, url, label);
    return url;
  }

  async addLabel(repoDir: string, pr: string, label: string): Promise<void> {
    // The PR body carries the same warning; a missing label permission must not fail the run.
    await gh(repoDir, ["label", "create", label, "--force", "--color", "B60205", "--description", "Changes CI or factory config"]).catch(() => "");
    await gh(repoDir, ["pr", "edit", pr, "--add-label", label]).catch(() => "");
  }

  async enableAutoMerge(repoDir: string, pr: string, sha: string): Promise<void> {
    try {
      // expectedHeadOid: a later push does not match, so this enable cannot merge a head the factory did not approve.
      await gh(repoDir, ["pr", "merge", pr, "--auto", "--squash", "--match-head-commit", sha]);
    } catch (e) {
      // A later tick asks again after a restart. GitHub keeps the first enable.
      if (autoMergeAlreadyEnabled((e as Error).message)) return;
      throw e;
    }
  }

  async disableAutoMerge(repoDir: string, pr: string): Promise<void> {
    try {
      await gh(repoDir, ["pr", "merge", pr, "--disable-auto"]);
    } catch (e) {
      if (autoMergeNotEnabled((e as Error).message)) return;
      throw e;
    }
  }

  async approveHead(repoDir: string, sha: string): Promise<void> {
    await gh(repoDir, [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/statuses/${sha}`,
      "-f",
      "state=success",
      "-f",
      "context=factory",
      "-f",
      "description=factory approved this commit",
    ]);
  }

  async commitParents(repoDir: string, sha: string): Promise<string[] | null> {
    try {
      // UNVERIFIED: `parents[].sha` on GET /repos/{owner}/{repo}/commits/{sha}.
      const out = await gh(repoDir, ["api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", "[.parents[].sha]"]);
      const parsed = JSON.parse(out) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null;
      return parsed as string[];
    } catch {
      return null;
    }
  }

  async updatePr(repoDir: string, pr: string, update: { title: string; body: string }): Promise<void> {
    await gh(repoDir, ["pr", "edit", pr, "--title", update.title, "--body", update.body]);
  }

  async markReady(repoDir: string, pr: string): Promise<void> {
    await gh(repoDir, ["pr", "ready", pr]);
  }

  async markDraft(repoDir: string, pr: string): Promise<void> {
    await gh(repoDir, ["pr", "ready", "--undo", pr]);
  }

  async ciRuns(repoDir: string, since: string, limit: number): Promise<CiRun[]> {
    const list = JSON.parse(
      await gh(repoDir, ["run", "list", "--limit", String(limit), "--created", `>=${since.slice(0, 10)}`, "--json", "databaseId,headSha,workflowName,event,conclusion,createdAt"]),
    ) as { databaseId: number; headSha: string; workflowName: string; event: string; conclusion: string | null; createdAt: string }[];
    const out: CiRun[] = [];
    for (const r of list) {
      const jobs = parseRunView(JSON.parse(await gh(repoDir, ciRunViewArgs(r.databaseId))));
      out.push({ id: r.databaseId, sha: r.headSha, workflow: r.workflowName, event: r.event, conclusion: r.conclusion || null, created_at: r.createdAt, jobs });
    }
    return out;
  }

  async ciRunsInWindow(repoDir: string, since: string): Promise<{ runs: CiRun[]; truncated: boolean; skipped: number }> {
    // UNVERIFIED: Actions runs paging. `gh run list` has no page flag and stops at its own limit.
    // A page past 1000 runs is HTTP 422; paginateRunList keeps the pages already read.
    // A failed `gh run view` skips that run; it must not discard the window.
    const { rows, truncated } = await paginateRunList(async (page, perPage) => JSON.parse(await gh(repoDir, ciRunListArgs(since.slice(0, 10), page, perPage))));
    const names = await workflowNames(repoDir);
    const { runs, skipped } = await attachRunViews(rows, since, names, (id) => gh(repoDir, ciRunViewArgs(id)));
    return { runs, truncated, skipped };
  }

  async latestTag(repoDir: string, ownerRepo: string): Promise<string | null> {
    const tags = (await gh(repoDir, ["api", `repos/${ownerRepo}/tags?per_page=100`, "--jq", ".[].name"])).split("\n").filter(Boolean);
    return newestTag(tags);
  }

  async prStatus(repoDir: string, pr: string): Promise<PrStatus> {
    const j = JSON.parse(await gh(repoDir, ["pr", "view", pr, "--json", "state,isDraft,mergeable,mergeStateStatus,statusCheckRollup"]));
    return prStatusFromView(j);
  }

  async updateBranch(repoDir: string, pr: string): Promise<void> {
    // Default is a merge commit. Do not pass `--rebase`: that rewrites the branch the factory pushed.
    // UNVERIFIED: live `gh pr update-branch` (docs/VERIFY.md).
    await gh(repoDir, ["pr", "update-branch", pr]);
  }
}

/** Files a new PR would report: committed diff against `base`, empty when this is not a git checkout. */
function committedDiffNames(repoDir: string, base: string): string[] {
  for (const spec of [`${base}...HEAD`, base]) {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", spec], {
        cwd: repoDir,
        encoding: "utf8",
        timeout: GIT_LOCAL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const files = out.split("\n").filter(Boolean);
      if (files.length) return files;
    } catch {
      // missing base, or not a git dir (unit tests)
    }
  }
  return [];
}

/** In-memory GitHub for tests: no network, no `gh`. */
export class FakeGitHub implements GitHub {
  status: BaseStatus = "none";
  issues = new Map<number, Issue>();
  readonly pushes: string[] = [];
  readonly prs: (PrRequest & { url: string })[] = [];
  readonly autoMerged: string[] = [];
  /** SHA passed to each enable. `autoMerged` stays the PR id list existing assertions compare. */
  readonly autoMergeShas: { pr: string; sha: string }[] = [];
  /** PRs whose auto-merge was disabled. */
  readonly autoMergeDisabled: string[] = [];
  /** SHAs the runner approved. The required `done` check is what blocks a later push. */
  readonly approvedShas: string[] = [];

  async baseStatus(): Promise<BaseStatus> {
    return this.status;
  }

  async getIssue(_repoDir: string, n: number): Promise<Issue> {
    if (this.getIssueError) throw new Error(this.getIssueError);
    const issue = this.issues.get(n);
    if (!issue) throw new Error(`issue #${n} not found`);
    return { ...issue, state: issue.state ?? "open" };
  }

  readonly ensuredLabels: LabelSpec[] = [];
  readonly issueEdits: { number: number; title: string; body: string }[] = [];

  async listIssues(_repoDir: string, query: { label?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]> {
    const state = query.state ?? "open";
    return [...this.issues.values()]
      .filter((issue) => {
        if (query.label && !issue.labels.includes(query.label)) return false;
        const current = issue.state ?? "open";
        return state === "all" || current === state;
      })
      .map((issue) => ({ ...issue, state: issue.state ?? "open" }));
  }

  /** When false, `listOpenIssues` reports a partial page so improve must not create. */
  openIssuesComplete = true;
  /** When set, `getIssue` fails. Lifecycle must keep the proposal, not treat it as closed. */
  getIssueError: string | null = null;
  createIssueError: string | null = null;
  updateIssueError: string | null = null;

  async listOpenIssues(): Promise<OpenIssueList> {
    return { issues: await this.listIssues("", { state: "open" }), complete: this.openIssuesComplete };
  }

  async ensureLabel(_repoDir: string, spec: LabelSpec): Promise<void> {
    this.ensuredLabels.push(spec);
  }

  async createIssue(_repoDir: string, req: IssueWrite & { labels: string[] }): Promise<Issue> {
    if (this.createIssueError) throw new Error(this.createIssueError);
    const number = Math.max(0, ...this.issues.keys()) + 1;
    const issue: Issue = { number, title: req.title, body: req.body, labels: [...req.labels], state: "open" };
    this.issues.set(number, issue);
    return { ...issue };
  }

  async updateIssue(_repoDir: string, n: number, req: IssueWrite): Promise<Issue> {
    if (this.updateIssueError) throw new Error(this.updateIssueError);
    const prev = this.issues.get(n);
    if (!prev) throw new Error(`issue #${n} not found`);
    prev.title = req.title;
    prev.body = req.body;
    if (req.labels) prev.labels = [...new Set([...prev.labels, ...req.labels])];
    this.issueEdits.push({ number: n, title: req.title, body: req.body });
    return { ...prev, state: prev.state ?? "open" };
  }

  /** Planted factory PR for `--after` when the dependency is not queued. Open `factoryPrs` are also seen. */
  readonly factoryPrByIssue = new Map<number, FactoryPrRef>();

  async findFactoryPr(_repoDir: string, issue: number): Promise<FactoryPrRef | null> {
    const planted = this.factoryPrByIssue.get(issue);
    if (planted) return planted;
    const open = this.factoryPrs.find((p) => factoryIssueNumber(p.branch) === issue);
    return open ? { number: open.number, state: "open" } : null;
  }

  /** Branch → sha on the fake origin; a push records the worktree's HEAD. */
  readonly remoteShas = new Map<string, string>();

  async push(repoDir: string, branch: string): Promise<void> {
    this.pushes.push(branch);
    try {
      this.remoteShas.set(branch, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8", timeout: GIT_LOCAL_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      // not a git dir (unit tests): nothing to record
    }
  }

  async remoteBranchSha(_repoDir: string, branch: string): Promise<string | null> {
    return this.remoteShas.get(branch) ?? null;
  }

  async findOpenPr(_repoDir: string, branch: string): Promise<OpenPr | null> {
    const pr = this.prs.find((p) => p.head === branch && (this.prStates.get(p.url)?.state ?? "open") === "open");
    return pr ? { url: pr.url, draft: this.prStates.get(pr.url)?.draft ?? pr.draft, headSha: this.remoteShas.get(branch) ?? null } : null;
  }

  /** Open `factory/*` PRs and the files they change. Tests plant a finished run's PR here. */
  readonly factoryPrs: OpenFactoryPr[] = [];

  async openFactoryPrFiles(): Promise<OpenFactoryPr[]> {
    return this.factoryPrs.map((p) => ({ ...p, files: [...p.files] }));
  }

  async createPr(req: PrRequest): Promise<string> {
    const number = this.prs.length + 1;
    const url = `https://github.test/pr/${number}`;
    this.prs.push({ ...req, url });
    this.prStates.set(url, { state: "open", draft: req.draft });
    // A finished run drops its slot; the PR it just opened still occupies those files.
    if (req.head.startsWith("factory/")) this.factoryPrs.push({ number, branch: req.head, files: committedDiffNames(req.repoDir, req.base) });
    for (const label of req.labels ?? []) await this.addLabel(req.repoDir, url, label);
    return url;
  }

  readonly labels: { pr: string; label: string }[] = [];

  async addLabel(_repoDir: string, pr: string, label: string): Promise<void> {
    this.labels.push({ pr, label });
  }

  async enableAutoMerge(_repoDir: string, pr: string, sha: string): Promise<void> {
    this.autoMerged.push(pr);
    this.autoMergeShas.push({ pr, sha });
  }

  /** When set, `disableAutoMerge` throws this instead of recording the call. */
  disableError: string | null = null;

  async disableAutoMerge(_repoDir: string, pr: string): Promise<void> {
    if (this.disableError) throw new Error(this.disableError);
    this.autoMergeDisabled.push(pr);
  }

  async approveHead(_repoDir: string, sha: string): Promise<void> {
    this.approvedShas.push(sha);
  }

  /** Parents recorded by `updateBranch`, or set by a test. Missing means unreadable. */
  readonly commitParentsBySha = new Map<string, string[]>();
  /** When set, the next `updateBranch` records these parents instead of [previous head, base]. */
  updateBranchParents: string[] | null = null;

  async commitParents(_repoDir: string, sha: string): Promise<string[] | null> {
    return this.commitParentsBySha.get(sha) ?? null;
  }

  readonly updates: { pr: string; title: string; body: string }[] = [];
  readonly readied: string[] = [];
  readonly drafted: string[] = [];

  async updatePr(_repoDir: string, pr: string, update: { title: string; body: string }): Promise<void> {
    this.updates.push({ pr, ...update });
  }

  async markReady(_repoDir: string, pr: string): Promise<void> {
    this.readied.push(pr);
    const prev = this.prStates.get(pr);
    this.prStates.set(pr, { state: prev?.state ?? "open", draft: false });
  }

  async markDraft(_repoDir: string, pr: string): Promise<void> {
    this.drafted.push(pr);
    const prev = this.prStates.get(pr);
    this.prStates.set(pr, { state: prev?.state ?? "open", draft: true });
  }

  /** PR states by URL; created PRs are open. */
  readonly prStates = new Map<string, PrStatus>();

  authOk = true;
  settings: RepoSettings = { private: true, auto_merge_allowed: false, branch_protected: false, required_checks: [] };

  async authenticated(): Promise<boolean> {
    return this.authOk;
  }

  async repoSettings(): Promise<RepoSettings> {
    return this.settings;
  }

  /** CI history and the factory's newest tag as `harden` sees them. */
  runs: CiRun[] = [];
  factoryTag: string | null = null;
  /** Set when a test wants the window reported as cut off by the page cap. */
  ciTruncated = false;
  /** Runs whose view failed. The list itself still succeeds. */
  ciSkipped = 0;
  /** When set, the window fetch fails (list error, not a skipped view). */
  ciWindowError: string | null = null;
  readonly ciQueries: { since: string; limit: number }[] = [];

  async ciRuns(_repoDir: string, since: string, limit: number): Promise<CiRun[]> {
    this.ciQueries.push({ since, limit });
    return this.runs.filter((r) => r.created_at >= since).slice(0, limit);
  }

  async ciRunsInWindow(_repoDir: string, since: string): Promise<{ runs: CiRun[]; truncated: boolean; skipped: number }> {
    this.ciQueries.push({ since, limit: CI_PAGE_SIZE });
    if (this.ciWindowError) throw new Error(this.ciWindowError);
    return { runs: this.runs.filter((r) => r.created_at >= since), truncated: this.ciTruncated, skipped: this.ciSkipped };
  }

  async latestTag(): Promise<string | null> {
    return this.factoryTag;
  }

  async prStatus(_repoDir: string, pr: string): Promise<PrStatus> {
    const s = this.prStates.get(pr);
    if (s) return s;
    const created = this.prs.find((p) => p.url === pr || p.url.endsWith(`/${pr}`));
    if (!created) throw new Error(`PR ${pr} not found`);
    return this.prStates.get(created.url) ?? { state: "open", draft: created.draft };
  }

  /** `gh pr update-branch` stand-in: records the call, clears `behind`, and moves the branch head so a test can read the new SHA. */
  readonly updatedBranches: string[] = [];
  /** When set and different from the current head, the next update-branch writes this SHA. */
  updateBranchHead: string | null = null;

  async updateBranch(_repoDir: string, pr: string): Promise<void> {
    this.updatedBranches.push(pr);
    const keys = [pr];
    const created = this.prs.find((p) => p.url === pr || p.url.endsWith(`/${pr}`));
    if (created) keys.push(created.url);
    let found = false;
    for (const key of keys) {
      const prev = this.prStates.get(key);
      if (!prev) continue;
      found = true;
      this.prStates.set(key, { ...prev, behind: false });
    }
    if (!found) this.prStates.set(pr, { state: "open", draft: false, behind: false });
    const branch = created?.head ?? this.factoryPrs.find((p) => String(p.number) === pr || p.number === Number(pr))?.branch;
    if (!branch) return;
    const prev = this.remoteShas.get(branch);
    const forced = this.updateBranchHead;
    this.updateBranchHead = null;
    const next = forced && forced !== prev ? forced : nextUpdateHead(prev);
    this.remoteShas.set(branch, next);
    const parents = this.updateBranchParents ?? (prev ? [prev, "b".repeat(40)] : []);
    this.commitParentsBySha.set(next, parents);
  }
}

/** A head that is not `prev`, so a test can see that update-branch produced a commit. */
function nextUpdateHead(prev: string | undefined): string {
  const base = prev && /^[0-9a-f]{40,64}$/.test(prev) ? prev : "0".repeat(40);
  const alphabet = "0123456789abcdef";
  const i = alphabet.indexOf(base.at(-1) ?? "0");
  return base.slice(0, -1) + alphabet[(Math.max(0, i) + 1) % alphabet.length];
}
