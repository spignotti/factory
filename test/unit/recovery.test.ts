import { describe, expect, it } from "vitest";
import {
  blocksProductEdit,
  classifyRepair,
  emptyBudget,
  MAX_GATE_ATTEMPTS,
  missingPlanQuotes,
  openPrProblem,
  recoverRedGates,
  repairDecision,
  repairHandover,
} from "../../src/pipeline/recovery.js";
import type { RunContext } from "../../src/pipeline/context.js";
import type { GateReport } from "../../src/steps/gates.js";

const checks = [
  { name: "format", run: "tools/prettier --check src/math.js" },
  { name: "syntax", run: "node --check src/math.js" },
  { name: "external", run: "tools/hold src/math.js" },
];

describe("repair classification", () => {
  it("separates format, code, infra, config, base and unknown", () => {
    const one = (name: string, output: string, status: "fail" | "timeout" = "fail", kind = "check") =>
      classifyRepair({ checks: [{ name, kind, status, output_tail: output }] }, checks);
    expect(one("format", "prettier: trailing whitespace")).toBe("format");
    expect(one("syntax", "SyntaxError: Unexpected token")).toBe("code");
    expect(one("external", "connect ETIMEDOUT")).toBe("infra");
    expect(one("external", "sh: tools/hold: command not found")).toBe("config");
    expect(one("external", "external status: held")).toBe("unknown");
    expect(one("syntax", "killed", "timeout")).toBe("infra");
    expect(classifyRepair({ checks: [{ name: "syntax", status: "fail", output_tail: "SyntaxError: x" }] }, checks, { onBase: true })).toBe("base");
    expect(blocksProductEdit("unknown")).toBe(true);
    expect(blocksProductEdit("code")).toBe(false);
  });

  it("formats once, reruns infra once, and then stops instead of editing product code", () => {
    const fresh = emptyBudget();
    expect(repairDecision("format", fresh)).toBe("format");
    expect(repairDecision("format", { ...fresh, formatUsed: true })).toBe("fix");
    expect(repairDecision("infra", fresh)).toBe("rerun");
    expect(repairDecision("infra", { ...fresh, infraReruns: 1 })).toBe("stop");
    expect(repairDecision("unknown", fresh)).toBe("stop");
    expect(repairDecision("config", fresh)).toBe("stop");
    expect(repairDecision("base", fresh)).toBe("stop");
    expect(repairDecision("code", fresh)).toBe("fix");
    expect(MAX_GATE_ATTEMPTS).toBe(3);
  });

  it("names the class, the effort, the diagnosis, the checkpoint and the next step", () => {
    const text = repairHandover({
      cls: "unknown",
      attempts: 1,
      max: 3,
      diagnosis: "external status: held",
      checkpoint: "abc123def456",
      next: "Read the external state and answer it. Factory did not change product code for this failure.",
    });
    expect(text).toContain("class=unknown");
    expect(text).toContain("attempts=1/3");
    expect(text).toContain("checkpoint=abc123def456");
    expect(text).toContain("diagnosis: external status: held");
    expect(text).toContain("did not change product code");
  });

  it("keeps a resume on the saved plan and the saved pull request", () => {
    const plan = {
      packages: [{ source_quote: "Add a multiply function to src/math.js." }],
      acceptance: [{ source_quote: "multiply(2, 3) returns 6." }],
    };
    expect(missingPlanQuotes("Add a multiply function to src/math.js.\n\nmultiply(2, 3) returns 6.", plan)).toEqual([]);
    expect(missingPlanQuotes("A different request.", plan)).toEqual(["Add a multiply function to src/math.js.", "multiply(2, 3) returns 6."]);
    expect(openPrProblem(null, null, "factory/task")).toBeUndefined();
    expect(openPrProblem("https://github.test/pr/1", { url: "https://github.test/pr/1" }, "factory/task")).toBeUndefined();
    expect(openPrProblem("https://github.test/pr/1", null, "factory/task")).toMatch(/not opening another/);
  });

  it("does not open another fix turn when the gate budget is already spent", async () => {
    const budget = emptyBudget();
    budget.gateAttempts = MAX_GATE_ATTEMPTS;
    budget.lastClass = "code";
    const report: GateReport = {
      n: 1,
      tier: "fast",
      green: false,
      changed_files: [],
      checks: [{ name: "syntax", kind: "check", status: "fail", duration_ms: 1, output_tail: "SyntaxError: Unexpected token" }],
      scope_report: [],
    };
    const out = await recoverRedGates({ budget, repo: { checks }, worktree: "/absent" } as unknown as RunContext, report, {
      tier: "fast",
      packages: ["P1"],
      spend: false,
    });
    expect(out.action).toBe("stop");
    if (out.action === "stop") expect(out.reason).toMatch(/attempts=3\/3/);
    expect(budget.gateAttempts).toBe(MAX_GATE_ATTEMPTS);
  });
});
