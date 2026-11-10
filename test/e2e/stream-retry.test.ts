import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { readState } from "../../src/pipeline/state.js";
import { runScenario, type ScenarioRun } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const eventsOf = (r: ScenarioRun, type: string) => r.events.filter((e) => e.event === type);

const ABORT = "Stream ended without finish_reason";

/** clean.json plus an independent P2, with extra implement steps inserted after P1's scripted step. */
function withP2(extra: FakeStep[]) {
  return (steps: FakeStep[]): FakeStep[] => {
    const out: FakeStep[] = [];
    let inserted = false;
    for (const s of steps) {
      if (s.role === "plan_high") {
        const plan = s.output as { packages: object[]; acceptance: object[] };
        plan.packages.push({
          id: "P2", title: "extra", description: "add extra", files: ["src/extra.js"], depends_on: [], changes_flows: [],
          source_quote: "Add a multiply function to src/math.js.",
        });
        plan.acceptance.push({
          id: "A2", package: "P2", text: "extra exists", verify: "review", kind: "behavior", risk: false,
          source_quote: "Add a multiply function to src/math.js.",
        });
      }
      out.push(s);
      if (s.role === "implement" && !inserted) {
        inserted = true;
        out.push(...extra);
      }
    }
    return out;
  };
}

const p2ok: FakeStep = {
  role: "implement",
  writes: { "src/extra.js": "export const extra = 1;\n" },
  output: {
    package: "P2", done: ["extra"], decisions: [], deviations_from_plan: [], skipped: [], uncertain: [], evidence: [], responses: [],
  },
};

describe("provider stream abort", () => {
  it("retries the current package and keeps the one already committed", async () => {
    const abort: FakeStep = {
      role: "implement",
      error: { message: ABORT },
      usage: { tokens_in: 2_500_000, tokens_out: 0, cost_usd: 0 },
    };
    const r = await runScenario({
      script: "clean.json",
      steps: withP2([abort, p2ok]),
      patch: (c) => void ((c.limits as Record<string, unknown>).pr_ci_wait_minutes = 0),
    });
    expect(r.result.result).toBe("done");
    expect(readState(r.runDir).packages).toEqual({ P1: "done", P2: "done" });
    const log = git(join(r.runDir, "worktree"), "log", "--format=%s", "main..HEAD");
    expect(log).toContain("feat(P1): multiply");
    expect(log).toContain("feat(P2): extra");
    expect(r.runner.calls.filter((c) => c.role === "implement").map((c) => c.model)).toEqual([
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(eventsOf(r, "step_retry")).toEqual([
      expect.objectContaining({
        step: "implement",
        role: "implement",
        data: { class: "stream", attempt: 1, max: 2, delay_ms: 1000, package: "P2" },
      }),
    ]);
    expect(eventsOf(r, "agent_error")[0]).toMatchObject({ data: { class: "stream", message: ABORT }, tokens_in: 2_500_000 });
    const warning = r.events.find((e) => e.data.warning === "step_tokens");
    expect(warning).toMatchObject({ event: "progress", tokens_in: 0, data: { tokens_in: 2_500_000, threshold: 1_000_000 } });
    expect(r.slept).toEqual([1000]);
  });

  it("ends needs_human after the stream retry budget, with earlier packages kept", async () => {
    const abort = (model: string): FakeStep => ({ role: "implement", model, error: { message: "premature EOF" } });
    const errors = [
      ...Array.from({ length: 3 }, () => abort("opencode-go/deepseek-v4.1-flash")),
      ...Array.from({ length: 3 }, () => abort("opencode-go/deepseek-v4-pro")),
    ];
    const r = await runScenario({ script: "clean.json", steps: withP2(errors) });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/^provider stream aborted after 4 retries: premature EOF; factory resume /);
    expect(readState(r.runDir)).toMatchObject({ step: "implement", result: "needs_human", transient: true, packages: { P1: "done" } });
    expect(readState(r.runDir).packages.P2).toBeUndefined();
    const log = git(join(r.runDir, "worktree"), "log", "--format=%s", "main..HEAD");
    expect(log).toContain("feat(P1): multiply");
    expect(log).not.toContain("feat(P2)");
    expect(eventsOf(r, "step_retry")).toHaveLength(4);
    expect(r.runner.calls.some((c) => c.role === "review_plan")).toBe(false);
    expect(r.slept).toEqual([1000, 2000, 1000, 2000]);
  });

  it("does not retry an auth error", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (s) => {
        const at = s.findIndex((x) => x.role === "implement");
        return [
          ...s.slice(0, at),
          { role: "implement", error: { message: "401 Unauthorized", status: 401 } },
          { role: "implement", error: { message: "401 Unauthorized", status: 401 } },
        ];
      },
    });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toContain("401 Unauthorized");
    expect(eventsOf(r, "step_retry")).toEqual([]);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(2);
    expect(eventsOf(r, "model_fallback")[0]).toMatchObject({ data: { class: "auth" } });
    expect(r.slept).toEqual([]);
  });
});
