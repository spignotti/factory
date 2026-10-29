import { describe, expect, it } from "vitest";
import { capNits, decideExit, findingKey, isStalemate, mergeRound, openFindings, type TrackedFinding } from "../../src/pipeline/merge.js";
import { type Finding, FindingSchema, type ReviewOutput } from "../../src/schemas/review.js";

const f = (o: Partial<Finding> & { claim: string }): Finding => FindingSchema.parse({ severity: "suggestion", file: "src/a.js", line: 1, ...o });
const review = (reviewer: ReviewOutput["reviewer"], findings: Finding[], prior: ReviewOutput["prior"] = []): ReviewOutput => ({ reviewer, findings, prior });

describe("merge / dedupe / nit cap", () => {
  it("assigns R<round>-<reviewer>-<n> ids", () => {
    const m = mergeRound([], 1, [review("plan", [f({ claim: "a" }), f({ claim: "b" })]), review("simplicity", [f({ claim: "c" })])], 5);
    expect(m.added.map((x) => x.id)).toEqual(["R1-plan-1", "R1-plan-2", "R1-simplicity-1"]);
    expect(m.added.every((x) => x.status === "open" && x.round === 1)).toBe(true);
  });

  it("dedupes on file + line + normalized claim across reviewers", () => {
    const m = mergeRound([], 1, [
      review("plan", [f({ claim: "Missing null check!" })]),
      review("simplicity", [f({ claim: "missing   null check" }), f({ claim: "missing null check", line: 2 })]),
    ], 5);
    expect(m.added.map((x) => x.id)).toEqual(["R1-plan-1", "R1-simplicity-1"]);
    expect(m.added[1]?.line).toBe(2);
    expect(m.dropped.repeats).toBe(1);
  });

  it("removes repeats of known findings in later rounds", () => {
    const r1 = mergeRound([], 1, [review("plan", [f({ claim: "x" })])], 5);
    const r2 = mergeRound(r1.findings, 2, [review("plan", [f({ claim: "X." }), f({ claim: "new" })])], 5);
    expect(r2.added.map((x) => x.id)).toEqual(["R2-plan-1"]);
    expect(r2.added[0]?.claim).toBe("new");
  });

  it("reopens a resolved finding reported again (regression) instead of dropping it", () => {
    const r1 = mergeRound([], 1, [review("plan", [f({ claim: "null deref", severity: "bug" })])], 5);
    const r2 = mergeRound(r1.findings, 2, [review("plan", [], [{ finding_id: "R1-plan-1", verdict: "resolved" }])], 5);
    expect(openFindings(r2.findings)).toEqual([]);
    const r3 = mergeRound(r2.findings, 3, [review("plan", [f({ claim: "Null deref", severity: "bug" })])], 5);
    expect(r3.reopened).toEqual(["R1-plan-1"]);
    expect(r3.added).toEqual([]);
    expect(openFindings(r3.findings).map((x) => x.id)).toEqual(["R1-plan-1"]);
  });

  it("caps nits per reviewer per round, never other severities", () => {
    const fs = [f({ claim: "n1", severity: "nit" }), f({ claim: "b", severity: "bug" }), f({ claim: "n2", severity: "nit" }), f({ claim: "n3", severity: "nit" })];
    expect(capNits(fs, 2).map((x) => x.claim)).toEqual(["n1", "b", "n2"]);
    const m = mergeRound([], 1, [review("plan", fs), review("simplicity", [f({ claim: "s1", severity: "nit" }), f({ claim: "s2", severity: "nit" })])], 1);
    expect(m.added.map((x) => x.claim)).toEqual(["n1", "b", "s1"]);
    expect(m.dropped.nits).toBe(3);
  });

  it("applies verdicts only to the reviewer's own prior findings", () => {
    const r1 = mergeRound([], 1, [review("plan", [f({ claim: "a" }), f({ claim: "b" }), f({ claim: "c" })]), review("simplicity", [f({ claim: "d" })])], 5);
    const r2 = mergeRound(r1.findings, 2, [
      review("plan", [], [
        { finding_id: "R1-plan-1", verdict: "resolved" },
        { finding_id: "R1-plan-2", verdict: "accept_wontfix" },
        { finding_id: "R1-plan-3", verdict: "still_open" },
        { finding_id: "R1-simplicity-1", verdict: "resolved" },
      ]),
    ], 5);
    expect(Object.fromEntries(r2.findings.map((x) => [x.id, x.status]))).toEqual({
      "R1-plan-1": "resolved", "R1-plan-2": "accepted_wontfix", "R1-plan-3": "open", "R1-simplicity-1": "open",
    });
    expect(openFindings(r2.findings).map((x) => x.id)).toEqual(["R1-plan-3", "R1-simplicity-1"]);
    expect(r1.findings[0]?.status).toBe("open");
  });

  it("findingKey normalizes the claim", () => {
    expect(findingKey({ file: "a", line: 3, claim: "Foo,  BAR" })).toBe("a:3:foo bar");
  });
});

describe("stalemate", () => {
  it("is detected when a reviewer rejects a wontfix", () => {
    const r1 = mergeRound([], 1, [review("plan", [f({ claim: "a" })])], 5);
    const r2 = mergeRound(r1.findings, 2, [review("plan", [], [{ finding_id: "R1-plan-1", verdict: "reject_wontfix" }])], 5);
    expect(isStalemate(r2)).toBe(true);
    expect(r2.stalemate).toEqual(["R1-plan-1"]);
    expect(r2.findings[0]?.status).toBe("open");
  });

  it("is not detected for still_open or accept_wontfix", () => {
    const r1 = mergeRound([], 1, [review("plan", [f({ claim: "a" }), f({ claim: "b" })])], 5);
    const r2 = mergeRound(r1.findings, 2, [review("plan", [], [
      { finding_id: "R1-plan-1", verdict: "still_open" }, { finding_id: "R1-plan-2", verdict: "accept_wontfix" },
    ])], 5);
    expect(isStalemate(r2)).toBe(false);
  });
});

describe("exit rules", () => {
  const open = (severity: Finding["severity"]): TrackedFinding => ({ ...f({ claim: severity, severity }), id: "x", reviewer: "plan", round: 1, status: "open" });
  const exit = (round: number, o: TrackedFinding[], stalemate = false) => decideExit({ round, maxRounds: 2, stalemate, open: o });

  it("1: stalemate -> needs_human, before anything else", () => {
    expect(exit(1, [], true)).toMatchObject({ action: "needs_human", rule: 1 });
  });
  it("2: no open findings -> done", () => {
    expect(exit(1, [])).toMatchObject({ action: "done", rule: 2 });
  });
  it("3: max rounds without open bug -> done", () => {
    expect(exit(2, [open("suggestion"), open("nit")])).toMatchObject({ action: "done", rule: 3 });
  });
  it("4: max rounds with open bug -> one extra round", () => {
    expect(exit(2, [open("bug")])).toMatchObject({ action: "fix", rule: 4 });
  });
  it("5: extra round with open bug -> needs_human", () => {
    expect(exit(3, [open("bug")])).toMatchObject({ action: "needs_human", rule: 5 });
  });
  it("extra round without open bug -> done", () => {
    expect(exit(3, [open("suggestion")])).toMatchObject({ action: "done", rule: 3 });
  });
  it("6: otherwise fix", () => {
    expect(exit(1, [open("nit")])).toMatchObject({ action: "fix", rule: 6 });
    expect(exit(1, [open("bug")])).toMatchObject({ action: "fix", rule: 6 });
  });
});
