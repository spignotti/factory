import type { GitHub, IssueComment, LabelSpec } from "../gh.js";
import { FACTORY_READY_LABEL, NEEDS_INPUT_LABEL } from "../queue/store.js";

export const NEEDS_INPUT_LABEL_SPEC: LabelSpec = {
  name: NEEDS_INPUT_LABEL,
  color: "D93F0B",
  description: "The factory asked questions on this issue",
};

/** Associations of people with write access to the repository. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A comment by someone with write access, or by the account the factory posts as. A body marker proves nothing. */
export function trustedComment(c: Pick<IssueComment, "association" | "viewer_did_author">): boolean {
  return c.viewer_did_author === true || TRUSTED_ASSOCIATIONS.has(c.association ?? "");
}

/** Hidden in the rendered comment. One run never posts its questions twice. */
export function questionsMarker(runId: string): string {
  return `<!-- factory:questions run=${runId} -->`;
}

export function renderQuestionsComment(runId: string, questions: string[]): string {
  // A multi-line question stays inside its list item.
  const items = questions.map((q, i) => `${i + 1}. ${q.trim().replace(/\n/g, "\n   ")}`);
  return [
    `The factory needs answers before it can work on this issue (run \`${runId}\`):`,
    "",
    ...items,
    "",
    `**How to answer:** reply in a comment on this issue, then remove the \`${NEEDS_INPUT_LABEL}\` label and add \`${FACTORY_READY_LABEL}\` again. The next run starts fresh and reads the issue comments.`,
    "",
    questionsMarker(runId),
  ].join("\n");
}

/**
 * Puts a run's questions on its issue: the comment (skipped when this run's marker is already there),
 * `needs-input` on, `factory-ready` off. Each step is safe to repeat, so a caller retries the whole
 * sequence after any failure. Throws on the first GitHub error. `redact` applies to the comment body:
 * questions are model output written after secrets were resolved.
 */
export async function postQuestions(
  github: GitHub,
  repoDir: string,
  issue: number,
  runId: string,
  questions: string[],
  redact: (text: string) => string = (t) => t,
): Promise<void> {
  const marker = questionsMarker(runId);
  const existing: IssueComment[] = await github.issueComments(repoDir, issue);
  if (!existing.some((c) => c.body.includes(marker))) await github.commentIssue(repoDir, issue, redact(renderQuestionsComment(runId, questions)));
  await github.addIssueLabel(repoDir, issue, NEEDS_INPUT_LABEL_SPEC);
  const current = await github.getIssue(repoDir, issue);
  if (current.labels.includes(FACTORY_READY_LABEL)) await github.removeIssueLabel(repoDir, issue, FACTORY_READY_LABEL);
}
