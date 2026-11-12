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
 * The runner may ask GitHub to enable auto-merge only for the SHA it approved, once that head is green.
 * A newer commit, a draft, or CI that is not green does not qualify.
 */
export function mayEnableAutoMerge(opts: {
  policy: string | null | undefined;
  approvedSha: string | null | undefined;
  headSha: string | null | undefined;
  ci: string | null | undefined;
  draft: boolean;
  state: string;
}): boolean {
  return (
    opts.policy === "auto" &&
    opts.state === "open" &&
    !opts.draft &&
    opts.ci === "green" &&
    !!opts.approvedSha &&
    opts.approvedSha === opts.headSha
  );
}
