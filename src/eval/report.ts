import type { EvalRecord, ProfileSummary, Verdict } from "../schemas/eval.js";

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Determinism ratio: over the tasks a profile ran at least twice, the share whose
 * repeats all agree on hidden pass and on the run result. Null when no task ran twice.
 */
export function determinismRatio(records: EvalRecord[]): number | null {
  const groups = new Map<string, EvalRecord[]>();
  for (const r of records) groups.set(r.task, [...(groups.get(r.task) ?? []), r]);
  const repeated = [...groups.values()].filter((g) => g.length >= 2);
  if (!repeated.length) return null;
  const stable = repeated.filter((g) => g.every((r) => r.hidden_pass === g[0]!.hidden_pass && r.result === g[0]!.result));
  return round(stable.length / repeated.length);
}

export function summarize(profile: string, all: EvalRecord[]): ProfileSummary {
  const rs = all.filter((r) => r.profile === profile);
  const passes = rs.filter((r) => r.hidden_pass).length;
  return {
    profile,
    runs: rs.length,
    passes,
    pass_rate: rs.length ? round(passes / rs.length) : null,
    mean_cost_usd: mean(rs.map((r) => r.cost_usd)),
    mean_tokens: mean(rs.map((r) => r.tokens_in + r.tokens_out)),
    mean_wall_s: mean(rs.map((r) => r.wall_s)),
    mean_rounds: mean(rs.map((r) => r.rounds)),
    gate_failures: rs.reduce((a, r) => a + r.gate_failures, 0),
    bug_findings: rs.reduce((a, r) => a + r.bug_findings, 0),
    real_findings: rs.reduce((a, r) => a + r.real_findings, 0),
    errors: rs.filter((r) => r.result === "error").length,
    determinism_ratio: determinismRatio(rs),
  };
}

/** Relative margin for cost and time ("≥ 10 % lower"). */
export const MARGIN = 0.1;
const EPS = 1e-9;

export type CostMeasure = "usd" | "tokens";

/** USD when either side reports a cost; tokens when both report 0 USD (subscriptions bill no per-call USD). */
export function costMeasure(a: ProfileSummary, b: ProfileSummary): CostMeasure {
  return (a.mean_cost_usd ?? 0) > 0 || (b.mean_cost_usd ?? 0) > 0 ? "usd" : "tokens";
}

const costOf = (s: ProfileSummary, m: CostMeasure) => (m === "usd" ? s.mean_cost_usd : s.mean_tokens) ?? 0;
const lower = (b: number, a: number) => a > 0 && b <= a * (1 - MARGIN) + EPS;

/**
 * Decision rule: B beats A when B's pass rate is ≥ A's and at least one of: a higher pass rate,
 * ≥ 10 % lower cost, ≥ 10 % lower wall time. Returns the reasons, or null when B does not beat A.
 */
export function beats(b: ProfileSummary, a: ProfileSummary, measure = costMeasure(a, b)): string[] | null {
  const pb = b.pass_rate ?? 0;
  const pa = a.pass_rate ?? 0;
  if (pb + EPS < pa) return null;
  const reasons: string[] = [];
  if (pb > pa + EPS) reasons.push(`pass rate ${pb} > ${pa}`);
  const cb = costOf(b, measure);
  const ca = costOf(a, measure);
  if (lower(cb, ca)) reasons.push(`${measure === "usd" ? "cost" : "tokens"} ${cb} ≤ 90 % of ${ca}`);
  const tb = b.mean_wall_s ?? 0;
  const ta = a.mean_wall_s ?? 0;
  if (lower(tb, ta)) reasons.push(`wall time ${tb}s ≤ 90 % of ${ta}s`);
  return reasons.length ? reasons : null;
}

export class DecisionError extends Error {}

/**
 * Applies the rule both ways. `win`: the variant beats the base and not vice versa; `loss`: the
 * reverse; otherwise `tie` (neither, or both on different measures, e.g. cheaper but slower).
 * Ties keep the simpler profile: the base (a variant is a change on top of it). Needs repeat ≥ 2
 * and the same task × repeat set on both sides; harness errors count as failed runs.
 */
export function decide(base: ProfileSummary, variant: ProfileSummary, repeat: number): Pick<Verdict, "verdict" | "keep" | "reasons" | "cost_measure"> {
  if (repeat < 2) throw new DecisionError(`the decision rule needs repeat ≥ 2 (got ${repeat})`);
  if (base.runs !== variant.runs || base.runs === 0) throw new DecisionError(`both profiles need the same, non-zero number of runs (base ${base.runs}, variant ${variant.runs})`);
  const measure = costMeasure(base, variant);
  const win = beats(variant, base, measure);
  const loss = beats(base, variant, measure);
  if (win && !loss) return { verdict: "win", keep: "variant", reasons: win, cost_measure: measure };
  if (loss && !win) return { verdict: "loss", keep: "base", reasons: loss.map((r) => `base: ${r}`), cost_measure: measure };
  const reasons = win && loss ? [`variant: ${win.join(", ")}`, `base: ${loss.join(", ")}`, "both ahead on different measures"] : ["neither beats the other"];
  return { verdict: "tie", keep: "base", reasons: [...reasons, "tie keeps the simpler profile (base)"], cost_measure: measure };
}

/** True when the records' agent calls all ran on subscriptions (no per-use USD; compare tokens). */
export function subscriptionOnly(rs: EvalRecord[]): boolean {
  const usage = rs.flatMap((r) => r.usage);
  return usage.length > 0 && usage.every((u) => u.billing === "subscription");
}
/** USD, or "subscription" where no call was metered (the tokens column is the cost then). */
const costCell = (rs: EvalRecord[], usd: number | null) => (subscriptionOnly(rs) ? "subscription" : usd);

const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v)).replace(/\|/g, "\\|");
const row = (cells: unknown[]) => `| ${cells.map(cell).join(" | ")} |`;

/** Markdown: one summary row per profile, then one row per task × profile. */
export function markdownTable(records: EvalRecord[], profiles: string[]): string {
  const lines = [
    row(["profile", "runs", "pass rate", "passes", "mean cost $", "mean tokens", "mean wall s", "mean rounds", "gate failures", "bug findings", "real findings", "errors", "determinism"]),
    row(Array(13).fill("---")),
  ];
  for (const p of profiles) {
    const s = summarize(p, records);
    lines.push(row([p, s.runs, s.pass_rate, s.passes, costCell(records.filter((r) => r.profile === p), s.mean_cost_usd), s.mean_tokens, s.mean_wall_s, s.mean_rounds, s.gate_failures, s.bug_findings, s.real_findings, s.errors, s.determinism_ratio]));
  }
  lines.push("", row(["task", "profile", "hidden pass", "results", "rounds", "gate failures", "real findings", "cost $", "tokens", "wall s"]), row(Array(10).fill("---")));
  const tasks = [...new Set(records.map((r) => r.task))];
  for (const t of tasks) {
    for (const p of profiles) {
      const rs = records.filter((r) => r.task === t && r.profile === p);
      if (!rs.length) continue;
      lines.push(
        row([
          t,
          p,
          `${rs.filter((r) => r.hidden_pass).length}/${rs.length}`,
          rs.map((r) => r.result).join(", "),
          rs.map((r) => r.rounds).join(", "),
          rs.reduce((a, r) => a + r.gate_failures, 0),
          rs.reduce((a, r) => a + r.real_findings, 0),
          costCell(rs, round(rs.reduce((a, r) => a + r.cost_usd, 0))),
          rs.reduce((a, r) => a + r.tokens_in + r.tokens_out, 0),
          round(rs.reduce((a, r) => a + r.wall_s, 0), 1),
        ]),
      );
    }
  }
  return lines.join("\n") + "\n";
}
