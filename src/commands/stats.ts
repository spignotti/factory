import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { FactoryEvent } from "../events.js";
import { canonicalRepoId } from "../memory.js";
import { openAuditTickets } from "../proposals.js";
import { listRuns, readEvents, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";
import type { z } from "zod";
import type { StatsPeriodSchema, StatsReportSchema } from "../schemas/reports.js";
import { billingOf, type BillingKind, DEFAULT_BILLING } from "../schemas/profile.js";
import { classifyWait, dedupeRuns, lastEventTime, mergeTimestamp, roundKinds, waitLabels, waitedMinutes, type WaitClass } from "../pipeline/accounting.js";
import { addOutcome, emptyOutcomeCounts, readOutcome } from "../pipeline/outcome.js";

/** One period of `factory stats` (schema `schemas/stats.schema.json`). */
export type StatsPeriod = z.infer<typeof StatsPeriodSchema>;

export type StatsReport = z.infer<typeof StatsReportSchema>;

/** `7d`, `24h`, `2w` → milliseconds. */
export function parseSince(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([hdw])$/.exec(s.trim());
  if (!m) throw new Error(`invalid --since ${s} (use e.g. 24h, 7d, 4w)`);
  return Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  // Nearest rank: deterministic and always an observed value.
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))]!;
}

const inc = (o: Record<string, number>, k: string, by = 1) => void (o[k] = (o[k] ?? 0) + by);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const providerOf = (model: string | null) => (model ?? "unknown").split("/")[0]!;

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const emptyProvider = () => ({ calls: 0, errors: 0, fallbacks: 0, capacity_errors: 0, limit_errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });

function emptyWaits(): Record<WaitClass, number> {
  return { dependency: 0, capacity: 0, ci_runner: 0, provider: 0, human_decision: 0, technical_repair: 0, unclassified: 0 };
}

/** Billing kind recorded with the call; older events fall back to the built-in defaults. */
function eventBilling(e: FactoryEvent): BillingKind {
  const b = e.data.billing;
  return b === "subscription" || b === "metered" ? b : e.model ? billingOf(e.model, DEFAULT_BILLING) : "metered";
}

export function aggregate(runs: RunRecord[], from: Date, to: Date, events: (r: RunRecord) => FactoryEvent[] = readEvents): StatsPeriod {
  const p: StatsPeriod = {
    from: from.toISOString(), to: to.toISOString(), runs: 0, by_result: {}, by_lane: {}, by_type: {}, by_repo: {}, done_rate: null,
    rounds: { median: null, p90: null }, minutes: { median: null, p90: null },
    time: { active_minutes: { median: null, p90: null }, wait_minutes: { median: null, p90: null }, time_to_merge_minutes: { median: null, p90: null }, summed_run_minutes: 0, wall_clock_minutes: null },
    waits: emptyWaits(), round_kinds: { replan: 0, retry: 0, review: 0 },
    gate_failures: {}, flaky_checks: {}, reasons: [],
    providers: {}, roles: {}, cost_usd: 0, subscription_tokens: { tokens_in: 0, tokens_out: 0 }, lane_escalations: 0, watchdog_aborts: 0, merge_policy: {}, auto_merged: 0, reverted: null, outcomes: emptyOutcomeCounts(),
  };
  const rounds: number[] = [];
  const minutes: number[] = [];
  const waits: number[] = [];
  const toMerge: number[] = [];
  const reasons = new Map<string, { result: string; reason: string; count: number }>();
  let finished = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  let sawEnd = false;
  // One directory is one row. A second copy of the same run id (restart or resume) is not a second ticket.
  for (const r of dedupeRuns(runs)) {
    if (r.started_at < from || r.started_at >= to) continue;
    p.runs++;
    const log = events(r);
    const res = r.result;
    minStart = Math.min(minStart, r.started_at.getTime());
    const ended = lastEventTime(log);
    if (ended !== null) {
      maxEnd = Math.max(maxEnd, ended);
      sawEnd = true;
    }
    const result = r.state?.result ?? res?.result ?? "running";
    inc(p.by_result, result);
    inc(p.by_lane, r.state?.lane ?? res?.lane ?? "standard");
    if (res?.type) inc(p.by_type, res.type);
    inc(p.by_repo, r.state?.repo ?? res?.repo ?? "unknown");
    if (res && result !== "locked" && result !== "running") {
      finished++;
      rounds.push(res.rounds);
      minutes.push(res.minutes);
      if (res.merge_policy) inc(p.merge_policy, res.merge_policy);
      const outcome = readOutcome(res);
      addOutcome(p.outcomes, outcome);
      // A delivered PR is not a merge. Only an explicitly confirmed auto merge counts.
      // GitHub state and a matching login are not consulted here, so an external merge cannot add a second row.
      if (outcome.merged === "confirmed" && res.merge_policy === "auto") p.auto_merged++;
      const waited = waitedMinutes(log);
      if (waited !== null) waits.push(waited);
      if (outcome.merged === "confirmed") {
        const mergedAt = mergeTimestamp(log);
        if (mergedAt !== null && mergedAt >= r.started_at.getTime()) toMerge.push(Math.round(((mergedAt - r.started_at.getTime()) / 60_000) * 10) / 10);
      }
    }
    const kinds = roundKinds(log);
    p.round_kinds.replan += kinds.replan;
    p.round_kinds.retry += kinds.retry;
    p.round_kinds.review += kinds.review;
    const seenWait = new Set<string>();
    for (const label of waitLabels(r, log)) {
      const cls = classifyWait(label.reason, label.result);
      const key = `${cls}\n${label.reason}`;
      if (seenWait.has(key)) continue;
      seenWait.add(key);
      p.waits[cls]++;
    }
    if (result === "needs_human" || result === "needs_input" || result === "abandoned") {
      const reason = (r.state?.reason ?? res?.reason ?? "").slice(0, 160);
      const key = `${result}\n${reason}`;
      const e = reasons.get(key) ?? { result, reason, count: 0 };
      e.count++;
      reasons.set(key, e);
    }
    for (const e of log) {
      if (e.event === "gate_result" && !e.data.base) {
        const check = String(e.data.check);
        if (e.data.status === "fail") inc(p.gate_failures, check);
        if (e.data.status === "flaky") inc(p.flaky_checks, check);
      } else if (e.event === "agent_finished" || e.event === "agent_error") {
        const billing = eventBilling(e);
        // Subscriptions are reported in tokens; older logs may still carry a catalog price.
        const cost = billing === "subscription" ? 0 : e.cost_usd;
        const prov = (p.providers[providerOf(e.model)] ??= { ...emptyProvider(), billing });
        const role = (p.roles[e.role ?? "unknown"] ??= { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
        for (const t of [prov, role]) {
          t.calls++;
          t.tokens_in += e.tokens_in;
          t.tokens_out += e.tokens_out;
          t.cost_usd = round4(t.cost_usd + cost);
        }
        p.cost_usd = round4(p.cost_usd + cost);
        if (billing === "subscription") {
          p.subscription_tokens.tokens_in += e.tokens_in;
          p.subscription_tokens.tokens_out += e.tokens_out;
        }
        if (e.event === "agent_error") {
          prov.errors++;
          if (e.data.class === "capacity") prov.capacity_errors++;
          if (e.data.class === "limit") prov.limit_errors++;
        }
      } else if (e.event === "model_fallback") {
        const prov = (p.providers[providerOf(e.model)] ??= { ...emptyProvider(), billing: eventBilling(e) });
        prov.fallbacks++;
      } else if (e.event === "lane_escalated") p.lane_escalations++;
      else if (e.event === "watchdog_abort") p.watchdog_aborts++;
    }
  }
  p.done_rate = finished ? round4((p.by_result.done ?? 0) / finished) : null;
  p.rounds = { median: quantile(rounds, 0.5), p90: quantile(rounds, 0.9) };
  p.minutes = { median: quantile(minutes, 0.5), p90: quantile(minutes, 0.9) };
  p.time.active_minutes = { median: p.minutes.median, p90: p.minutes.p90 };
  p.time.wait_minutes = { median: quantile(waits, 0.5), p90: quantile(waits, 0.9) };
  p.time.time_to_merge_minutes = { median: quantile(toMerge, 0.5), p90: quantile(toMerge, 0.9) };
  p.time.summed_run_minutes = Math.round(minutes.reduce((sum, n) => sum + n, 0) * 10) / 10;
  p.time.wall_clock_minutes = sawEnd ? Math.round(((maxEnd - minStart) / 60_000) * 10) / 10 : null;
  p.reasons = [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return p;
}

function repoIdFor(repoDir: string): string {
  let origin = "";
  try {
    origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // no origin: the repo id is the path
  }
  return canonicalRepoId(origin, repoDir);
}

export function statsReport(opts: { factoryHome: string; since?: string; repo?: string; now?: () => number }): StatsReport {
  const since = opts.since ?? "7d";
  const span = parseSince(since);
  const now = opts.now?.() ?? Date.now();
  const repo = opts.repo ? canonical(opts.repo) : null;
  const runs = listRuns(opts.factoryHome).filter((r) => !repo || canonical(r.state?.repo ?? r.result?.repo ?? "") === repo);
  const current = aggregate(runs, new Date(now - span), new Date(now));
  const previous = aggregate(runs, new Date(now - 2 * span), new Date(now - span));
  const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : round4(a - b));
  return {
    generated_at: new Date(now).toISOString(), since, repo, current, previous,
    delta: {
      runs: current.runs - previous.runs,
      done_rate: diff(current.done_rate, previous.done_rate),
      cost_usd: round4(current.cost_usd - previous.cost_usd),
      subscription_tokens: current.subscription_tokens.tokens_in + current.subscription_tokens.tokens_out - previous.subscription_tokens.tokens_in - previous.subscription_tokens.tokens_out,
      median_rounds: diff(current.rounds.median, previous.rounds.median),
    },
    audit_tickets: openAuditTickets(opts.factoryHome, repo ? repoIdFor(repo) : undefined),
  };
}

function formatCounts(label: string, counts: Record<string, number>, limit = 8): string {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  return `${label}: ${top.length ? top.map(([k, v]) => `${k} ${v}`).join(", ") : "–"}`;
}

function formatOutcomes(outcomes: StatsPeriod["outcomes"]): string {
  return `outcomes: tickets ${outcomes.tickets} (${outcomes.tickets_unknown} unknown), attempts ${outcomes.attempts} (${outcomes.attempts_unknown} unknown), delivered PRs ${outcomes.delivered_prs} (${outcomes.delivered_prs_unknown} unknown), confirmed merges ${outcomes.confirmed_merges} (${outcomes.merges_unknown} unknown), ended without merge ${outcomes.ended_without_merge} (${outcomes.ended_without_merge_unknown} unknown), open decisions ${outcomes.open_decisions} (${outcomes.open_decisions_unknown} unknown)`;
}

function formatReasons(reasons: StatsPeriod["reasons"], limit = 8): string {
  const top = reasons.slice(0, limit);
  return `reasons: ${top.length ? top.map((r) => `${r.result} (${r.count}) ${r.reason || "–"}`).join("; ") : "–"}`;
}

export function statsCommand(opts: { factoryHome: string; since?: string; repo?: string; json: boolean; now?: () => number }, io: Io): number {
  const s = statsReport(opts);
  if (opts.json) {
    io.out(JSON.stringify(s) + "\n");
    return 0;
  }
  const c = s.current;
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  io.out(
    [
      `runs (last ${s.since}${s.repo ? `, ${s.repo}` : ""}): ${c.runs} (previous period ${s.previous.runs})`,
      `results: ${Object.entries(c.by_result).map(([k, v]) => `${k} ${v}`).join(", ") || "–"}`,
      `done rate: ${pct(c.done_rate)} (previous ${pct(s.previous.done_rate)})`,
      `rounds median/p90: ${c.rounds.median ?? "–"}/${c.rounds.p90 ?? "–"}; minutes median/p90: ${c.minutes.median ?? "–"}/${c.minutes.p90 ?? "–"}`,
      `time: active median/p90 ${c.time.active_minutes.median ?? "–"}/${c.time.active_minutes.p90 ?? "–"}; wait median/p90 ${c.time.wait_minutes.median ?? "–"}/${c.time.wait_minutes.p90 ?? "–"}; time to merge median/p90 ${c.time.time_to_merge_minutes.median ?? "–"}/${c.time.time_to_merge_minutes.p90 ?? "–"}; summed run minutes ${c.time.summed_run_minutes} (not wall-clock); wall-clock ${c.time.wall_clock_minutes ?? "unknown"}`,
      `waits: dependency ${c.waits.dependency}, capacity ${c.waits.capacity}, ci_runner ${c.waits.ci_runner}, provider ${c.waits.provider}, human_decision ${c.waits.human_decision}, technical_repair ${c.waits.technical_repair}, unclassified ${c.waits.unclassified}`,
      `rounds detail: replan ${c.round_kinds.replan}, retry ${c.round_kinds.retry}, review ${c.round_kinds.review}`,
      `subscription: ${c.subscription_tokens.tokens_in} in / ${c.subscription_tokens.tokens_out} out tokens (previous ${s.previous.subscription_tokens.tokens_in} / ${s.previous.subscription_tokens.tokens_out}); not priced in dollars (a zero price is not an efficiency proof)`,
      `cost (metered providers): $${c.cost_usd.toFixed(4)} (previous $${s.previous.cost_usd.toFixed(4)})`,
      `regressions: unknown`,
      `lane escalations ${c.lane_escalations}, watchdog aborts ${c.watchdog_aborts}`,
      formatOutcomes(c.outcomes),
      formatCounts("gate failures", c.gate_failures),
      formatReasons(c.reasons),
      s.audit_tickets.length
        ? `open audit tickets:\n${s.audit_tickets.map((t) => `  ${t.repo} [${t.type}] ${t.id} — ${t.goal}`).join("\n")}`
        : "open audit tickets: 0",
    ].join("\n") + "\n",
  );
  return 0;
}
