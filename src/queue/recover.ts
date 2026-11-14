import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STOP_CAUSES, type StopCause } from "../events.js";
import { stopCauseOf } from "../pipeline/outcome.js";
import { MAX_CONTINUATIONS, MAX_GATE_ATTEMPTS } from "../pipeline/recovery.js";
import type { RunState } from "../pipeline/state.js";
import { listRuns } from "../runs.js";
import { admissionBlock, issueRevision } from "./admit.js";
import { pauseRequested } from "./pause.js";
import { loadAllQueues, updateQueue, type QueueEntry, type QueueFile } from "./store.js";
import { MAX_WINDOW_WAITS } from "./worker.js";

/**
 * #188: one explicit recovery path through the running queue worker. Preview is read-only.
 * Apply releases eligible parked entries back to pending, keeping the original run, so the worker
 * resumes that checkpoint and PR. It does not start a second implementation, reset a budget, or
 * unpark a blocker — dependents still wake through the existing unpark path.
 */

export type RecoverAction = "continue" | "revalidate" | "wait_blocker" | "decision" | "cannot";

export interface RecoverRow {
  issue: number;
  repo: string;
  run_id: string | null;
  cause?: string;
  action: RecoverAction;
  reason: string;
  /** Review or approval SHAs a changed head no longer covers. The SHAs themselves are not cleared. */
  invalidated?: string[];
  /** Set when an operator grant is on disk. Spent counters are the values kept, not a reset. */
  grant?: { at: string; gate_attempts: number; continuation_attempts: number };
  /** Budget is spent and a `--grant` may record one extra allowance. Not set for other decisions. */
  exhausted?: boolean;
}

export interface RecoverSelection {
  runs?: string[];
  issues?: number[];
  cause?: string;
}

/** Live issue and PR the command just read. Absent fields were not rechecked. */
export interface RecoverFacts {
  issue?: { title: string; body: string; labels: string[]; state?: "open" | "closed" };
  pr?: { state: "open" | "merged" | "closed"; headSha?: string | null; conflicting?: boolean };
  /** A lookup was attempted and failed. Apply must not release. */
  lookupFailed?: string;
  /** Repo config does not load. Apply must not release. */
  configError?: string;
}

export interface RecoverApplyResult {
  released: RecoverRow[];
  waiting: RecoverRow[];
  unchanged: RecoverRow[];
}

export function selectionGiven(sel: RecoverSelection): boolean {
  return Boolean(sel.runs?.length || sel.issues?.length || sel.cause);
}

export function isStopCause(value: string): value is StopCause {
  return (STOP_CAUSES as readonly string[]).includes(value);
}

export function factKey(repo: string, issue: number): string {
  return `${repo}\0${issue}`;
}

interface RecoverGitHub {
  getIssue(repo: string, n: number): Promise<{ title: string; body: string; labels: string[]; state?: "open" | "closed" }>;
  prStatus(repo: string, pr: string): Promise<{ state: "open" | "merged" | "closed"; conflicting?: boolean }>;
  findOpenPr(repo: string, branch: string): Promise<{ headSha: string | null } | null>;
}

/** Revalidates issue, PR and config for the parked entries a preview or apply will consider. */
export async function loadRecoverFacts(
  factoryHome: string,
  github: RecoverGitHub,
  sel: RecoverSelection,
  configError: (repo: string) => string | undefined,
): Promise<Map<string, RecoverFacts>> {
  const out = new Map<string, RecoverFacts>();
  for (const q of loadAllQueues(factoryHome)) {
    const broken = configError(q.repo);
    for (const entry of q.entries) {
      if (entry.status !== "parked") continue;
      if (selectionGiven(sel) && !identityMatch(entry, sel)) continue;
      const facts: RecoverFacts = {};
      if (broken) facts.configError = broken;
      try {
        facts.issue = await github.getIssue(q.repo, entry.issue);
      } catch (e) {
        facts.lookupFailed = `issue: ${(e as Error).message}`;
        out.set(factKey(q.repo, entry.issue), facts);
        continue;
      }
      const run = entry.run_id ? listRuns(factoryHome).find((r) => r.run_id === entry.run_id) : undefined;
      const pr = run?.state?.pr ?? entry.pr ?? null;
      const branch = run?.state?.branch ?? null;
      if (pr) {
        try {
          const status = await github.prStatus(q.repo, pr);
          const open = branch ? await github.findOpenPr(q.repo, branch) : null;
          facts.pr = { state: status.state, conflicting: status.conflicting === true, headSha: open?.headSha ?? null };
        } catch (e) {
          facts.lookupFailed = `pr: ${(e as Error).message}`;
        }
      }
      out.set(factKey(q.repo, entry.issue), facts);
    }
  }
  return out;
}

function identityMatch(entry: QueueEntry, sel: RecoverSelection): boolean {
  if (sel.runs?.length && (!entry.run_id || !sel.runs.includes(entry.run_id))) return false;
  if (sel.issues?.length && !sel.issues.includes(entry.issue)) return false;
  return true;
}

function checkpoint(factoryHome: string, runId: string): { ok: true; state: RunState } | { ok: false; reason: string } {
  const run = listRuns(factoryHome).find((r) => r.run_id === runId);
  if (!run?.state) return { ok: false, reason: "no saved run for this ticket" };
  if (run.state.gc_at) return { ok: false, reason: "checkpoint was GC-collected; replan instead of resuming" };
  const dir = join(factoryHome, "runs", runId);
  if (!existsSync(join(dir, "plan.json")) || !existsSync(join(dir, "worktree"))) {
    return { ok: false, reason: "checkpoint missing (plan or worktree); not released" };
  }
  const step = run.state.step;
  if (!step || step === "intake" || step === "finished") return { ok: false, reason: "checkpoint is not resumable; not released" };
  return { ok: true, state: run.state };
}

function spentNote(state: RunState | undefined, entry: QueueEntry): string {
  const gates = state?.repair?.gate_attempts ?? 0;
  const cont = state?.continuation_attempts ?? 0;
  return ` Spent counts stay: gate ${gates}/${MAX_GATE_ATTEMPTS}, post-push ${cont}/${MAX_CONTINUATIONS}, requeues ${entry.requeues ?? 0}.`;
}

function invalidatedOf(state: RunState | undefined, headSha: string | null | undefined): string[] {
  if (!headSha) return [];
  const out: string[] = [];
  if (state?.reviewed_sha && state.reviewed_sha !== headSha) out.push(`reviewed ${state.reviewed_sha}`);
  if (state?.approved_sha && state.approved_sha !== headSha) out.push(`approved ${state.approved_sha}`);
  return out;
}

function makeRow(q: QueueFile, entry: QueueEntry, action: RecoverAction, reason: string, extra?: Partial<RecoverRow>): RecoverRow {
  return { issue: entry.issue, repo: q.repo, run_id: entry.run_id ?? null, action, reason, ...extra };
}

function classify(factoryHome: string, q: QueueFile, entry: QueueEntry, facts: RecoverFacts | undefined, nowMs: number, requireFacts: boolean): RecoverRow {
  const run = entry.run_id ? listRuns(factoryHome).find((r) => r.run_id === entry.run_id) : undefined;
  const cause = stopCauseOf(run?.state?.stop);
  const base = { cause };
  if ((entry.blocked_by?.length ?? 0) > 0 || (entry.blocked_runs?.length ?? 0) > 0) {
    return makeRow(q, entry, "wait_blocker", "a blocking PR or run is still open; the worker unparks this after it closes", base);
  }
  const saved = entry.run_id ? checkpoint(factoryHome, entry.run_id) : { ok: false as const, reason: "no saved run for this ticket" };
  if (!saved.ok) return makeRow(q, entry, "cannot", saved.reason, base);
  const state = saved.state;
  if (entry.paused || pauseRequested(factoryHome, { runId: entry.run_id, repo: q.repo, issue: entry.issue })) {
    return makeRow(q, entry, "decision", "paused by the operator; clear the pause first", base);
  }
  if (requireFacts && !facts) return makeRow(q, entry, "cannot", "issue and PR were not rechecked; not released", base);
  if (facts?.configError) return makeRow(q, entry, "cannot", `repo config does not load (${facts.configError}); not released`, base);
  if (facts?.lookupFailed) return makeRow(q, entry, "cannot", `could not revalidate (${facts.lookupFailed}); not released`, base);
  if (facts?.issue) {
    const block = admissionBlock(facts.issue);
    if (block) return makeRow(q, entry, "decision", `issue is not authorized (${block}); not released`, base);
    if (!entry.issue_rev) return makeRow(q, entry, "cannot", "no stored issue revision; releasing would drop the checkpoint", base);
    if (entry.issue_rev !== issueRevision(facts.issue.title, facts.issue.body)) {
      return makeRow(q, entry, "cannot", "issue text changed; the saved plan is invalidated and was not released", base);
    }
  }
  const prRef = state.pr ?? entry.pr;
  if (prRef && facts?.pr) {
    if (facts.pr.state !== "open") return makeRow(q, entry, "cannot", `PR is ${facts.pr.state}; a second implementation is not started`, base);
    if (facts.pr.conflicting) return makeRow(q, entry, "decision", "unresolved conflict; needs a human resolution, not a resume", base);
  } else if (prRef && facts && !facts.pr && !facts.lookupFailed) {
    return makeRow(q, entry, "cannot", "existing PR was not revalidated; not released", base);
  }
  if (cause === "explicit_decision" || cause === "human_approval") {
    return makeRow(q, entry, "decision", `needs a human decision (${cause}); not released`, base);
  }
  if (cause === "budget_exhausted") {
    return makeRow(q, entry, "decision", `budget exhausted; not reset. An explicit grant is required and was not given.${spentNote(state, entry)}`, { ...base, exhausted: true });
  }
  if (cause === "provider_window_wait") {
    if ((entry.window_waits ?? 0) > MAX_WINDOW_WAITS) {
      return makeRow(q, entry, "decision", "provider window waits are exhausted; not reset and not resumed", base);
    }
    const resetsAt = entry.window_resets_at;
    if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) {
      return makeRow(q, entry, "cannot", "provider window has no reset time; not resumed", base);
    }
    if (resetsAt > nowMs) return makeRow(q, entry, "cannot", `provider window has not reset (until ${new Date(resetsAt).toISOString()})`, base);
  } else if (cause !== "technical_repair" && cause !== "transient_retry") {
    return makeRow(q, entry, "cannot", cause ? `not an automatic recovery cause (${cause}); a factory fix is not permission to resume` : "no canonical stop cause; fails closed", base);
  }
  const invalidated = invalidatedOf(state, facts?.pr?.headSha);
  const evidence = invalidated.length ? ` Prior evidence does not cover this head (${invalidated.join(", ")}).` : "";
  const kept = spentNote(state, entry);
  if (prRef) {
    return makeRow(q, entry, "revalidate", `resume the existing PR on this checkpoint; the worker rechecks the head.${evidence}${kept}`, {
      ...base,
      ...(invalidated.length ? { invalidated } : {}),
    });
  }
  return makeRow(q, entry, "continue", `continue the checkpoint; the worker re-reads config on resume.${kept}`, base);
}

function matches(entry: QueueEntry, classified: RecoverRow, sel: RecoverSelection): boolean {
  if (!identityMatch(entry, sel)) return false;
  if (sel.cause && classified.cause !== sel.cause) return false;
  return true;
}

/** Read-only. With no selection, every parked ticket is reported. Nothing is written. */
export function recoverPreview(factoryHome: string, sel: RecoverSelection, facts?: Map<string, RecoverFacts>, nowMs = Date.now()): RecoverRow[] {
  const out: RecoverRow[] = [];
  for (const q of loadAllQueues(factoryHome)) {
    for (const entry of q.entries) {
      if (entry.status !== "parked") continue;
      const seen = classify(factoryHome, q, entry, facts?.get(factKey(q.repo, entry.issue)), nowMs, false);
      if (selectionGiven(sel) && !matches(entry, seen, sel)) continue;
      out.push(seen);
    }
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records one extra gate repair and one extra post-push continuation. Spent counters are not touched.
 * A grant that is still unused is not stacked. The append-only `grants.jsonl` is the audit record.
 */
function recordGrant(factoryHome: string, runId: string, nowMs: number): RecoverRow["grant"] | undefined {
  const dir = join(factoryHome, "runs", runId);
  const statePath = join(dir, "state.json");
  const state = readJson(statePath);
  if (!state) return undefined;
  const repair = state.repair !== null && typeof state.repair === "object" ? (state.repair as Record<string, unknown>) : {};
  const gateAttempts = typeof repair.gate_attempts === "number" ? repair.gate_attempts : 0;
  const continuationAttempts = typeof state.continuation_attempts === "number" ? state.continuation_attempts : 0;
  const existing = state.repair_grant !== null && typeof state.repair_grant === "object" ? (state.repair_grant as { at?: unknown }) : undefined;
  if (existing && (repair.gate_extra === 1 || state.continuation_extra === 1)) {
    return {
      at: String(existing.at ?? ""),
      gate_attempts: gateAttempts,
      continuation_attempts: continuationAttempts,
    };
  }
  const at = new Date(nowMs).toISOString();
  const audit = {
    at,
    previous_cause: "budget_exhausted",
    gate_attempts: gateAttempts,
    continuation_attempts: continuationAttempts,
    gate_extra: 1,
    continuation_extra: 1,
  };
  repair.gate_extra = 1;
  state.repair = repair;
  state.continuation_extra = 1;
  state.repair_grant = audit;
  state.stop = { cause: "technical_repair", action: "repair" };
  state.updated_at = at;
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  const resultPath = join(dir, "result.json");
  const result = readJson(resultPath);
  if (result) {
    result.stop = { cause: "technical_repair", action: "repair" };
    writeFileSync(resultPath, JSON.stringify(result) + "\n");
  }
  appendFileSync(join(dir, "grants.jsonl"), JSON.stringify(audit) + "\n");
  return { at, gate_attempts: gateAttempts, continuation_attempts: continuationAttempts };
}

function attachGrant(factoryHome: string, seen: RecoverRow): void {
  if (!seen.run_id || seen.grant) return;
  const audit = readJson(join(factoryHome, "runs", seen.run_id, "state.json"))?.repair_grant;
  if (!audit || typeof audit !== "object" || !("at" in audit)) return;
  const grant = audit as { at?: unknown; gate_attempts?: unknown; continuation_attempts?: unknown };
  seen.grant = {
    at: String(grant.at ?? ""),
    gate_attempts: typeof grant.gate_attempts === "number" ? grant.gate_attempts : 0,
    continuation_attempts: typeof grant.continuation_attempts === "number" ? grant.continuation_attempts : 0,
  };
}

function releaseEntry(entry: QueueEntry): void {
  entry.status = "pending";
  delete entry.reason;
  delete entry.pid;
  delete entry.choice;
  delete entry.wait_until;
  delete entry.window_resets_at;
}

/**
 * Rechecks eligibility, then releases continue/revalidate entries to pending under the queue lock.
 * `--grant` records an extra allowance only for a `budget_exhausted` decision, and never resets counts.
 */
export async function recoverApply(
  factoryHome: string,
  sel: RecoverSelection,
  opts: { facts: Map<string, RecoverFacts>; grant?: boolean; nowMs?: number },
): Promise<RecoverApplyResult> {
  if (!selectionGiven(sel)) throw new Error("recovery apply needs an explicit selection");
  const nowMs = opts.nowMs ?? Date.now();
  const released: RecoverRow[] = [];
  const waiting: RecoverRow[] = [];
  const unchanged: RecoverRow[] = [];
  for (const q of loadAllQueues(factoryHome)) {
    if (!q.entries.some((entry) => identityMatch(entry, sel))) continue;
    if (opts.grant) {
      for (const entry of q.entries) {
        if (entry.status !== "parked" || !entry.run_id) continue;
        const seen = classify(factoryHome, q, entry, opts.facts.get(factKey(q.repo, entry.issue)), nowMs, true);
        if (!matches(entry, seen, sel) || !seen.exhausted) continue;
        recordGrant(factoryHome, entry.run_id, nowMs);
      }
    }
    await updateQueue(factoryHome, q.repo, (live) => {
      for (const entry of live.entries) {
        if (!identityMatch(entry, sel)) continue;
        if (entry.status !== "parked") {
          if (sel.cause) {
            const cause = stopCauseOf(entry.run_id ? listRuns(factoryHome).find((r) => r.run_id === entry.run_id)?.state?.stop : undefined);
            if (cause !== sel.cause) continue;
          }
          unchanged.push(makeRow(live, entry, entry.status === "pending" ? "continue" : "cannot", `already ${entry.status}; not started again`));
          continue;
        }
        const seen = classify(factoryHome, live, entry, opts.facts.get(factKey(live.repo, entry.issue)), nowMs, true);
        if (!matches(entry, seen, sel)) continue;
        if (opts.grant) attachGrant(factoryHome, seen);
        if (seen.grant) seen.reason = `explicit grant recorded at ${seen.grant.at}; spent counts were not reset. ${seen.reason}`;
        if (seen.action === "continue" || seen.action === "revalidate") released.push(seen);
        else waiting.push(seen);
        if (seen.action === "continue" || seen.action === "revalidate") releaseEntry(entry);
      }
    });
  }
  return { released, waiting, unchanged };
}

export function renderRecover(rows: RecoverRow[]): string {
  if (!rows.length) return "no parked tickets match the selection\n";
  return rows.map((r) => `#${r.issue} (${r.run_id ?? "no run"}): ${r.action} — ${r.reason}`).join("\n") + "\n";
}

export function renderApply(result: RecoverApplyResult): string {
  const lines = [`queue: released ${result.released.map((r) => `#${r.issue}`).join(", ") || "(none)"}`];
  if (result.waiting.length) lines.push(renderRecover(result.waiting).trimEnd());
  if (result.unchanged.length) lines.push(result.unchanged.map((r) => `#${r.issue}: ${r.reason}`).join("\n"));
  return lines.join("\n") + "\n";
}
