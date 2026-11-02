import { repoLockId } from "../git.js";
import { realSleep } from "../agents/fake-runner.js";
import type { RunContext } from "./context.js";
import { decidePathClaim } from "./lock.js";
import { lockRepoKey } from "./lock.js";
import { touchesExclusive } from "./overlap.js";
import type { RepoConfig } from "../schemas/repo.js";

/** Parallel runs or exclusive-path globs need a live claim over the files that will ship. */
export function needsConcurrencyPathClaim(repo: Pick<RepoConfig, "concurrency">): boolean {
  return repo.concurrency.max_runs > 1 || repo.concurrency.exclusive_paths.length > 0;
}

/**
 * Before push: publish the actual diff paths (not only the plan) and reject overlap with another
 * live run. `wait` polls at finalize the same way as `--wait` at intake.
 */
export async function ensureChangedPathClaim(
  ctx: Pick<RunContext, "deps" | "repoDir" | "runId" | "repo" | "lockSlot" | "events">,
  changed: string[],
  wait: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!needsConcurrencyPathClaim(ctx.repo)) return { ok: true };
  const slot = ctx.lockSlot;
  if (slot === undefined) return { ok: true };

  const raw = await repoLockId(ctx.repoDir);
  const key = lockRepoKey(raw);
  const poll = ctx.deps.lockPollMs ?? 15_000;
  const paths = [...new Set(changed)];
  const exclusive = touchesExclusive(paths, ctx.repo.concurrency.exclusive_paths);

  for (;;) {
    const decision = decidePathClaim(ctx.deps.factoryHome, raw, slot, ctx.runId, { paths, exclusive });
    if (decision.ok) return { ok: true };
    if (decision.kind === "busy") {
      await realSleep(Math.min(poll, 50), ctx.deps.signal);
      continue;
    }
    const reason = `changed files overlap another factory run: ${decision.conflicts.join("; ")}`;
    if (!wait) return { ok: false, reason };
    ctx.events.emit({ step: "finalize", event: "queued", data: { repo: key, overlap: decision.conflicts } });
    await realSleep(poll, ctx.deps.signal);
  }
}
