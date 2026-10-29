import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { FactoryEvent } from "../events.js";
import { listRuns, readEvents, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";

/** One period of `factory stats` (SPEC §14; schema `schemas/stats.schema.json`). */
export interface StatsPeriod {
  from: string;
  to: string;
  runs: number;
  by_result: Record<string, number>;
  by_lane: Record<string, number>;
  by_type: Record<string, number>;
  by_repo: Record<string, number>;
  /** done / runs with a final result other than `locked`; null without such runs. */
  done_rate: number | null;
  rounds: { median: number | null; p90: number | null };
  minutes: { median: number | null; p90: number | null };
  gate_failures: Record<string, number>;
  flaky_checks: Record<string, number>;
  reasons: { result: string; reason: string; count: number }[];
  providers: Record<string, { calls: number; errors: number; fallbacks: number; capacity_errors: number; limit_errors: number; tokens_in: number; tokens_out: number; cost_usd: number }>;
  roles: Record<string, { calls: number; tokens_in: number; tokens_out: number; cost_usd: number }>;
  cost_usd: number;
  lane_escalations: number;
  watchdog_aborts: number;
  merge_policy: Record<string, number>;
  auto_merged: number;
  /** Auto-merged factory PRs reverted later: not tracked yet (needs the GitHub history, M3 harden). */
  reverted: null;
}

export interface StatsReport {
  generated_at: string;
  since: string;
  repo: string | null;
  current: StatsPeriod;
  previous: StatsPeriod;
  delta: { runs: number; done_rate: number | null; cost_usd: number; median_rounds: number | null };
}

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

export function aggregate(runs: RunRecord[], from: Date, to: Date, events: (r: RunRecord) => FactoryEvent[] = readEvents): StatsPeriod {
  const p: StatsPeriod = {
    from: from.toISOString(), to: to.toISOString(), runs: 0, by_result: {}, by_lane: {}, by_type: {}, by_repo: {}, done_rate: null,
    rounds: { median: null, p90: null }, minutes: { median: null, p90: null }, gate_failures: {}, flaky_checks: {}, reasons: [],
    providers: {}, roles: {}, cost_usd: 0, lane_escalations: 0, watchdog_aborts: 0, merge_policy: {}, auto_merged: 0, reverted: null,
  };
  const rounds: number[] = [];
  const minutes: number[] = [];
  const reasons = new Map<string, { result: string; reason: string; count: number }>();
  let finished = 0;
  for (const r of runs) {
    if (r.started_at < from || r.started_at >= to) continue;
    p.runs++;
    const res = r.result;
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
      if (res.merge_policy === "auto" && res.pr) p.auto_merged++;
    }
    if (result === "needs_human" || result === "needs_input") {
      const reason = (r.state?.reason ?? res?.reason ?? "").slice(0, 160);
      const key = `${result}\n${reason}`;
      const e = reasons.get(key) ?? { result, reason, count: 0 };
      e.count++;
      reasons.set(key, e);
    }
    for (const e of events(r)) {
      if (e.event === "gate_result" && !e.data.base) {
        const check = String(e.data.check);
        if (e.data.status === "fail") inc(p.gate_failures, check);
        if (e.data.status === "flaky") inc(p.flaky_checks, check);
      } else if (e.event === "agent_finished" || e.event === "agent_error") {
        const prov = (p.providers[providerOf(e.model)] ??= { calls: 0, errors: 0, fallbacks: 0, capacity_errors: 0, limit_errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
        const role = (p.roles[e.role ?? "unknown"] ??= { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
        for (const t of [prov, role]) {
          t.calls++;
          t.tokens_in += e.tokens_in;
          t.tokens_out += e.tokens_out;
          t.cost_usd = round4(t.cost_usd + e.cost_usd);
        }
        p.cost_usd = round4(p.cost_usd + e.cost_usd);
        if (e.event === "agent_error") {
          prov.errors++;
          if (e.data.class === "capacity") prov.capacity_errors++;
          if (e.data.class === "limit") prov.limit_errors++;
        }
      } else if (e.event === "model_fallback") {
        const prov = (p.providers[providerOf(e.model)] ??= { calls: 0, errors: 0, fallbacks: 0, capacity_errors: 0, limit_errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });
        prov.fallbacks++;
      } else if (e.event === "lane_escalated") p.lane_escalations++;
      else if (e.event === "watchdog_abort") p.watchdog_aborts++;
    }
  }
  p.done_rate = finished ? round4((p.by_result.done ?? 0) / finished) : null;
  p.rounds = { median: quantile(rounds, 0.5), p90: quantile(rounds, 0.9) };
  p.minutes = { median: quantile(minutes, 0.5), p90: quantile(minutes, 0.9) };
  p.reasons = [...reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return p;
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
      median_rounds: diff(current.rounds.median, previous.rounds.median),
    },
  };
}

export function statsCommand(opts: { factoryHome: string; since?: string; repo?: string; json: boolean }, io: Io): number {
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
      `cost: $${c.cost_usd.toFixed(4)} (previous $${s.previous.cost_usd.toFixed(4)})`,
      `lane escalations ${c.lane_escalations}, watchdog aborts ${c.watchdog_aborts}`,
    ].join("\n") + "\n",
  );
  return 0;
}
