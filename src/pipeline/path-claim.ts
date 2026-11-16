import { resolve } from "node:path";
import type { OpenFactoryPr } from "../gh.js";
import { repoLockId } from "../git.js";
import { realSleep } from "../agents/fake-runner.js";
import { listRuns } from "../runs.js";
import { checkDeadline, type RunContext } from "./context.js";
import { activeHolders, decidePathClaim, lockRepoKey } from "./lock.js";
import { touchesExclusive } from "./overlap.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";

/** Parallel runs or exclusive-path globs need a live claim over the files that will ship. */
export function needsConcurrencyPathClaim(repo: Pick<RepoConfig, "concurrency">): boolean {
  return repo.concurrency.max_runs > 1 || repo.concurrency.exclusive_paths.length > 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Draft whose newest activity (`headChangedAt`: head commit or `updatedAt`) is at least `days` old.
 * Unknown age still blocks. `days <= 0` disables the rule. A branch in `heldBranches` is never stale:
 * a live run still holds it.
 */
export function isStaleDraft(
  pr: Pick<OpenFactoryPr, "draft" | "headChangedAt" | "branch">,
  days: number,
  now: number,
  heldBranches?: ReadonlySet<string>,
): boolean {
  if (pr.draft !== true || days <= 0 || !pr.headChangedAt) return false;
  if (pr.branch && heldBranches?.has(pr.branch)) return false;
  const t = Date.parse(pr.headChangedAt);
  if (!Number.isFinite(t)) return false;
  return now - t >= days * DAY_MS;
}

/**
 * Branches a live lock still holds, keyed by resolved repo path.
 * Liveness is the lock pid (`activeHolders`), the same check as slot takeover. The branch is the
 * holder's run `state.branch`, so a resumed draft stays occupied even when its path claim is narrower than the PR.
 */
export function branchesHeldByLiveRuns(factoryHome: string): Map<string, Set<string>> {
  const live = new Set(activeHolders(factoryHome).map((h) => h.runId).filter((id): id is string => !!id));
  const byRepo = new Map<string, Set<string>>();
  if (!live.size) return byRepo;
  for (const run of listRuns(factoryHome)) {
    if (!live.has(run.run_id)) continue;
    const branch = run.state?.branch;
    const repo = run.state?.repo;
    if (!branch || !repo) continue;
    const key = resolve(repo);
    const held = byRepo.get(key) ?? new Set<string>();
    held.add(branch);
    byRepo.set(key, held);
  }
  return byRepo;
}

export function staleDraftDaysAt(repoDir: string): number {
  try {
    return loadRepoConfig(repoDir).limits.stale_draft_days;
  } catch {
    return 3;
  }
}

export function daysUnchanged(headChangedAt: string, now: number): number {
  return Math.floor((now - Date.parse(headChangedAt)) / DAY_MS);
}

export type ChangedPathBlock = { ok: false; reason: string };

type ClaimCtx = Pick<RunContext, "deps" | "repoDir" | "runId" | "repo" | "lockSlot" | "events" | "deadline" | "releaseLock" | "reacquireLock">;

/**
 * Before push: publish the actual diff paths (not only the plan) and reject overlap with another
 * live run. Open pull requests do not block: a conflict between them is resolved when it happens.
 * `wait` polls without holding the slot, then takes one again (the reacquire respects the wall deadline).
 * A live-run overlap without `--wait` stays a caller-side `needs_human`.
 */
export async function ensureChangedPathClaim(ctx: ClaimCtx, changed: string[], wait: boolean): Promise<{ ok: true } | ChangedPathBlock> {
  const paths = [...new Set(changed)];
  const slot = ctx.lockSlot;
  if (!needsConcurrencyPathClaim(ctx.repo) || slot === undefined) return { ok: true };

  const raw = await repoLockId(ctx.repoDir);
  const key = lockRepoKey(raw);
  const poll = ctx.deps.lockPollMs ?? 15_000;
  const exclusive = touchesExclusive(paths, ctx.repo.concurrency.exclusive_paths);

  for (;;) {
    checkDeadline(ctx);
    const held = ctx.lockSlot;
    if (held === undefined) return { ok: true };
    const decision = decidePathClaim(ctx.deps.factoryHome, raw, held, ctx.runId, { paths, exclusive });
    if (decision.ok) return { ok: true };
    if (decision.kind === "busy") {
      await realSleep(Math.min(poll, 50), ctx.deps.signal);
      continue;
    }
    const reason = `changed files overlap another factory run: ${decision.conflicts.join("; ")}`;
    if (!wait) return { ok: false, reason };
    // Same as intake: the slot is free for the whole sleep, so two finalizing runs cannot deadlock.
    ctx.releaseLock?.();
    ctx.events.emit({ step: "finalize", event: "queued", data: { repo: key, overlap: decision.conflicts, waiter_pid: process.pid } });
    await realSleep(poll, ctx.deps.signal);
    checkDeadline(ctx);
    if ((await ctx.reacquireLock?.()) === undefined) return { ok: false, reason };
  }
}
