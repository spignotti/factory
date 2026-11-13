import { createHash } from "node:crypto";
import { changedFiles, commitAll, git, gitOk, headSha, mergeBase } from "../git.js";
import { scopeReport } from "../gates/builtin.js";
import { isProtected, matchesAny, type Plan } from "../schemas/plan.js";
import type { StopCause } from "../events.js";
import { failureSummary, runGates, type GateReport } from "../steps/gates.js";
import { gitAuthor } from "../steps/implement.js";
import type { RunContext } from "./context.js";
import { ensureBudget } from "./recovery.js";

/**
 * Out-of-scope changes the run itself made are not a reviewer suggestion to keep: they are unauthorized
 * edits, and the repair is to remove them. Removal shares the run's persisted repair budget and stops
 * instead of looping; it never touches changes a person made and never reverts protected config.
 */
export const MAX_SCOPE_REPAIRS = 2;

/** A brand-new file with one of these extensions is treated as source code, not a removable deviation. */
const CODE_EXTENSION = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|py|pyi|rb|go|rs|java|kt|scala|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|fish|sql|r|jl|lua|pl|pm|groovy|dart|m|mm|ex|exs|erl|hrl|clj|cljs|d|nim|zig|fs|fsx|vue|svelte)$/i;

/** The resume protocol commits a person's uncommitted worktree edits under the run's identity. */
export const HUMAN_RESUME_SUBJECT = "fix: human changes before resume";

export type ScopeOwnership = "run" | "foreign" | "mixed" | "unattributed" | "protected";

export interface ScopeFinding {
  file: string;
  ownership: ScopeOwnership;
  /** Diff hunk headers against the base: the actionable evidence of what the run changed out of scope. */
  hunks: string[];
}

export interface ScopeFileFacts {
  file: string;
  commits: { authorEmail: string; subject: string }[];
  uncommitted: boolean;
  protectedPath: boolean;
  planned: boolean;
}

/** Ownership in code, from git facts: who introduced this file's deviation from the base. */
export function classifyScopeFile(f: ScopeFileFacts, runEmail: string): ScopeOwnership {
  // Planned and protected files are the task boundary and the human's config: scope cleanup never owns them.
  if (f.planned) return "protected";
  if (f.protectedPath) return "protected";
  if (!f.commits.length) return "unattributed";
  const ours = (c: { authorEmail: string; subject: string }) => c.authorEmail === runEmail && !c.subject.startsWith(HUMAN_RESUME_SUBJECT);
  const run = f.commits.some(ours);
  const other = f.commits.some((c) => !ours(c));
  if (run && other) return "mixed";
  if (other) return "foreign";
  // Committed by the run; any later uncommitted delta on the same file makes attribution uncertain.
  return f.uncommitted ? "mixed" : "run";
}

export const scopeReason = (o: ScopeOwnership): string =>
  o === "foreign"
    ? "authored by someone other than this run; factory never discards changes it does not own"
    : o === "mixed"
      ? "factory and foreign changes share this file; the unauthorized hunks cannot be removed on their own"
      : o === "unattributed"
        ? "changed outside a factory commit; ownership is uncertain"
        : o === "protected"
          ? "protected config or a planned file; only protected_changes and a human may change it"
          : "authorized";

export function scopeEvidence(findings: ScopeFinding[]): string {
  return findings
    .map((f) => `- ${f.file} [${scopeReason(f.ownership)}]${f.hunks.length ? `: ${f.hunks.join(" ")}` : ""}`)
    .join("\n");
}

/** The deviation set as content, order-stable: the same files with the same hunks fingerprint the same. */
export function scopeFingerprint(findings: ScopeFinding[]): string {
  const parts = findings
    .map((f) => `${f.file}\u001f${[...f.hunks].sort().join(" ")}`)
    .sort()
    .join("\u001e");
  return createHash("sha256").update(parts).digest("hex");
}

export interface ScopeBudgetView {
  scopeRepairs: number;
  scopeLast?: string;
}

export type ScopePlan =
  | { action: "clean" }
  | { action: "remove"; findings: ScopeFinding[]; fingerprint: string }
  | { action: "stop"; cause: StopCause; reason: string };

/**
 * One scope verdict over the current deviations. Foreign, uncertain, mixed or protected changes are a
 * decision and stop the cleanup before anything is touched. A deviation set that returns unchanged
 * after a repair is an unchanged failure: asking, not looping. The attempt cap is the shared budget.
 */
export function planScopeRepair(findings: ScopeFinding[], budget: ScopeBudgetView, runId: string): ScopePlan {
  if (!findings.length) return { action: "clean" };
  const blocked = findings.filter((f) => f.ownership !== "run");
  if (blocked.length) {
    return {
      action: "stop",
      cause: "explicit_decision",
      reason:
        `out-of-scope changes this run must not remove on its own:\n${scopeEvidence(blocked)}\n` +
        `Decision needed: are these changes part of the task? If they are, the task must say so (a new run with that scope); ` +
        `if not, revert them yourself, then factory resume ${runId}. Factory will not amend the task and will not discard these changes.`,
    };
  }
  if (budget.scopeRepairs >= MAX_SCOPE_REPAIRS) {
    return {
      action: "stop",
      cause: "budget_exhausted",
      reason:
        `scope repair budget exhausted (${budget.scopeRepairs}/${MAX_SCOPE_REPAIRS}): out-of-scope changes keep returning:\n${scopeEvidence(findings)}\n` +
        `The fix keeps re-adding what the repair removed. Decide: is this scope genuinely necessary (then the task must name it), ` +
        `or must the approach change? Then factory resume ${runId}.`,
    };
  }
  const fingerprint = scopeFingerprint(findings);
  if (budget.scopeLast === fingerprint) {
    return {
      action: "stop",
      cause: "explicit_decision",
      reason:
        `the same out-of-scope changes returned unchanged after the previous repair:\n${scopeEvidence(findings)}\n` +
        `Removing them again would loop the same failure. Decision needed: either this scope is genuinely necessary ` +
        `and the task must name it, or the approach must not produce it. Then factory resume ${runId}.`,
    };
  }
  return { action: "remove", findings, fingerprint };
}

const HUNK_LIMIT = 12;

/** Diff hunk headers vs the merge base; a binary file names itself instead. */
export function scopeHunks(diff: string): string[] {
  const lines = diff.split("\n");
  const binary = lines.find((l) => l.startsWith("Binary files "));
  if (binary) return [`${binary.trim()} (binary artifact)`];
  return lines.filter((l) => l.startsWith("@@ ")).slice(0, HUNK_LIMIT);
}

export async function collectScopeFindings(
  worktree: string,
  baseSha: string,
  plan: Plan,
  humanOnly: string[],
  runEmail: string,
  /** Concurrency-significant paths (migrations) and security-trigger paths: never auto-removed. */
  keepPaths: string[] = [],
): Promise<ScopeFinding[]> {
  const changed = await changedFiles(worktree, baseSha);
  // Out-of-scope means "changed outside the plan" — but protected/concurrency/security paths are not
  // removable deviations: the overlap claim and the security reviewer own those.
  const deviations = scopeReport(plan, changed).filter((f) => !matchesAny(f, keepPaths));
  if (!deviations.length) return [];
  const mb = await mergeBase(worktree, baseSha);
  const planned = plan.packages.flatMap((p) => p.files);
  const findings: ScopeFinding[] = [];
  for (const file of deviations) {
    const diff = await git(worktree, ["diff", "--no-color", "-U0", "--no-renames", mb, "--", `:(literal)${file}`]);
    const hunks = scopeHunks(diff);
    const out = await git(worktree, ["log", "--no-merges", "--format=%ae%x1f%s", `${mb}..HEAD`, "--", `:(literal)${file}`]);
    const commits = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [authorEmail = "", ...rest] = l.split("\u001f");
        return { authorEmail: authorEmail.trim(), subject: rest.join("\u001f").trim() };
      });
    const uncommitted = (await git(worktree, ["status", "--porcelain", "--", `:(literal)${file}`])).trim() !== "";
    const facts: ScopeFileFacts = {
      file,
      commits,
      uncommitted,
      protectedPath: isProtected(file, humanOnly),
      planned: planned.includes(file) || matchesAny(file, planned),
    };
    findings.push({ file, ownership: classifyScopeFile(facts, runEmail), hunks });
  }
  return findings;
}

export type ScopeRepair =
  | { action: "clean" }
  | { action: "repaired"; gates: GateReport; findings: ScopeFinding[] }
  | { action: "stop"; cause: StopCause; reason: string };

/** Remove the deviation files in the worktree: tracked files return to their base state, added files go away. */
async function removeDeviations(worktree: string, mb: string, findings: ScopeFinding[]): Promise<string[]> {
  const removed: string[] = [];
  for (const f of findings) {
    if (await gitOk(worktree, ["cat-file", "-e", `${mb}:${f.file}`])) {
      await git(worktree, ["checkout", mb, "--", `:(literal)${f.file}`]);
    } else {
      await git(worktree, ["rm", "-q", "-f", "--", `:(literal)${f.file}`]).catch(async () => {
        // untracked and not in base: nothing for git rm to untrack; drop the file itself
        const { rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        rmSync(join(worktree, f.file), { force: true });
      });
    }
    removed.push(f.file);
  }
  return removed;
}

async function restoreDeviations(worktree: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await git(worktree, ["checkout", "HEAD", "--", ...files.map((f) => `:(literal)${f}`)]);
}

/**
 * The bounded scope repair of one loop entry: detect out-of-scope changes, decide in code, and for a
 * removable run-owned set remove it, re-run the gates and continue on the resulting head. A removal
 * that turns the gates red proves the extra scope was genuinely necessary: nothing is kept removed,
 * and the run stops with a specific explanation and question instead of amending the task.
 */
export async function repairScope(ctx: RunContext, gates: GateReport): Promise<ScopeRepair> {
  const keepPaths = [...ctx.repo.human_only_paths, ...ctx.repo.sensitive_paths, ...ctx.repo.concurrency.exclusive_paths];
  const findings = await collectScopeFindings(ctx.worktree, ctx.baseSha, ctx.plan, ctx.repo.human_only_paths, gitAuthor(ctx).email, keepPaths);
  if (!findings.length) return { action: "clean" };
  ctx.events.emit({
    step: "review",
    event: "progress",
    data: { scope_finding: findings.map((f) => ({ file: f.file, ownership: f.ownership, hunks: f.hunks })) },
  });
  const budget = ensureBudget(ctx);
  const plan = planScopeRepair(findings, budget, ctx.runId);
  if (plan.action === "stop") {
    ctx.events.emit({ step: "review", event: "progress", data: { scope_repair_stop: { cause: plan.cause, reason: plan.reason } } });
    return { action: "stop", cause: plan.cause, reason: plan.reason };
  }
  if (plan.action === "clean") return { action: "clean" };

  const mb = await mergeBase(ctx.worktree, ctx.baseSha);
  const packages = ctx.plan.packages.map((p) => p.id);
  const tier = gates.tier === "full" ? "full" : "fast";
  const removed = await removeDeviations(ctx.worktree, mb, plan.findings);
  const after = await runGates(ctx, tier, packages);
  if (!after.green) {
    await restoreDeviations(ctx.worktree, removed);
    const reason =
      `removing the out-of-scope changes made the gates red (${failureSummary(after)}).\n` +
      `The unauthorized changes below are load-bearing for what the run built:\n${scopeEvidence(plan.findings)}\n` +
      `Decision needed: this extra scope appears genuinely necessary, but the task does not cover it and factory will not ` +
      `amend the task quietly. Confirm whether ${removed.map((f) => `\`${f}\``).join(", ")} belong to this work ` +
      `(then run factory with that scope, or declare them in the plan's protected/authorized files), ` +
      `or rework without them; then factory resume ${ctx.runId}. Nothing was kept removed.`;
    ctx.events.emit({ step: "review", event: "progress", data: { scope_repair_needed: { files: removed, restored: true } } });
    return { action: "stop", cause: "explicit_decision", reason };
  }
  // The removal is safe, but a brand-new source file is likely genuine (if unplanned) work or a
  // concurrency-relevant change — the overlap claim and the reviewers own it, not scope cleanup.
  // Restore those and commit only the clearly-junk removals: binary artifacts, non-code files, and
  // out-of-plan edits to files that already exist at the base.
  const restore: string[] = [];
  const kept: string[] = [];
  for (const f of plan.findings) {
    const existsInBase = await gitOk(ctx.worktree, ["cat-file", "-e", `${mb}:${f.file}`]);
    if (!existsInBase && CODE_EXTENSION.test(f.file)) restore.push(f.file);
    else kept.push(f.file);
  }
  if (restore.length) await restoreDeviations(ctx.worktree, restore);
  if (!kept.length) return { action: "clean" };
  await commitAll(ctx.worktree, `fix: remove out-of-scope changes (${kept.join(", ")})`, gitAuthor(ctx));
  budget.scopeRepairs += 1;
  budget.scopeLast = plan.fingerprint;
  ctx.persist?.();
  ctx.events.emit({
    step: "review",
    event: "progress",
    data: { scope_repair: { removed: kept, restored: restore, attempts: budget.scopeRepairs, max: MAX_SCOPE_REPAIRS, head: await headSha(ctx.worktree) } },
  });
  return { action: "repaired", gates: after, findings: plan.findings.filter((f) => kept.includes(f.file)) };
}
