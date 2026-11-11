import { resolve } from "node:path";
import { IncompletePrListError, type GitHub, type OpenFactoryPr } from "../gh.js";
import { repoLockId } from "../git.js";
import { realSleep } from "../agents/fake-runner.js";
import { Interrupted } from "../interrupt.js";
import { listRuns } from "../runs.js";
import { checkDeadline, type RunContext, WallTimeExceeded } from "./context.js";
import { activeHolders, decidePathClaim, lockRepoKey } from "./lock.js";
import { pathsOverlap, touchesExclusive } from "./overlap.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";

/** Parallel runs or exclusive-path globs need a live claim over the files that will ship. */
export function needsConcurrencyPathClaim(repo: Pick<RepoConfig, "concurrency">): boolean {
  return repo.concurrency.max_runs > 1 || repo.concurrency.exclusive_paths.length > 0;
}

export interface FactoryPrHit {
  number: number;
  files: string[];
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

/** Open `factory/*` PRs (other than this run's branch) whose files overlap `paths`. Stale drafts are ignored. */
export function factoryPrOverlaps(
  prs: OpenFactoryPr[],
  paths: string[],
  ownBranch?: string,
  opts?: { staleDraftDays?: number; now?: number; heldBranches?: ReadonlySet<string> },
): FactoryPrHit[] {
  if (!paths.length) return [];
  const days = opts?.staleDraftDays ?? 3;
  const now = opts?.now ?? Date.now();
  const hits: FactoryPrHit[] = [];
  for (const pr of prs) {
    if (!pr.branch.startsWith("factory/")) continue;
    if (ownBranch && pr.branch === ownBranch) continue;
    if (isStaleDraft(pr, days, now, opts?.heldBranches)) continue;
    const files = [...new Set(pr.files.filter((f) => paths.some((p) => pathsOverlap(p, f))))];
    if (files.length) hits.push({ number: pr.number, files });
  }
  return hits;
}

export function factoryPrOverlapReason(when: "planned" | "changed", hits: FactoryPrHit[]): string {
  const listed = hits.map((h) => `#${h.number} (${h.files.slice(0, 8).join(", ")})`).join("; ");
  return `${when} paths overlap open factory PR ${listed}`;
}

export async function openFactoryPrOverlap(
  github: GitHub,
  repoDir: string,
  paths: string[],
  ownBranch: string | undefined,
  factoryHome: string,
  now = Date.now(),
): Promise<FactoryPrHit[]> {
  if (!paths.length) return [];
  const heldBranches = branchesHeldByLiveRuns(factoryHome).get(resolve(repoDir));
  return factoryPrOverlaps(await github.openFactoryPrFiles(repoDir), paths, ownBranch, { staleDraftDays: staleDraftDaysAt(repoDir), now, ...(heldBranches ? { heldBranches } : {}) });
}

export type ChangedPathBlock = { ok: false; reason: string; kind: "run" | "pr" | "github" };

type ClaimCtx = Pick<RunContext, "deps" | "repoDir" | "runId" | "repo" | "lockSlot" | "events" | "deadline" | "branch" | "releaseLock" | "reacquireLock">;

function rethrowClaimSignal(e: unknown, signal?: AbortSignal): void {
  if (e instanceof WallTimeExceeded || e instanceof Interrupted || signal?.aborted) throw e;
}

/**
 * Before push: publish the actual diff paths (not only the plan) and reject overlap with another
 * live run or with an open `factory/*` PR. The live claim is published before the PR list is read:
 * a neighbor that opens its PR and drops its slot in that window is still visible as one or the other.
 * `wait` polls without holding the slot, then takes one again (the reacquire respects the wall deadline).
 * A live-run overlap without `--wait` stays a caller-side `needs_human`; an open-PR overlap is `pr`
 * so the run ends `locked` with the PR number in the reason. A failed list query is `github` (resumable),
 * not an exception that fails the run.
 */
export async function ensureChangedPathClaim(ctx: ClaimCtx, changed: string[], wait: boolean): Promise<{ ok: true } | ChangedPathBlock> {
  const paths = [...new Set(changed)];
  const live = needsConcurrencyPathClaim(ctx.repo) && ctx.lockSlot !== undefined;
  if (!live && !paths.length) return { ok: true };

  const raw = await repoLockId(ctx.repoDir);
  const key = lockRepoKey(raw);
  const poll = ctx.deps.lockPollMs ?? 15_000;
  const exclusive = touchesExclusive(paths, ctx.repo.concurrency.exclusive_paths);

  const waitOut = async (reason: string, overlap: string[], kind: "run" | "pr"): Promise<{ ok: true } | ChangedPathBlock | "retry"> => {
    if (!wait) {
      // An open PR outlives the slot: drop it now so the locked run is not still holding one.
      if (kind === "pr") ctx.releaseLock?.();
      return { ok: false, reason, kind };
    }
    // Same as intake: the slot is free for the whole sleep, so two finalizing runs cannot deadlock.
    ctx.releaseLock?.();
    ctx.events.emit({ step: "finalize", event: "queued", data: { repo: key, overlap, waiter_pid: process.pid } });
    await realSleep(poll, ctx.deps.signal);
    checkDeadline(ctx);
    const slot = await ctx.reacquireLock?.();
    if (slot === undefined) return { ok: false, reason, kind };
    return "retry";
  };

  for (;;) {
    checkDeadline(ctx);
    // Publish first. A query that returns empty, then a neighbor's PR open + slot drop, must not
    // both miss: the neighbor either still holds this claim or is already in the list we read next.
    if (live) {
      const slot = ctx.lockSlot;
      if (slot === undefined) return { ok: true };
      const decision = decidePathClaim(ctx.deps.factoryHome, raw, slot, ctx.runId, { paths, exclusive });
      if (!decision.ok) {
        if (decision.kind === "busy") {
          await realSleep(Math.min(poll, 50), ctx.deps.signal);
          continue;
        }
        const reason = `changed files overlap another factory run: ${decision.conflicts.join("; ")}`;
        const waited = await waitOut(reason, decision.conflicts, "run");
        if (waited !== "retry") return waited;
        continue;
      }
    }
    let hits: FactoryPrHit[];
    try {
      hits = await openFactoryPrOverlap(ctx.deps.github, ctx.repoDir, paths, ctx.branch, ctx.deps.factoryHome);
    } catch (e) {
      rethrowClaimSignal(e, ctx.deps.signal);
      if (e instanceof IncompletePrListError) {
        const waited = await waitOut(e.message, [e.message], "pr");
        if (waited !== "retry") return waited;
        continue;
      }
      return { ok: false, kind: "github", reason: (e as Error).message };
    }
    if (hits.length) {
      const reason = factoryPrOverlapReason("changed", hits);
      const waited = await waitOut(reason, hits.map((h) => `#${h.number} (${h.files.slice(0, 8).join(", ")})`), "pr");
      if (waited !== "retry") return waited;
      continue;
    }
    return { ok: true };
  }
}
