import type { GitHub, IssueComment } from "../gh.js";
import { FACTORY_READY_LABEL, NEEDS_INPUT_LABEL } from "../queue/store.js";
import { NEEDS_INPUT_LABEL_SPEC } from "./questions.js";

/** Longest summary quoted on the issue. The full text stays in the run's handoffs and result.json. */
const MAX_SUMMARY = 1500;

/** Hidden in the rendered comment. One run never reports "nothing to change" twice. */
export function noChangeMarker(runId: string): string {
  return `<!-- factory:no-change run=${runId} -->`;
}

/**
 * What the run says about why it changed nothing: the implementer's own lines (what it found done,
 * decided or skipped), falling back to the run's reason when the handoffs say nothing.
 */
export function noChangeSummary(handoffs: { done: string[]; decisions: string[]; skipped: string[] }[], reason: string): string {
  const lines = [...new Set(handoffs.flatMap((h) => [...h.done, ...h.decisions, ...h.skipped]).map((l) => l.trim()).filter(Boolean))];
  return lines.length ? lines.map((l) => `- ${l.replace(/\n/g, "\n  ")}`).join("\n") : reason.trim() || "the run recorded no reason";
}

export function renderNoChangeComment(runId: string, summary: string): string {
  const text = (summary.trim() || "the run recorded no reason").slice(0, MAX_SUMMARY);
  const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map((m) => m[0].length + 1)));
  return [
    `The factory ran on this issue and found nothing to change against the current base branch (run \`${runId}\`). No pull request was opened.`,
    "",
    "**Why (the run's own wording):**",
    "",
    `${fence}text`,
    text,
    fence,
    "",
    "**What to do:**",
    "- If the ticket is already fulfilled: close the issue.",
    `- If something is still missing: add the missing detail in a comment, remove the \`${NEEDS_INPUT_LABEL}\` label and add \`${FACTORY_READY_LABEL}\` again. The next run starts fresh and reads the issue comments.`,
    "",
    noChangeMarker(runId),
  ].join("\n");
}

/**
 * Tells an issue that a run ended done without a PR because there was nothing to change: the comment
 * (skipped when this run's marker is already there), `needs-input` on, `factory-ready` off. The issue
 * stays open for a person to confirm and close. Each step is safe to repeat, so a caller retries the
 * whole sequence after any failure. Throws on the first GitHub error. `redact` applies to the comment
 * body: the summary is model output, and it is redacted before it is truncated so a secret that
 * crosses the cut is still masked. The label swap always happens, even when someone has already
 * commented: only a person setting `factory-ready` again (with `needs-input` removed) restarts the ticket.
 */
export async function reportNoChange(
  github: GitHub,
  repoDir: string,
  issue: number,
  runId: string,
  summary: string,
  redact: (text: string) => string = (t) => t,
): Promise<void> {
  const marker = noChangeMarker(runId);
  const existing: IssueComment[] = await github.issueComments(repoDir, issue);
  if (!existing.some((c) => c.body.includes(marker))) await github.commentIssue(repoDir, issue, redact(renderNoChangeComment(runId, redact(summary))));
  await github.addIssueLabel(repoDir, issue, NEEDS_INPUT_LABEL_SPEC);
  const current = await github.getIssue(repoDir, issue);
  if (current.labels.includes(FACTORY_READY_LABEL)) await github.removeIssueLabel(repoDir, issue, FACTORY_READY_LABEL);
}
