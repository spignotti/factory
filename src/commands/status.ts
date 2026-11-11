import { statSync } from "node:fs";
import { join } from "node:path";
import type { GitHub, PrStatus } from "../gh.js";
import { activeHolders } from "../pipeline/lock.js";
import { daysUnchanged, isStaleDraft, staleDraftDaysAt } from "../pipeline/path-claim.js";
import { openAuditTickets } from "../proposals.js";
import { loadRepoConfig } from "../schemas/repo.js";
import { listRuns, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";
import type { z } from "zod";
import type { StatusReportSchema } from "../schemas/reports.js";
import { currentCheckName, currentStepRetry, eventsForRun, isQueuedWaiter, lastEventMs, orphanedRunIds, queuedFromEvents } from "../run-health.js";
import { summarizeQueues } from "../queue/store.js";
import { parseSince } from "./stats.js";

/** `factory status --json` (schema `schemas/status.schema.json`). */
export type StatusReport = z.infer<typeof StatusReportSchema>;

const repoOf = (r: RunRecord) => r.state?.repo ?? r.result?.repo ?? "";
const taskOf = (r: RunRecord) => r.state?.task.ref ?? r.result?.task ?? "";

const RISK = new Set(["low", "medium", "high"]);
const DIFF_REASON = /^diff \d+ lines > \d+$/;

/** Bucket a `riskClass` reason. The review-exit `reason` is not a risk cause. */
function riskCause(reason: string): "diff size" | "protected paths" | "risk" {
  if (DIFF_REASON.test(reason) || /\bdiff size\b|max_diff_lines/i.test(reason)) return "diff size";
  if (/human_only_paths|protected/i.test(reason)) return "protected paths";
  return "risk";
}

/**
 * Why a done `human_review` PR is not auto-merged, from `result.json` `risk_reasons` only.
 * Labels are `risk`, `diff size`, `protected paths`; the `riskClass` strings follow so a medium
 * rating is not collapsed to `risk`. A low rating with no reasons is the policy, not the review exit.
 */
function humanReviewReasons(input: { risk_reasons?: string[]; risk?: string | null }): string[] {
  const reasons = input.risk_reasons ?? [];
  const causes = new Set(reasons.map(riskCause));
  const out: string[] = [];
  if (causes.has("risk") || ((input.risk === "medium" || input.risk === "high") && reasons.length === 0)) out.push("risk");
  if (causes.has("diff size")) out.push("diff size");
  if (causes.has("protected paths")) out.push("protected paths");
  if (!out.length) out.push("human_review");
  return [...out, ...reasons];
}

function resultFinishedMs(run: RunRecord): number | undefined {
  if (!run.result) return undefined;
  try {
    return statSync(join(run.dir, "result.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

function blockersOf(result: string, live: PrStatus | undefined, prError: string | undefined): string[] {
  const out: string[] = [];
  if (live?.draft) out.push("draft");
  if (live?.ci === "red") out.push("CI red");
  if (live?.ci === "pending") out.push("CI pending");
  // `none` and a rollup that was not read are not green: an empty check list must not land in human_review.
  if (live && live.ci !== "green" && live.ci !== "red" && live.ci !== "pending") out.push(live.ci === "none" ? "CI none" : "CI missing");
  if (live?.behind) out.push("behind");
  if (live?.conflicting) out.push("conflicting");
  if (result === "needs_human") out.push("needs_human");
  if (prError) out.push("pr status unknown");
  return out;
}

/**
 * Overnight summary. Reads `result.json` (mtime is when the run finished) and live PR state.
 * Does not read `events.jsonl`: that file is the trace, not this view.
 */
async function sinceFinished(
  runs: RunRecord[],
  opts: {
    since: string;
    now: number;
    skip: Set<string>;
    loadPr: (repo: string, pr: string) => Promise<PrStatus | Error>;
  },
): Promise<NonNullable<StatusReport["since"]>> {
  const span = parseSince(opts.since);
  const from = opts.now - span;
  const view: NonNullable<StatusReport["since"]> = {
    since: opts.since,
    from: new Date(from).toISOString(),
    merged: [],
    human_review: [],
    blocked: [],
    failed: [],
    base_red: [],
    needs_input: [],
  };
  const recent = runs.filter((r) => {
    if (opts.skip.has(r.run_id)) return false;
    const finished = resultFinishedMs(r);
    return finished !== undefined && finished >= from;
  });
  recent.sort((a, b) => b.run_id.localeCompare(a.run_id));
  for (const r of recent) {
    const res = r.result!;
    const kind = res.result;
    if (typeof kind !== "string") continue;
    const row = { run_id: r.run_id, repo: res.repo ?? "", task: res.task ?? "" };
    const reason = res.reason ?? "";
    if (kind === "failed") {
      view.failed.push({ ...row, reason, pr: res.pr ?? null });
      continue;
    }
    if (kind === "base_red") {
      view.base_red.push({ ...row, reason });
      continue;
    }
    if (kind === "needs_input") {
      view.needs_input.push({ ...row, reason, questions: res.questions ?? [] });
      continue;
    }
    if (kind !== "done" && kind !== "needs_human") continue;
    let live: PrStatus | undefined;
    let prError: string | undefined;
    if (res.pr) {
      const got = await opts.loadPr(res.repo ?? "", res.pr);
      if (got instanceof Error) prError = got.message.slice(0, 200);
      else live = got;
    }
    // A thrown prStatus is not proof the PR is still open (it may already be merged).
    if (live && live.state !== "open" && res.pr) {
      view.merged.push({ ...row, pr: res.pr, pr_state: live.state === "closed" ? "closed" : "merged", result: kind });
      continue;
    }
    const blockers = blockersOf(kind, live, prError);
    if (blockers.length && (res.pr || kind === "needs_human")) {
      view.blocked.push({ ...row, pr: res.pr ?? null, blockers, reason, ...(prError ? { error: prError } : {}) });
      continue;
    }
    if (live?.state === "open" && res.pr && kind === "done" && res.merge_policy === "human_review" && live.ci === "green" && !live.behind && !live.conflicting) {
      const risk = res.risk && RISK.has(res.risk) ? res.risk : null;
      view.human_review.push({ ...row, pr: res.pr, risk, review_reasons: humanReviewReasons({ risk_reasons: res.risk_reasons, risk: res.risk }) });
    }
  }
  return view;
}

export async function statusReport(opts: { factoryHome: string; github: GitHub; since?: string; now?: () => number }): Promise<StatusReport> {
  const now = opts.now?.() ?? Date.now();
  const holders = new Map(activeHolders(opts.factoryHome).filter((h) => h.runId).map((h) => [h.runId!, h.pid]));
  const orphanedIds = orphanedRunIds(opts.factoryHome);
  const report: StatusReport = {
    generated_at: new Date(now).toISOString(),
    running: [],
    queued: [],
    waiting: [],
    interrupted: [],
    orphaned: [],
    stalled: [],
    prs: [],
    stale_drafts: [],
    audit_tickets: openAuditTickets(opts.factoryHome),
    queues: summarizeQueues(opts.factoryHome),
    since: null,
  };
  const prCache = new Map<string, Promise<PrStatus | Error>>();
  const loadPr = (repo: string, pr: string) => {
    if (!prCache.has(pr)) prCache.set(pr, opts.github.prStatus(repo, pr).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
    return prCache.get(pr)!;
  };

  const runs = listRuns(opts.factoryHome);
  for (const r of runs) {
    const events = eventsForRun(r);
    // A current lock holder is running, even if an earlier `queued` (e.g. path overlap) has no
    // matching lock_acquired event.
    if (!holders.has(r.run_id) && isQueuedWaiter(r, events)) {
      const q = queuedFromEvents(events);
      const lockRepo = events.findLast((e) => e.event === "queued")?.data.repo;
      report.queued.push({
        run_id: r.run_id,
        repo: typeof lockRepo === "string" ? lockRepo : repoOf(r),
        task: taskOf(r) || r.result?.task || "",
        holder_run_id: q.holder_run_id,
        holder_pid: q.holder_pid,
        minutes: Math.round(((now - r.started_at.getTime()) / 60_000) * 10) / 10,
      });
      continue;
    }

    const st = r.state;
    if (!st) continue;
    const pid = holders.get(r.run_id);
    if (pid !== undefined) {
      const entry = {
        run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step, lane: st.lane ?? "standard", pid,
        minutes: Math.round(((now - r.started_at.getTime()) / 60_000) * 10) / 10, branch: st.branch, pr: st.pr,
        check: currentCheckName(events),
        retry: currentStepRetry(events),
      };
      report.running.push(entry);
      try {
        const stallMin = loadRepoConfig(st.repo).limits.stall_minutes;
        const lastMs = lastEventMs(events);
        if (lastMs !== undefined && now - lastMs > 2 * stallMin * 60_000) {
          report.stalled.push({ ...entry, silent_minutes: Math.round(((now - lastMs) / 60_000) * 10) / 10 });
        }
      } catch {
        // repo config unreadable: stall not determinable
      }
      continue;
    }
    if (st.result === null && st.step !== "finished") {
      const row = { run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step };
      if (orphanedIds.has(r.run_id)) report.orphaned.push(row);
      else report.interrupted.push(row);
      continue;
    }
    let pr: PrStatus | Error | undefined;
    if (st.pr && !st.gc_at) pr = await loadPr(repoOf(r), st.pr);
    const closed = pr && !(pr instanceof Error) && pr.state !== "open";
    if ((st.result === "needs_human" || st.result === "needs_input") && !closed && !st.gc_at) {
      report.waiting.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), result: st.result, reason: st.reason,
        questions: r.result?.questions ?? [], pr: st.pr, branch: st.branch, worktree: st.worktree,
      });
    }
    if (st.pr && pr && !closed) {
      report.prs.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), pr: st.pr,
        state: pr instanceof Error ? "unknown" : "open", draft: pr instanceof Error ? null : pr.draft,
        merge_policy: r.result?.merge_policy ?? null, risk: r.result?.risk ?? null, result: st.result,
        ...(pr instanceof Error ? { error: pr.message.slice(0, 200) } : {}),
      });
    }
  }
  if (opts.since) {
    const skip = new Set([...report.running, ...report.queued, ...report.interrupted, ...report.orphaned, ...report.stalled].map((r) => r.run_id));
    report.since = await sinceFinished(runs, { since: opts.since, now, skip, loadPr });
  }
  const repos = new Set<string>([...runs.map(repoOf), ...report.queues.map((q) => q.repo)].filter((r) => r.length > 0));
  for (const repo of [...repos].sort()) {
    let open;
    try {
      open = await opts.github.openFactoryPrFiles(repo);
    } catch {
      continue;
    }
    const days = staleDraftDaysAt(repo);
    for (const pr of open) {
      if (!isStaleDraft(pr, days, now) || !pr.headChangedAt) continue;
      report.stale_drafts.push({ repo, pr: pr.number, branch: pr.branch, days_unchanged: daysUnchanged(pr.headChangedAt, now) });
    }
  }
  report.stale_drafts.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
  return report;
}

function retryNote(retry: StatusReport["running"][number]["retry"]): string {
  if (!retry) return "";
  const pkg = retry.package ? ` ${retry.package}` : "";
  return ` [${retry.class} retry ${retry.attempt}/${retry.max}${pkg}]`;
}

function reviewText(reasons: string[], risk: string | null): string {
  return reasons.map((r) => (r === "risk" && risk ? `risk ${risk}` : r)).join(", ");
}

export function renderStatus(s: StatusReport): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => out.push(`${title} (${lines.length})${lines.length ? `:\n${lines.map((l) => `  ${l}`).join("\n")}` : ""}`);
  section("running", s.running.map((r) => `${r.run_id} ${r.task} — ${r.step}${r.check ? ` (${r.check})` : ""}${retryNote(r.retry)}, ${r.lane}, ${r.minutes} min (${r.repo})`));
  section("queues", s.queues.map((q) => {
    const next = q.next.map((n) => {
      const extra = n.status === "running" && n.run_id ? ` ${n.run_id}` : n.reason ? ` ${n.reason}` : "";
      return `#${n.issue} ${n.status}${extra}`;
    }).join(", ");
    return `${q.repo} — pending ${q.pending}, running ${q.running}, parked ${q.parked}${next ? `; next ${next}` : ""}`;
  }));
  section("queued", s.queued.map((r) => `${r.run_id} ${r.task} — waiting for lock (holder ${r.holder_run_id ?? "?"}), ${r.minutes} min (${r.repo})`));
  section("stalled", s.stalled.map((r) => `${r.run_id} ${r.task} — no event for ${r.silent_minutes} min, still in ${r.step}${r.check ? ` (${r.check})` : ""}${retryNote(r.retry)} (${r.repo})`));
  section("waiting", s.waiting.map((r) => `${r.run_id} ${r.task} — ${r.result}: ${r.reason}${r.pr ? ` ${r.pr}` : ""}`));
  section("orphaned", s.orphaned.map((r) => `${r.run_id} ${r.task} — lock holder gone in ${r.step}; factory resume ${r.run_id} or factory status`));
  section("interrupted", s.interrupted.map((r) => `${r.run_id} ${r.task} — stopped in ${r.step}; factory resume ${r.run_id}`));
  section("open PRs", s.prs.map((p) => `${p.pr} ${p.task} — ${p.state}${p.draft ? ", draft" : ""}, merge policy ${p.merge_policy ?? "?"}, risk ${p.risk ?? "?"}`));
  section("stale drafts", s.stale_drafts.map((p) => `#${p.pr} ${p.branch} — head unchanged for ${p.days_unchanged} days; close the PR or resume the run (${p.repo})`));
  section("open audit tickets", s.audit_tickets.map((t) => `${t.repo} [${t.type}] ${t.id} — ${t.goal} (${t.plan_path})`));
  if (s.since) {
    const fin = s.since;
    out.push(`since ${fin.since}:`);
    section("merged", fin.merged.map((r) => `${r.run_id} ${r.task} — ${r.pr_state} ${r.pr}`));
    section("open, green, human_review", fin.human_review.map((r) => `${r.run_id} ${r.task} — ${reviewText(r.review_reasons, r.risk)} ${r.pr}`));
    const unknownPr = fin.blocked.filter((r) => r.blockers.includes("pr status unknown"));
    const openBlocked = fin.blocked.filter((r) => !r.blockers.includes("pr status unknown"));
    section("open, blocked", openBlocked.map((r) => {
      const why = r.blockers.join(", ");
      const reason = r.blockers.includes("needs_human") && r.reason ? `: ${r.reason}` : "";
      return `${r.run_id} ${r.task} — ${why}${reason}${r.pr ? ` ${r.pr}` : ""}`;
    }));
    if (unknownPr.length) {
      section("pr status unknown", unknownPr.map((r) => {
        const human = r.blockers.includes("needs_human") && r.reason ? `; needs_human: ${r.reason}` : "";
        return `${r.run_id} ${r.task} — ${r.error ?? "pr status unknown"}${human}${r.pr ? ` ${r.pr}` : ""}`;
      }));
    }
    section("failed", fin.failed.map((r) => `${r.run_id} ${r.task} — ${r.reason}`));
    section("base_red", fin.base_red.map((r) => `${r.run_id} ${r.task} — ${r.reason}`));
    section("needs_input", fin.needs_input.map((r) => `${r.run_id} ${r.task} — ${r.reason}${r.questions.length ? ` (${r.questions.join("; ")})` : ""}`));
  }
  return out.join("\n") + "\n";
}

export async function statusCommand(opts: { factoryHome: string; github: GitHub; since?: string; json: boolean; now?: () => number }, io: Io): Promise<number> {
  const report = await statusReport(opts);
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderStatus(report));
  return 0;
}
