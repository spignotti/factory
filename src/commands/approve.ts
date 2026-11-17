import type { Io } from "./gates.js";
import type { GitHub } from "../gh.js";

export interface ApproveOptions {
  repo: string;
  /** PR number or URL, as `gh pr view` takes it. */
  pr: string;
  /** Head SHA the reviewer looked at: 7 to 40 hex characters. */
  sha: string;
  json: boolean;
}

/** Commit status `factory=success` for a pull request a person reviewed. Never called from the pipeline. */
export async function approveCommand(opts: ApproveOptions, deps: { github: GitHub }, io: Io): Promise<number> {
  const refuse = (reason: string): number => {
    if (opts.json) io.out(JSON.stringify({ ok: false, pr: opts.pr, reason }) + "\n");
    else io.err(`factory: not approved: ${reason}\n`);
    return 1;
  };
  const status = await deps.github.prStatus(opts.repo, opts.pr);
  if (status.state !== "open") return refuse(`${opts.pr} is ${status.state}, not open`);
  if (status.draft) return refuse(`${opts.pr} is a draft; mark it ready for review first`);
  const head = status.headSha?.toLowerCase();
  if (!head || !status.headBranch) return refuse(`could not read the head of ${opts.pr}`);
  if (!head.startsWith(opts.sha.toLowerCase())) return refuse(`head of ${opts.pr} is ${head}, not ${opts.sha}; review the new commits and approve that SHA`);
  if (status.headBranch.startsWith("factory/")) {
    return refuse(`${opts.pr} is a factory branch (${status.headBranch}); the pipeline approves those itself, use factory resume or factory queue batch`);
  }
  await deps.github.approveHead(opts.repo, head);
  if (opts.json) io.out(JSON.stringify({ ok: true, pr: opts.pr, sha: head }) + "\n");
  else io.out(`approved ${opts.pr} at ${head}\n`);
  return 0;
}
