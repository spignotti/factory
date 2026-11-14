import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { GitHub, MergeMethod } from "../gh.js";
import { git, revParse } from "../git.js";
import { fallbackMergeMethod } from "../pipeline/merge-ready.js";
import { listRuns } from "../runs.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { updateNeedsDecision } from "./admit.js";
import { pauseRequested } from "./pause.js";
import { updateQueue, type QueueEntry } from "./store.js";

function prNumberOf(ref: string): number | undefined {
  const text = ref.trim();
  if (/^[1-9]\d*$/.test(text)) return Number(text);
  const m = /\/(?:pull|pr)\/([1-9]\d*)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * #189: an explicitly approved merge batch. The operator names the PRs. The permission is only a
 * conflict-free base update of the reviewed changes, not a new diff and not a merge-policy change.
 * `factory=success` is never posted here; a head that lacks it is handed to the existing resume path.
 */

export const BATCH_PERMISSION = "conflict_free_base_update" as const;

const STATUSES = ["pending", "merged", "waiting", "blocked", "needs_approval"] as const;
export type BatchStatus = (typeof STATUSES)[number];

export interface BatchPr {
  repo: string;
  number: number;
  url: string;
  reviewed_sha: string;
  files: string[];
  risk: "low" | "medium" | "high" | null;
  protected: boolean;
  merge_policy: "auto" | "bot_review" | "human_review" | null;
  status: BatchStatus;
  reason: string;
  merged_sha?: string;
}

export interface BatchFile {
  version: 1;
  id: string;
  at: string;
  actor: string;
  permission: typeof BATCH_PERMISSION;
  prs: BatchPr[];
}

export interface PrRef {
  repo: string;
  number: number;
}

export type BatchAction = "merge" | "update" | "revalidate" | "wait" | "blocked" | "needs_approval" | "reconciled";

export interface BatchDecision {
  action: BatchAction;
  reason: string;
  /** Head the merge guard must match. Absent unless the action is merge. */
  sha?: string;
}

const PrSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  reviewed_sha: z.string().min(1),
  files: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  protected: z.boolean(),
  merge_policy: z.enum(["auto", "bot_review", "human_review"]).nullable(),
  status: z.enum(STATUSES),
  reason: z.string(),
  merged_sha: z.string().optional(),
});

const FileSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  at: z.string().min(1),
  actor: z.string().min(1),
  permission: z.literal(BATCH_PERMISSION),
  prs: z.array(PrSchema),
});

export function batchPath(factoryHome: string): string {
  // Not a `.json` name: the queue loader reads every `queue/*.json` as a queue file.
  return join(factoryHome, "queue", "merge-batch");
}

export function parsePrRef(raw: string): PrRef | undefined {
  const m = /^(.+)#([1-9]\d*)$/.exec(raw.trim());
  if (!m) return undefined;
  return { repo: resolve(m[1]!), number: Number(m[2]) };
}

export function prKey(repo: string, number: number): string {
  return `${resolve(repo)}#${number}`;
}

export function loadBatch(factoryHome: string): BatchFile | undefined {
  const path = batchPath(factoryHome);
  if (!existsSync(path)) return undefined;
  const parsed = FileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error("merge batch file is invalid; not merging");
  return parsed.data;
}

function saveBatch(factoryHome: string, file: BatchFile): void {
  const path = batchPath(factoryHome);
  mkdirSync(join(factoryHome, "queue"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

function sameSelection(file: BatchFile, prs: BatchPr[]): boolean {
  if (file.prs.length !== prs.length) return false;
  return file.prs.every((saved, i) => {
    const next = prs[i]!;
    return prKey(saved.repo, saved.number) === prKey(next.repo, next.number) && saved.reviewed_sha === next.reviewed_sha;
  });
}

function openWork(file: BatchFile): boolean {
  return file.prs.some((pr) => pr.status !== "merged" && pr.status !== "blocked" && pr.status !== "needs_approval");
}

interface RunSnap {
  runId: string;
  dir: string;
  reviewedSha: string;
  branch: string;
  url: string;
  risk: BatchPr["risk"];
  policy: BatchPr["merge_policy"];
  protected: boolean;
  worktree: string | null;
}

function snapOf(factoryHome: string, repo: string, number: number): RunSnap | undefined {
  const want = resolve(repo);
  for (const run of listRuns(factoryHome)) {
    const st = run.state;
    if (!st?.pr || !st.reviewed_sha || !st.branch) continue;
    if (resolve(st.repo) !== want) continue;
    if (prNumberOf(st.pr) !== number) continue;
    const reasons = run.result?.risk_reasons ?? [];
    let protectedChange = reasons.some((r) => /protected/i.test(r));
    try {
      const plan = JSON.parse(readFileSync(join(run.dir, "plan.json"), "utf8")) as { protected_changes?: unknown[] };
      if ((plan.protected_changes?.length ?? 0) > 0) protectedChange = true;
    } catch {
      protectedChange = true;
    }
    return {
      runId: run.run_id,
      dir: run.dir,
      reviewedSha: st.reviewed_sha,
      branch: st.branch,
      url: st.pr,
      risk: run.result?.risk ?? null,
      policy: run.result?.merge_policy ?? null,
      protected: protectedChange,
      worktree: st.worktree,
    };
  }
  return undefined;
}

async function liveFiles(github: GitHub, repo: string, number: number): Promise<string[] | null> {
  const prs = await github.openFactoryPrFiles(repo);
  const hit = prs.find((pr) => pr.number === number);
  return hit ? [...hit.files] : null;
}

/** Read-only. Only the named PRs. Does not write a batch or call merge/approve. */
export async function previewBatch(factoryHome: string, github: GitHub, refs: PrRef[]): Promise<BatchPr[]> {
  const out: BatchPr[] = [];
  for (const ref of refs) {
    const snap = snapOf(factoryHome, ref.repo, ref.number);
    if (!snap) {
      out.push({
        repo: ref.repo,
        number: ref.number,
        url: "",
        reviewed_sha: "",
        files: [],
        risk: null,
        protected: true,
        merge_policy: null,
        status: "needs_approval",
        reason: "no local run with a reviewed SHA for this PR; not authorized",
      });
      continue;
    }
    let files: string[] = [];
    let live: string;
    try {
      files = (await liveFiles(github, ref.repo, ref.number)) ?? [];
      const status = await github.prStatus(ref.repo, snap.url);
      const open = await github.findOpenPr(ref.repo, snap.branch);
      const settings = await github.repoSettings(ref.repo, loadRepoConfig(ref.repo).base_branch);
      const checks = settings.required_checks?.join(", ") || "unreadable";
      live = `head ${open?.headSha?.slice(0, 8) ?? "unread"}, ci ${status.ci ?? "unread"}, ${status.behind ? "behind" : "not behind"}${status.conflicting ? ", conflicting" : ""}, required [${checks}]`;
    } catch (e) {
      live = `live state unread (${(e as Error).message.slice(0, 120)})`;
    }
    out.push({
      repo: ref.repo,
      number: ref.number,
      url: snap.url,
      reviewed_sha: snap.reviewedSha,
      files,
      risk: snap.risk,
      protected: snap.protected,
      merge_policy: snap.policy,
      status: "pending",
      reason: `reviewed ${snap.reviewedSha.slice(0, 8)}; ${live}; permission would cover only a conflict-free base update`,
    });
  }
  return out;
}

/** Persists the named PRs only. A different open batch is refused. The same selection keeps its progress. */
export async function applyBatch(factoryHome: string, github: GitHub, refs: PrRef[], nowMs = Date.now()): Promise<BatchFile> {
  if (!refs.length) throw new Error("a merge batch needs at least one repository-qualified PR");
  const preview = await previewBatch(factoryHome, github, refs);
  const missing = preview.filter((pr) => !pr.reviewed_sha);
  if (missing.length) throw new Error(`not authorized: ${missing.map((pr) => `${pr.repo}#${pr.number}`).join(", ")} have no reviewed SHA`);
  const existing = existsSync(batchPath(factoryHome)) ? loadBatch(factoryHome) : undefined;
  if (existing && sameSelection(existing, preview)) return existing;
  if (existing && openWork(existing)) throw new Error("a merge batch is already open; wait until it finishes or its PRs are blocked");
  const id = createHash("sha256").update(preview.map((pr) => `${prKey(pr.repo, pr.number)}@${pr.reviewed_sha}`).join("\n")).digest("hex").slice(0, 12);
  const file: BatchFile = {
    version: 1,
    id,
    at: new Date(nowMs).toISOString(),
    actor: "operator",
    permission: BATCH_PERMISSION,
    prs: preview.map((pr) => ({ ...pr, status: "pending", reason: "approved for a conflict-free base update of the reviewed head" })),
  };
  saveBatch(factoryHome, file);
  return file;
}

export interface BaseVerdict {
  ok: boolean;
  kind: "same" | "clean_base" | "rejected";
  reason: string;
}

/**
 * A new head is authorized only when it is the reviewed commit, or a merge of that commit with the
 * current base whose tree is exactly the clean merge. Anything else, including an unreadable parent
 * list, is not proof that the approved diff survived.
 */
export async function cleanBaseUpdate(opts: {
  worktree: string;
  approved: string;
  head: string;
  baseSha: string;
  parents: string[] | null;
}): Promise<BaseVerdict> {
  if (opts.head === opts.approved) return { ok: true, kind: "same", reason: "head is the reviewed commit" };
  if (!opts.parents) return { ok: false, kind: "rejected", reason: "commit parents are unreadable; not merging" };
  if (opts.parents.length !== 2 || opts.parents[0] !== opts.approved || opts.parents[1] !== opts.baseSha) {
    return { ok: false, kind: "rejected", reason: "head is not a merge of the reviewed commit and the current base" };
  }
  let clean: string;
  try {
    clean = (await git(opts.worktree, ["merge-tree", "--write-tree", opts.approved, opts.baseSha])).trim();
  } catch {
    return { ok: false, kind: "rejected", reason: "base update conflicts or could not be checked; renewed approval required" };
  }
  let actual: string;
  try {
    actual = (await git(opts.worktree, ["rev-parse", `${opts.head}^{tree}`])).trim();
  } catch {
    return { ok: false, kind: "rejected", reason: "new head is not in the worktree; not merging an unverified tree" };
  }
  if (clean !== actual) return { ok: false, kind: "rejected", reason: "base update does not preserve the approved changes" };
  return { ok: true, kind: "clean_base", reason: "conflict-free base update of the reviewed changes" };
}

export function decideBatchPr(input: {
  pr: BatchPr;
  live: { state: "open" | "merged" | "closed"; headSha: string | null; ci?: string; behind?: boolean; conflicting?: boolean; draft?: boolean } | null;
  files: string[] | null;
  base: BaseVerdict | null;
  requiredChecks: string[] | null;
  method: MergeMethod | null;
  paused: boolean;
  earlierBlocked: boolean;
  canRevalidate: boolean;
}): BatchDecision {
  if (input.earlierBlocked) return { action: "wait", reason: "an earlier PR in this repo is not merged" };
  if (!input.live) return { action: "blocked", reason: "PR could not be read" };
  if (input.live.state === "merged") return { action: "reconciled", reason: "already merged" };
  if (input.live.state !== "open") return { action: "blocked", reason: "PR is closed without a merge" };
  if (input.paused) return { action: "wait", reason: "paused; not merging" };
  if (input.live.conflicting) return { action: "needs_approval", reason: "unresolved conflict; renewed approval required" };
  if (!input.live.headSha) return { action: "blocked", reason: "PR head is unreadable" };
  if (!input.files) return { action: "needs_approval", reason: "changed files are unreadable; not merging" };
  const extra = input.files.filter((f) => !input.pr.files.includes(f));
  const missing = input.pr.files.filter((f) => !input.files!.includes(f));
  if (extra.length || missing.length) return { action: "needs_approval", reason: "PR file list changed since approval; renewed approval required" };
  const head = input.live.headSha;
  if (head !== input.pr.reviewed_sha) {
    if (!input.base?.ok) return { action: "needs_approval", reason: input.base?.reason ?? "head moved and was not checked; renewed approval required" };
  }
  if (input.live.behind) return { action: "update", reason: "behind the base; update, then revalidate the new head" };
  if (input.live.draft) return { action: "wait", reason: "PR is still a draft" };
  if (!input.requiredChecks?.includes("done")) return { action: "blocked", reason: "required checks are unreadable or do not include done; not manufacturing a status" };
  if (!input.method) return { action: "blocked", reason: "the repository allows no known merge method" };
  if (input.live.ci === "red") return { action: "blocked", reason: "CI on this head is red" };
  if (input.live.ci !== "green") {
    if (!input.canRevalidate) return { action: "needs_approval", reason: "CI is not green and there is no checkpoint to revalidate" };
    return { action: "revalidate", reason: "CI is not green on this head; the existing pipeline must revalidate before merge" };
  }
  return { action: "merge", reason: "authorized head is green, including the required done check", sha: head };
}

async function commitPresent(worktree: string, sha: string): Promise<boolean> {
  try {
    await git(worktree, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function mark(pr: BatchPr, status: BatchStatus, reason: string, sha?: string): void {
  pr.status = status;
  pr.reason = reason;
  if (sha) pr.merged_sha = sha;
}

function releaseForResume(entry: QueueEntry): void {
  entry.status = "pending";
  delete entry.reason;
  delete entry.pid;
  delete entry.choice;
}

/**
 * One step for this repo: at most one update or one guarded merge. Never posts `factory=success`
 * and never changes a merge policy. A later PR in the same repo waits; other repos do not.
 */
export async function advanceMergeBatch(opts: {
  factoryHome: string;
  github: GitHub;
  repo: string;
  io: { out: (s: string) => void; err: (s: string) => void };
}): Promise<boolean> {
  if (!existsSync(batchPath(opts.factoryHome))) return false;
  const file = loadBatch(opts.factoryHome);
  if (!file) return false;
  const repo = resolve(opts.repo);
  const mine = file.prs.filter((pr) => resolve(pr.repo) === repo);
  if (!mine.length) return false;
  const earlierBlocked = (pr: BatchPr) => file.prs.some((other) => resolve(other.repo) === repo && file.prs.indexOf(other) < file.prs.indexOf(pr) && other.status !== "merged");
  const next = mine.find((pr) => pr.status !== "merged" && pr.status !== "blocked" && pr.status !== "needs_approval");
  if (!next) return mine.some((pr) => pr.status === "pending" || pr.status === "waiting");
  if (earlierBlocked(next)) {
    mark(next, "waiting", "an earlier PR in this repo is not merged");
    saveBatch(opts.factoryHome, file);
    return true;
  }
  const snap = snapOf(opts.factoryHome, repo, next.number);
  let live: { state: "open" | "merged" | "closed"; headSha: string | null; ci?: string; behind?: boolean; conflicting?: boolean; draft?: boolean };
  let headSha: string | null;
  try {
    const status = await opts.github.prStatus(repo, next.url);
    const open = snap ? await opts.github.findOpenPr(repo, snap.branch) : null;
    headSha = open?.headSha ?? null;
    live = { state: status.state, headSha, ci: status.ci, behind: status.behind, conflicting: status.conflicting, draft: status.draft || open?.draft };
  } catch (e) {
    mark(next, "waiting", `PR could not be read (${(e as Error).message.slice(0, 160)})`);
    saveBatch(opts.factoryHome, file);
    opts.io.err(`batch: #${next.number} ${next.reason}\n`);
    return true;
  }
  let files: string[] | null;
  try {
    files = await liveFiles(opts.github, repo, next.number);
  } catch {
    files = null;
  }
  let base: BaseVerdict | null = null;
  if (snap?.worktree && headSha && headSha !== next.reviewed_sha) {
    try {
      const baseSha = await revParse(repo, loadRepoConfig(repo).base_branch);
      if (!(await commitPresent(snap.worktree, headSha))) {
        await git(snap.worktree, ["fetch", "--quiet", "origin", snap.branch]).catch(() => undefined);
      }
      const parents = await opts.github.commitParents(repo, headSha);
      base = await cleanBaseUpdate({ worktree: snap.worktree, approved: next.reviewed_sha, head: headSha, baseSha, parents });
    } catch (e) {
      base = { ok: false, kind: "rejected", reason: `base update could not be checked (${(e as Error).message.slice(0, 160)})` };
    }
  } else if (headSha === next.reviewed_sha) {
    base = { ok: true, kind: "same", reason: "head is the reviewed commit" };
  }
  let required: string[] | null;
  let method: MergeMethod | null;
  try {
    const settings = await opts.github.repoSettings(repo, loadRepoConfig(repo).base_branch);
    required = settings.required_checks;
    method = fallbackMergeMethod(settings.merge_methods);
  } catch {
    required = null;
    method = null;
  }
  const paused = snap ? Boolean(pauseRequested(opts.factoryHome, { runId: snap.runId, repo, issue: next.number })) : false;
  const decision = decideBatchPr({
    pr: next,
    live,
    files,
    base,
    requiredChecks: required,
    method,
    paused,
    earlierBlocked: false,
    canRevalidate: Boolean(snap?.worktree && existsSync(join(snap.dir, "plan.json"))),
  });
  if (decision.action === "reconciled") {
    mark(next, "merged", decision.reason, headSha ?? next.reviewed_sha);
  } else if (decision.action === "update") {
    try {
      await opts.github.updateBranch(repo, next.url);
      mark(next, "waiting", "base update requested; the new head still needs revalidation");
    } catch (e) {
      const msg = (e as Error).message;
      mark(next, updateNeedsDecision(msg) ? "needs_approval" : "waiting", msg.slice(0, 200));
    }
  } else if (decision.action === "revalidate" && snap) {
    const statePath = join(snap.dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { continuation?: unknown };
    state.continuation = { kind: "base", sha: headSha };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    await updateQueue(opts.factoryHome, repo, (q) => {
      const entry = q.entries.find((e) => e.issue === next.number || prNumberOf(e.pr ?? "") === next.number);
      if (entry && entry.status !== "running" && entry.status !== "pending") releaseForResume(entry);
    });
    mark(next, "waiting", decision.reason);
  } else if (decision.action === "merge" && decision.sha && method) {
    try {
      await opts.github.mergeNow(repo, next.url, decision.sha, method);
      mark(next, "merged", decision.reason, decision.sha);
      opts.io.out(`batch: merged #${next.number} at ${decision.sha.slice(0, 8)}\n`);
    } catch (e) {
      mark(next, "waiting", `merge refused (${(e as Error).message.slice(0, 160)})`);
    }
  } else if (decision.action === "needs_approval") {
    mark(next, "needs_approval", decision.reason);
  } else if (decision.action === "blocked") {
    mark(next, "blocked", decision.reason);
  } else {
    mark(next, "waiting", decision.reason);
  }
  saveBatch(opts.factoryHome, file);
  if (next.status !== "merged") opts.io.out(`batch: #${next.number} ${next.status} — ${next.reason}\n`);
  return file.prs.some((pr) => resolve(pr.repo) === repo && (pr.status === "pending" || pr.status === "waiting"));
}

export function renderBatch(prs: BatchPr[]): string {
  if (!prs.length) return "no PRs in the batch\n";
  return prs.map((pr) => `${pr.repo}#${pr.number} ${pr.status} — ${pr.reason} (reviewed ${pr.reviewed_sha.slice(0, 8) || "none"}, ${pr.merge_policy ?? "no policy"}${pr.protected ? ", protected" : ""})`).join("\n") + "\n";
}

export function batchBusy(factoryHome: string, repo: string): boolean {
  if (!existsSync(batchPath(factoryHome))) return false;
  try {
    const file = loadBatch(factoryHome);
    return Boolean(file?.prs.some((pr) => resolve(pr.repo) === resolve(repo) && (pr.status === "pending" || pr.status === "waiting")));
  } catch {
    return true;
  }
}
