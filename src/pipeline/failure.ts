import type { GitHub, IssueComment, LabelSpec } from "../gh.js";
import { existsSync } from "node:fs";
import { git } from "../git.js";
import { FACTORY_FAILED_LABEL, FACTORY_READY_LABEL } from "../queue/store.js";
import { stopCauseOf } from "./outcome.js";

export const FACTORY_FAILED_LABEL_SPEC: LabelSpec = {
  name: FACTORY_FAILED_LABEL,
  color: "B60205",
  description: "The factory gave up on this issue; the comment says why",
};

/** Longest reason quoted on the issue. The full text stays in the run's result.json. */
const MAX_REASON = 1500;

/**
 * Whether a finished attempt ends its ticket as failed: everything except done, a question, a
 * provider retry or usage-window wait, a base problem, a lock, an operator abandon and a pause
 * (`human_approval` while `paused`, i.e. a pause marker for the run or issue exists). A result kind or
 * cause added later fails by default, so no stop is parked silently. A done run waiting for a human
 * merge (the hard list) is done, not failed.
 */
export function isFailedExit(r: { result: string; stop?: unknown; questions?: string[] }, opts: { paused?: boolean } = {}): boolean {
  if (r.result === "done" || r.result === "locked" || r.result === "base_red" || r.result === "abandoned") return false;
  if (r.result === "needs_input" && r.questions?.length) return false;
  const cause = stopCauseOf(r.stop);
  if (cause === "transient_retry" || cause === "provider_window_wait") return false;
  return !(cause === "human_approval" && opts.paused);
}

/** Hidden in the rendered comment. One run never reports its failure twice. */
export function failureMarker(runId: string): string {
  return `<!-- factory:failed run=${runId} -->`;
}

/** The stop's first line and, when the resolver gave up, its reason: the comment's short answer. */
export function failureHeadline(reason: string): string {
  const firstLine = (t: string, max: number) => (t.trim().split("\n")[0] ?? "").slice(0, max);
  const at = reason.lastIndexOf("; resolver: ");
  if (at < 0) return firstLine(reason, 300) || "no reason recorded";
  return `${firstLine(reason.slice(0, at), 200)} (resolver: ${firstLine(reason.slice(at + "; resolver: ".length), 300)})`;
}

/**
 * The run's PR and, when the failed exit may close it, the branch and the commits the run produced.
 * Without `close` the PR stays open: a stop that waits for a person, or a spent retry budget.
 */
export interface FailedPr {
  pr: string | null | undefined;
  close?: { branch: string; heads: string[] };
}

function prLine(target: FailedPr): string {
  if (!target.pr) return "Nobody is waiting on this run.";
  if (target.close) return `The factory closes its pull request ${target.pr} (unless someone else pushed to it). Nobody is waiting on this run.`;
  return `Its pull request ${target.pr} stays open: merge or close it yourself.`;
}

export function renderFailureComment(runId: string, reason: string, target: FailedPr = { pr: null }): string {
  const text = (reason.trim() || "no reason recorded").slice(0, MAX_REASON);
  const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  return [
    `The factory gave up on this issue (run \`${runId}\`).`,
    "",
    `**Why:** ${failureHeadline(reason)}`,
    "",
    prLine(target),
    "",
    "**What to do:** read the reason first.",
    "- About the ticket (unclear task, too much scope, a missing detail): rewrite it or split it into smaller issues.",
    "- A technical failure (git, push, network, CI or the factory itself): the ticket can stay as it is. Requeue it, and report the cause to whoever runs the factory if it comes back.",
    "",
    `Then remove the \`${FACTORY_FAILED_LABEL}\` label and add \`${FACTORY_READY_LABEL}\` again; the next run starts fresh.`,
    "",
    "<details><summary>Full reason (the run's own wording)</summary>",
    "",
    `${fence}text`,
    text,
    fence,
    "",
    "</details>",
    "",
    failureMarker(runId),
  ].join("\n");
}

/**
 * Puts a failed run on its issue: the comment (skipped when this run's marker is already there),
 * `factory-failed` on, `factory-ready` off, then the run's own PR closed with its remote branch when
 * `target.close` allows it and the PR's head is still a commit the run produced. Each step is safe to
 * repeat, so a caller retries the whole sequence after any failure. Throws on the first GitHub error.
 * `redact` applies to the comment body: the reason can quote check output.
 */
export async function reportFailure(
  github: GitHub,
  repoDir: string,
  issue: number,
  runId: string,
  reason: string,
  target: FailedPr,
  redact: (text: string) => string = (t) => t,
): Promise<void> {
  const marker = failureMarker(runId);
  const existing: IssueComment[] = await github.issueComments(repoDir, issue);
  if (!existing.some((c) => c.body.includes(marker))) await github.commentIssue(repoDir, issue, redact(renderFailureComment(runId, reason, target)));
  await github.addIssueLabel(repoDir, issue, FACTORY_FAILED_LABEL_SPEC);
  const current = await github.getIssue(repoDir, issue);
  if (current.labels.includes(FACTORY_READY_LABEL)) await github.removeIssueLabel(repoDir, issue, FACTORY_READY_LABEL);
  if (target.pr && target.close) await github.closePr(repoDir, target.pr, target.close);
}

/** A stop that waits for a person (`human_approval`, e.g. a clean-status refusal): its PR is never closed. */
export function keepsPr(stop: unknown): boolean {
  return stopCauseOf(stop) === "human_approval";
}

/**
 * What the failed exit may close: the run's branch and the commits on it since the base (the run's
 * own work, read from its worktree). Nothing when the stop waits for a person or the run never had a
 * branch or worktree; the PR then stays open.
 */
export async function closableTarget(
  st: { branch: string | null; worktree: string | null; base_sha: string | null; approved_sha?: string } | undefined,
  pr: string | null | undefined,
  keep: boolean,
): Promise<FailedPr> {
  if (!pr || keep || !st?.branch || !st.worktree || !existsSync(st.worktree)) return { pr };
  const range = st.base_sha ? [`${st.base_sha}..HEAD`] : ["-1", "HEAD"];
  const heads = (await git(st.worktree, ["rev-list", ...range]).catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
  if (st.approved_sha) heads.push(st.approved_sha);
  return heads.length ? { pr, close: { branch: st.branch, heads } } : { pr };
}
