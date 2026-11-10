import type { GitHub, OpenFactoryPr } from "../gh.js";
import { repoLockId } from "../git.js";
import { realSleep } from "../agents/fake-runner.js";
import { checkDeadline, type RunContext } from "./context.js";
import { decidePathClaim, lockRepoKey } from "./lock.js";
import { pathsOverlap, touchesExclusive } from "./overlap.js";
import type { RepoConfig } from "../schemas/repo.js";

/** Parallel runs or exclusive-path globs need a live claim over the files that will ship. */
export function needsConcurrencyPathClaim(repo: Pick<RepoConfig, "concurrency">): boolean {
  return repo.concurrency.max_runs > 1 || repo.concurrency.exclusive_paths.length > 0;
}

export interface FactoryPrHit {
  number: number;
  files: string[];
}

/** Open `factory/*` PRs (other than this run's branch) whose files overlap `paths`. */
export function factoryPrOverlaps(prs: OpenFactoryPr[], paths: string[], ownBranch?: string): FactoryPrHit[] {
  if (!paths.length) return [];
  const hits: FactoryPrHit[] = [];
  for (const pr of prs) {
    if (!pr.branch.startsWith("factory/")) continue;
    if (ownBranch && pr.branch === ownBranch) continue;
    const files = [...new Set(pr.files.filter((f) => paths.some((p) => pathsOverlap(p, f))))];
    if (files.length) hits.push({ number: pr.number, files });
  }
  return hits;
}

export function factoryPrOverlapReason(when: "planned" | "changed", hits: FactoryPrHit[]): string {
  const listed = hits.map((h) => `#${h.number} (${h.files.slice(0, 8).join(", ")})`).join("; ");
  return `${when} paths overlap open factory PR ${listed}`;
}

export async function openFactoryPrOverlap(github: GitHub, repoDir: string, paths: string[], ownBranch?: string): Promise<FactoryPrHit[]> {
  if (!paths.length) return [];
  return factoryPrOverlaps(await github.openFactoryPrFiles(repoDir), paths, ownBranch);
}

export type ChangedPathBlock = { ok: false; reason: string; kind: "run" | "pr" };

type ClaimCtx = Pick<RunContext, "deps" | "repoDir" | "runId" | "repo" | "lockSlot" | "events" | "deadline" | "branch" | "releaseLock" | "reacquireLock">;

/**
 * Before push: publish the actual diff paths (not only the plan) and reject overlap with another
 * live run or with an open `factory/*` PR. `wait` polls without holding the slot, then takes one again.
 * A live-run overlap without `--wait` stays a caller-side `needs_human`; an open-PR overlap is `pr`
 * so the run ends `locked` with the PR number in the reason.
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
    const hits = await openFactoryPrOverlap(ctx.deps.github, ctx.repoDir, paths, ctx.branch);
    if (hits.length) {
      const reason = factoryPrOverlapReason("changed", hits);
      const waited = await waitOut(reason, hits.map((h) => `#${h.number} (${h.files.slice(0, 8).join(", ")})`), "pr");
      if (waited !== "retry") return waited;
      continue;
    }
    if (!live) return { ok: true };
    const slot = ctx.lockSlot;
    if (slot === undefined) return { ok: true };
    const decision = decidePathClaim(ctx.deps.factoryHome, raw, slot, ctx.runId, { paths, exclusive });
    if (decision.ok) return { ok: true };
    if (decision.kind === "busy") {
      await realSleep(Math.min(poll, 50), ctx.deps.signal);
      continue;
    }
    const reason = `changed files overlap another factory run: ${decision.conflicts.join("; ")}`;
    const waited = await waitOut(reason, decision.conflicts, "run");
    if (waited !== "retry") return waited;
  }
}
