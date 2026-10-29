import { describe, expect, it } from "vitest";
import { beats, costMeasure, decide, DecisionError, determinismRatio, markdownTable, summarize } from "../../src/eval/report.js";
import type { EvalRecord, ProfileSummary } from "../../src/schemas/eval.js";
import { VerdictSchema } from "../../src/schemas/eval.js";

const rec = (o: Partial<EvalRecord>): EvalRecord => ({
  version: 1,
  started_at: "2026-10-29T10:00:00.000Z",
  task: "t1",
  profile: "a",
  repeat: 1,
  run_id: null,
  reason: "",
  result: "done",
  hidden_pass: true,
  hidden_output: "",
  rounds: 1,
  gate_failures: 0,
  bug_findings: 0,
  real_findings: 0,
  tokens_in: 100,
  tokens_out: 10,
  cost_usd: 0,
  usage: [],
  wall_s: 100,
  timed_out: false,
  ...o,
});

const sum = (o: Partial<ProfileSummary>): ProfileSummary => ({
  profile: "x",
  runs: 4,
  passes: 2,
  pass_rate: 0.5,
  mean_cost_usd: 1,
  mean_tokens: 1000,
  mean_wall_s: 100,
  mean_rounds: 1,
  gate_failures: 0,
  bug_findings: 0,
  real_findings: 0,
  errors: 0,
  determinism_ratio: 1,
  ...o,
});

describe("eval report", () => {
  it("determinism ratio: share of repeated tasks whose repeats agree on hidden pass and result", () => {
    expect(determinismRatio([rec({ task: "t1" })])).toBeNull();
    const rs = [
      rec({ task: "t1", repeat: 1 }),
      rec({ task: "t1", repeat: 2 }),
      rec({ task: "t2", repeat: 1 }),
      rec({ task: "t2", repeat: 2, hidden_pass: false }),
      rec({ task: "t3", repeat: 1 }),
      rec({ task: "t3", repeat: 2, result: "needs_human" }),
      rec({ task: "t4", repeat: 1 }), // ran once: not counted
    ];
    expect(determinismRatio(rs)).toBe(0.3333);
  });

  it("summary: pass rate, means, sums, errors per profile", () => {
    const s = summarize("a", [rec({ cost_usd: 0.5, wall_s: 10 }), rec({ repeat: 2, hidden_pass: false, result: "error", cost_usd: 1.5, wall_s: 30, real_findings: 2 }), rec({ profile: "b" })]);
    expect(s).toMatchObject({ runs: 2, passes: 1, pass_rate: 0.5, mean_cost_usd: 1, mean_wall_s: 20, real_findings: 2, errors: 1, determinism_ratio: 0 });
    expect(summarize("none", []).pass_rate).toBeNull();
  });

  describe("decision rule", () => {
    const A = sum({ profile: "a" });
    it("higher pass rate wins", () => expect(beats(sum({ pass_rate: 0.75 }), A)).toEqual(["pass rate 0.75 > 0.5"]));
    it("equal pass rate and ≥ 10 % cheaper wins; 9 % cheaper does not", () => {
      expect(beats(sum({ mean_cost_usd: 0.9 }), A)).toEqual(["cost 0.9 ≤ 90 % of 1"]);
      expect(beats(sum({ mean_cost_usd: 0.91 }), A)).toBeNull();
    });
    it("equal pass rate and ≥ 10 % faster wins", () => expect(beats(sum({ mean_wall_s: 80 }), A)).toEqual(["wall time 80s ≤ 90 % of 100s"]));
    it("a lower pass rate never wins, however cheap", () => expect(beats(sum({ pass_rate: 0.25, mean_cost_usd: 0.1, mean_wall_s: 10 }), A)).toBeNull());
    it("both at 0 USD: cost is compared in tokens", () => {
      const a0 = sum({ mean_cost_usd: 0 });
      const b0 = sum({ mean_cost_usd: 0, mean_tokens: 800 });
      expect(costMeasure(a0, b0)).toBe("tokens");
      expect(beats(b0, a0)).toEqual(["tokens 800 ≤ 90 % of 1000"]);
      expect(costMeasure(A, b0)).toBe("usd");
    });
    it("verdicts: win, loss, tie (neither / different measures) keep base on ties", () => {
      expect(decide(A, sum({ pass_rate: 0.75 }), 2)).toMatchObject({ verdict: "win", keep: "variant" });
      expect(decide(A, sum({ pass_rate: 0.25 }), 2)).toMatchObject({ verdict: "loss", keep: "base", reasons: ["base: pass rate 0.5 > 0.25"] });
      expect(decide(A, sum({}), 2)).toMatchObject({ verdict: "tie", keep: "base" });
      const mixed = decide(A, sum({ mean_cost_usd: 0.5, mean_wall_s: 200 }), 2);
      expect(mixed).toMatchObject({ verdict: "tie", keep: "base" });
      expect(mixed.reasons).toContain("both ahead on different measures");
    });
    it("needs repeat ≥ 2 and equal run counts", () => {
      expect(() => decide(A, A, 1)).toThrow(DecisionError);
      expect(() => decide(A, sum({ runs: 3 }), 2)).toThrow(/same, non-zero/);
      expect(() => decide(sum({ runs: 0 }), sum({ runs: 0 }), 2)).toThrow(DecisionError);
    });
    it("a decision fits the verdict schema", () => {
      const v = { version: 1, base: "a", variant: "b", tasks: ["t1"], repeat: 2, ...decide(A, sum({ pass_rate: 1 }), 2), summaries: { base: A, variant: sum({ pass_rate: 1 }) }, results_file: "r.jsonl", table: "" };
      expect(VerdictSchema.parse(v).verdict).toBe("win");
      expect(VerdictSchema.safeParse({ ...v, repeat: 1 }).success).toBe(false);
    });
  });

  it("markdown table: summary rows then task × profile rows; pipes escaped", () => {
    const md = markdownTable([rec({ task: "a|b" }), rec({ task: "a|b", profile: "b", hidden_pass: false, result: "failed" })], ["a", "b"]);
    expect(md).toContain("| a | 1 | 1 | 1 |");
    expect(md).toContain("| b | 1 | 0 | 0 |");
    expect(md).toContain("| a\\|b | b | 0/1 | failed |");
  });
});
