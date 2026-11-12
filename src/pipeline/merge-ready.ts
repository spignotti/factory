/** Commit status the runner posts on a SHA it has verified. The required `done` check reads it. */
export const FACTORY_APPROVAL_CONTEXT = "factory";

/**
 * Auto-merge may finish only when the required `done` check succeeded on this head.
 * A sleeping runner is not consulted: missing or failed `done` blocks the merge.
 * Without `done` in the required set the factory check is not on the merge path.
 */
export function autoMergeCompletes(opts: {
  enabled: boolean;
  requiredChecks: readonly string[];
  checks: readonly { name: string; conclusion: string | null }[];
}): boolean {
  if (!opts.enabled || !opts.requiredChecks.includes("done")) return false;
  return opts.checks.some((check) => check.name === "done" && check.conclusion === "success");
}

/**
 * `auto` and `bot_review` enable merge themselves. `human_review` waits for a person.
 * Finalize, the queue worker, and stats all use this so a self-merge is not a second policy.
 */
export function selfMergePolicy(policy: string | null | undefined): boolean {
  return policy === "auto" || policy === "bot_review";
}

/**
 * An open, non-draft pull request on a self-merge policy whose CI is not green and not red.
 * The short poll can end here. Risk and the merge policy stay. A person is not asked yet.
 */
export function waitingOnMergeCi(opts: {
  policy: string | null | undefined;
  ci: string | null | undefined;
  draft: boolean;
  state: string;
}): boolean {
  return opts.state === "open" && !opts.draft && selfMergePolicy(opts.policy) && opts.ci !== "green" && opts.ci !== "red";
}

/**
 * The runner may ask GitHub to enable auto-merge only for the SHA it approved, once that head is green,
 * and only when `done` is a required check. GitHub enforces the factory status only then.
 * `auto` is the risk policy. `bot_review` is the same merge, and only when this head is the reviewed tree.
 * `human_review` waits for a person. A newer commit, a draft, or CI that is not green does not qualify.
 * Unknown required checks (null, or settings that could not be read) do not qualify. Deploy is not this decision.
 */
export function mayEnableAutoMerge(opts: {
  policy: string | null | undefined;
  approvedSha: string | null | undefined;
  headSha: string | null | undefined;
  /** Required for `bot_review`: the SHA the in-run review finished on. */
  reviewedSha?: string | null;
  ci: string | null | undefined;
  draft: boolean;
  state: string;
  /** Branch protection contexts. Null when settings were unreadable. */
  requiredChecks?: readonly string[] | null;
}): boolean {
  if (!opts.requiredChecks?.includes("done")) return false;
  const aligned =
    opts.state === "open" &&
    !opts.draft &&
    opts.ci === "green" &&
    !!opts.approvedSha &&
    opts.approvedSha === opts.headSha;
  if (!aligned || !selfMergePolicy(opts.policy)) return false;
  if (opts.policy === "bot_review") return !!opts.reviewedSha && opts.reviewedSha === opts.headSha;
  return true;
}
