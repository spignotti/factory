import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { runScenario } from "../helpers/scenario.js";

type Out = { findings: Record<string, unknown>[]; prior: Record<string, unknown>[]; responses: Record<string, unknown>[] };
const out = (s: FakeStep) => s.output as Out;

/** wontfix.json turned into: round-1 bug finding with the given `checkable`, fixed in round 2. */
const bugFixed = (checkable: unknown) => (s: FakeStep[]) => {
  Object.assign(out(s[2]!).findings[0]!, { severity: "bug", checkable });
  out(s[4]!).responses[0] = { finding_id: "R1-plan-1", status: "fixed", response: "fixed" };
  out(s[5]!).prior[0] = { finding_id: "R1-plan-1", verdict: "resolved" };
  return s;
};

describe("review output robustness (regression: a checkable 'yes' bug ended the run in round 1)", () => {
  for (const checkable of ["yes", true, "unit test", "test"]) {
    it(`a bug finding with checkable ${JSON.stringify(checkable)} is kept and gets a fix round`, async () => {
      const r = await runScenario({ script: "wontfix.json", steps: bugFixed(checkable) });
      expect(r.result).toMatchObject({ result: "done", rounds: 2 });
      const round1 = r.events.find((e) => e.event === "round_finished" && e.data.round === 1)!;
      expect(round1.data).toMatchObject({ open_bugs: 1, decision: { action: "fix" } });
      expect(r.runner.remaining()).toEqual({});
      // one review_plan call per round: no corrective retry was needed
      expect(r.runner.calls.filter((c) => c.role === "review_plan")).toHaveLength(2);
    });
  }

  it("verdicts on unknown finding ids are invalid output: corrective retry, the finding survives", async () => {
    const r = await runScenario({
      script: "wontfix.json",
      steps: (s) => {
        bugFixed("test")(s);
        // round 1 first answers with a stale verdict (as if for round 2), then correctly
        const stale: FakeStep = { role: "review_plan", output: { reviewer: "plan", prior: [{ finding_id: "R1-plan-1", verdict: "resolved" }], findings: [] } };
        s.splice(2, 0, stale);
        return s;
      },
    });
    expect(r.result).toMatchObject({ result: "done", rounds: 2 });
    expect(r.runner.calls.filter((c) => c.role === "review_plan")).toHaveLength(3);
    expect(r.runner.calls.filter((c) => c.role === "review_plan")[1]!.prompt).toMatch(/unknown finding ids: R1-plan-1/);
    expect(r.runner.remaining()).toEqual({});
  });
});
