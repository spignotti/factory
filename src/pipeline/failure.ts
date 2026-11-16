import type { GitHub, IssueComment, LabelSpec } from "../gh.js";
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

export function renderFailureComment(runId: string, reason: string, pr?: string | null): string {
  const text = (reason.trim() || "no reason recorded").slice(0, MAX_REASON);
  const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  return [
    `The factory gave up on this issue (run \`${runId}\`).`,
    "",
    `**Why:** ${failureHeadline(reason)}`,
    "",
    pr ? `Its pull request ${pr} is closed. Nobody is waiting on this run.` : "Nobody is waiting on this run.",
    "",
    `**What to do:** rewrite the ticket (a clearer task, a smaller scope, the missing detail) or split it into smaller issues. Then remove the \`${FACTORY_FAILED_LABEL}\` label and add \`${FACTORY_READY_LABEL}\` again; the next run starts fresh.`,
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
 * Puts a failed run on its issue: the run's own PR closed (with its remote branch), the comment
 * (skipped when this run's marker is already there), `factory-failed` on, `factory-ready` off. Each
 * step is safe to repeat, so a caller retries the whole sequence after any failure. Throws on the
 * first GitHub error. `redact` applies to the comment body: the reason can quote check output.
 */
export async function reportFailure(
  github: GitHub,
  repoDir: string,
  issue: number,
  runId: string,
  reason: string,
  pr: string | null | undefined,
  redact: (text: string) => string = (t) => t,
): Promise<void> {
  if (pr) await github.closePr(repoDir, pr);
  const marker = failureMarker(runId);
  const existing: IssueComment[] = await github.issueComments(repoDir, issue);
  if (!existing.some((c) => c.body.includes(marker))) await github.commentIssue(repoDir, issue, redact(renderFailureComment(runId, reason, pr)));
  await github.addIssueLabel(repoDir, issue, FACTORY_FAILED_LABEL_SPEC);
  const current = await github.getIssue(repoDir, issue);
  if (current.labels.includes(FACTORY_READY_LABEL)) await github.removeIssueLabel(repoDir, issue, FACTORY_READY_LABEL);
}
