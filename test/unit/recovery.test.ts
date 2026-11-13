import { describe, expect, it } from "vitest";
import {
  blocksProductEdit,
  budgetFrom,
  budgetTo,
  classifyRepair,
  clearRepair,
  emptyBudget,
  approvalGateGap,
  failureSignature,
  fakeFixReason,
  gateImplementation,
  MAX_GATE_ATTEMPTS,
  missingPlanQuotes,
  openPrProblem,
  recordFailure,
  recoverRedGates,
  repairDecision,
  repairHandover,
  repairStrategy,
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

  describe("failure identity (#181)", () => {
    const gate = (name: string, tail: string, status: "fail" | "pass" = "fail") => ({ name, kind: "check", status, output_tail: tail });

    it("fingerprints the same ShellCheck finding despite pid, line and timestamp churn", () => {
      const a = failureSignature({
        checks: [gate("shellcheck", "src/math.js:12345:12:9: SyntaxError: unexpected token (SC2166) 1735689600123456789"), gate("syntax", "SyntaxError: Unexpected end of input")],
      });
      const b = failureSignature({
        checks: [gate("syntax", "SyntaxError: Unexpected end of input"), gate("shellcheck", "src/math.js:98765:31:4: SyntaxError: Unexpected token (SC2166) 1735699999876543210")],
      });
      expect(a).toMatch(/^[0-9a-f]{12}$/);
      expect(a).toBe(b);
    });

    it("separates different findings, different checks and red from green", () => {
      expect(failureSignature({ checks: [gate("shellcheck", "src/a.sh:1:1: SC2166 did you mean this?")] })).not.toBe(
        failureSignature({ checks: [gate("shellcheck", "src/a.sh:1:1: SC1091 not following")] }),
      );
      expect(failureSignature({ checks: [gate("a", "boom")] })).not.toBe(failureSignature({ checks: [gate("b", "boom")] }));
      expect(failureSignature({ checks: [gate("a", "boom", "pass")] })).not.toBe(failureSignature({ checks: [gate("a", "boom")] }));
    });

    it("keeps a reworded ShellCheck finding and does not collapse swapped values", () => {
      const warning = failureSignature({
        checks: [gate("shellcheck", "src/a.sh:12:3: warning: Don't use -a or -o. [SC2166]")],
      });
      const reworded = failureSignature({
        checks: [gate("shellcheck", "In src/a.sh line 40:\nnote: SC2166 Prefer [ p ] || [ q ] as [ p -a q ] is not well defined.")],
      });
      expect(warning).toBe(reworded);
      expect(failureSignature({ checks: [gate("shellcheck", "SC2166 expected 1 but got 2")] })).not.toBe(
        failureSignature({ checks: [gate("shellcheck", "SC2166 expected 2 but got 1")] }),
      );
      expect(failureSignature({ checks: [gate("unit", "AssertionError: expected 1 to equal 2")] })).not.toBe(
        failureSignature({ checks: [gate("unit", "AssertionError: expected 2 to equal 1")] }),
      );
      expect(failureSignature({ checks: [gate("unit", "duration_ms 64.7595\n✖ test (62.081708ms)\nAssertionError: expected 1 to equal 2")] })).toBe(
        failureSignature({ checks: [gate("unit", "duration_ms 11.02\n✖ test (9.1ms)\nAssertionError: expected 1 to equal 2")] }),
      );
      expect(failureSignature({ checks: [gate("shellcheck", "SC2166 boom")] })).not.toBe(
        failureSignature({ checks: [gate("syntax", "SC2166 boom")] }),
      );
    });

    it("does not collapse the same diagnostic code in different files, and rewording the same file does not reset it", () => {
      const a = failureSignature({ checks: [gate("shellcheck", "src/a.sh:1:1: warning: SC2166 Don't use -a or -o.")] });
      const b = failureSignature({ checks: [gate("shellcheck", "src/b.sh:1:1: warning: SC2166 Don't use -a or -o.")] });
      expect(a).not.toBe(b);
      expect(a).toBe(failureSignature({ checks: [gate("shellcheck", "In src/a.sh line 40:\nnote: SC2166 Prefer [ p ] || [ q ].")] }));
      expect(a).toBe(failureSignature({ checks: [gate("shellcheck", "src/a.sh:8:1: warning: SC2166 see src/lib.sh for an example")] }));
      expect(a).toBe(failureSignature({ checks: [gate("shellcheck", '{"file":"src/a.sh","code":"SC2166","level":"warning"}')] }));
      expect(failureSignature({ checks: [gate("typecheck", "src/a.ts(12,3): error TS2345: bad")] })).not.toBe(
        failureSignature({ checks: [gate("typecheck", "src/b.ts(12,3): error TS2345: bad")] }),
      );
      expect(failureSignature({ checks: [gate("typecheck", "src/a.ts(12,3): error TS2345: bad")] })).toBe(
        failureSignature({ checks: [gate("typecheck", "src/a.ts(40,1): error TS2345: Argument of type 'x' is not assignable.")] }),
      );
      const both = failureSignature({ checks: [gate("shellcheck", "src/b.sh:2:1: warning: SC2166\nsrc/a.sh:4:1: warning: SC2166")] });
      expect(both).toBe(failureSignature({ checks: [gate("shellcheck", "In src/a.sh line 9:\nSC2166\nIn src/b.sh line 3:\nSC2166")] }));
      expect(both).not.toBe(a);
    });

    it("counts repeated identical failures, escalates the strategy, resets on a changed failure and survives a persist round-trip", () => {
      const budget = emptyBudget();
      expect(repairStrategy(budget)).toBe("repeat");
      recordFailure(budget, "sigA", "aaaaaaaaaaaaaaaa");
      expect(repairStrategy(budget)).toBe("repeat");
      expect(recordFailure(budget, "sigA", "bbbbbbbbbbbbbbbb")).toEqual({ signature: "sigA", checkpoint: "bbbbbbbbbbbbbbbb", unchanged: 2, roots: [] });
      expect(repairStrategy(budget)).toBe("diagnose");
      recordFailure(budget, "sigB", "bbbbbbbbbbbbbbbb");
      expect(budget.failure).toEqual({ signature: "sigB", checkpoint: "bbbbbbbbbbbbbbbb", unchanged: 1, roots: [] });
      expect(repairStrategy(budget)).toBe("repeat");
      const restored = budgetFrom(budgetTo(budget));
      expect(restored.failure).toEqual(budget.failure);
      clearRepair(restored);
      expect(restored.failure).toBeUndefined();
    });

    it("returns diagnose instead of the same prompt when the unchanged failure comes back, and reports it when exhausted", async () => {
      const emitted: unknown[] = [];
      const budget = emptyBudget();
      const ctx = { budget, repo: { checks }, worktree: "/absent", events: { emit: (e: unknown) => emitted.push(e) } } as unknown as RunContext;
      const report: GateReport = {
        n: 1,
        tier: "fast",
        green: false,
        changed_files: [],
        checks: [{ name: "syntax", kind: "check", status: "fail", duration_ms: 1, output_tail: "SyntaxError: Unexpected token" }],
        scope_report: [],
      };
      const opts = { tier: "fast" as const, packages: ["P1"], spend: true };
      const first = await recoverRedGates(ctx, report, opts);
      expect(first.action).toBe("retry");
      if (first.action === "retry") expect(first.strategy).toBe("repeat");
      const second = await recoverRedGates(ctx, report, opts);
      expect(second.action).toBe("retry");
      if (second.action === "retry") expect(second.strategy).toBe("diagnose");
      expect(emitted.some((e) => JSON.stringify(e).includes('"repair":"strategy"'))).toBe(true);
      const third = await recoverRedGates(ctx, report, opts);
      expect(third.action).toBe("stop");
      if (third.action === "stop") {
        expect(third.cause).toBe("budget_exhausted");
        expect(third.reason).toMatch(/attempts=3\/3/);
        expect(third.reason).toMatch(/failure=[0-9a-f]{12} unchanged=3/);
        expect(third.reason).toContain("SyntaxError");
      }
      expect(budget.gateAttempts).toBe(MAX_GATE_ATTEMPTS);
    });

    it("does not treat suppression, severity reduction, or a dropped gate as a fix", () => {
      const roots = [{ name: "shellcheck", codes: ["sc2166"], severity: "error" as const }];
      const commands = [{ name: "shellcheck", run: "tools/shcheck" }];
      const present = ["shellcheck", "syntax", "unit"];
      expect(fakeFixReason({
        roots,
        reportNames: present,
        diff: "diff --git a/src/a.sh b/src/a.sh\n+++ b/src/a.sh\n+# shellcheck disable=SC2166\n",
        changed: ["src/a.sh"],
        commands,
      })).toMatch(/suppression is not a fix/);
      expect(fakeFixReason({
        roots,
        reportNames: present,
        diff: "diff --git a/.shellcheckrc b/.shellcheckrc\n+++ b/.shellcheckrc\n+severity=style\n",
        changed: [".shellcheckrc"],
        commands,
      })).toMatch(/severity reduced/);
      expect(fakeFixReason({
        roots,
        reportNames: ["syntax", "unit"],
        diff: "",
        changed: ["src/math.js"],
        commands,
      })).toMatch(/dropped gate/);
      expect(fakeFixReason({
        roots,
        reportNames: present,
        diff: "diff --git a/tools/shcheck b/tools/shcheck\n+++ b/tools/shcheck\n+exit 0\n",
        changed: ["tools/shcheck"],
        commands,
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots,
        reportNames: present,
        diff: "diff --git a/src/math.js b/src/math.js\n+++ b/src/math.js\n+export function multiply() {}\n",
        changed: ["src/math.js"],
        commands: [{ name: "syntax", run: "node --check src/math.js" }, ...commands],
      })).toBeUndefined();
    });

    it("does not treat an interpreter-wrapped gate script or package script rewritten to exit 0 as a fix", () => {
      const present = ["shellcheck", "syntax", "unit"];
      const shell = [{ name: "shellcheck", codes: ["sc2166"], severity: "error" as const }];
      expect(fakeFixReason({
        roots: shell,
        reportNames: present,
        diff: "diff --git a/tools/shcheck b/tools/shcheck\n+++ b/tools/shcheck\n+exit 0\n",
        changed: ["tools/shcheck"],
        commands: [{ name: "shellcheck", run: "sh tools/shcheck" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: shell,
        reportNames: present,
        diff: "diff --git a/tools/shcheck b/tools/shcheck\n+++ b/tools/shcheck\n+exit 0\n",
        changed: ["tools/shcheck"],
        commands: [{ name: "shellcheck", run: "sh -eu tools/shcheck" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: shell,
        reportNames: present,
        diff: "diff --git a/tools/shcheck b/tools/shcheck\n+++ b/tools/shcheck\n+true\n",
        changed: ["tools/shcheck"],
        commands: [{ name: "shellcheck", run: "bash tools/shcheck" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: [{ name: "unit", codes: ["e501"], severity: "error" as const }],
        reportNames: present,
        diff: "diff --git a/package.json b/package.json\n+++ b/package.json\n+\"test\": \"exit 0\"\n",
        changed: ["package.json"],
        commands: [{ name: "unit", run: "npm test" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: [{ name: "unit", codes: ["e501"], severity: "error" as const }],
        reportNames: present,
        diff: "diff --git a/package.json b/package.json\n+++ b/package.json\n+\"test\": \"true\"\n",
        changed: ["package.json"],
        commands: [{ name: "unit", run: "pnpm run test" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: [{ name: "lint", codes: ["e501"], severity: "error" as const }],
        reportNames: ["lint", ...present],
        diff: "diff --git a/tools/check.js b/tools/check.js\n+++ b/tools/check.js\n+process.exit(0)\n",
        changed: ["tools/check.js"],
        commands: [{ name: "lint", run: "node tools/check.js src/math.js" }],
      })).toMatch(/altered/);
      expect(fakeFixReason({
        roots: [{ name: "lint", codes: ["e501"], severity: "error" as const }],
        reportNames: ["lint", ...present],
        diff: "diff --git a/src/math.js b/src/math.js\n+++ b/src/math.js\n+export function multiply() {}\n",
        changed: ["src/math.js"],
        commands: [{ name: "lint", run: "node tools/check.js src/math.js" }, { name: "syntax", run: "node --check src/math.js" }, { name: "unit", run: "npm test" }],
      })).toBeUndefined();
      expect(fakeFixReason({
        roots: [{ name: "syntax", codes: [], severity: "error" as const }],
        reportNames: ["syntax"],
        diff: "diff --git a/src/math.js b/src/math.js\n+++ b/src/math.js\n+export function multiply() {}\n",
        changed: ["src/math.js"],
        commands: [{ name: "syntax", run: "node --check src/math.js" }],
      })).toBeUndefined();
      expect(gateImplementation("npm test")).toBe("package.json");
      expect(gateImplementation("pnpm run test")).toBe("package.json");
      expect(gateImplementation("node --check src/math.js")).toBeUndefined();
      expect(gateImplementation("python -m pytest tests/foo.py")).toBeUndefined();
      expect(gateImplementation("sh tools/shcheck src/math.js")).toBe("tools/shcheck");
    });

    it("does not treat comma-separated disables, attached -e flags, or -S warning as a fix", () => {
      const roots = [{ name: "shellcheck", codes: ["sc2166"], severity: "warning" as const }];
      const commands = [{ name: "shellcheck", run: "shellcheck src/a.sh" }];
      const reason = (body: string) => fakeFixReason({
        roots,
        reportNames: ["shellcheck"],
        diff: `diff --git a/.shellcheckrc b/.shellcheckrc\n+++ b/.shellcheckrc\n${body}\n`,
        changed: [".shellcheckrc"],
        commands,
      });
      expect(reason("+disable=SC2086,SC2166")).toMatch(/not a fix/);
      expect(reason("+disable=SC2086, SC2166")).toMatch(/not a fix/);
      expect(reason("+shellcheck -eSC2166 src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck -eSC2086,SC2166 src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck --exclude=SC2086,SC2166 src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck -e SC2166 src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck -S warning src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck -Swarning src/a.sh")).toMatch(/not a fix/);
      expect(reason("+shellcheck --severity=warning src/a.sh")).toMatch(/not a fix/);
      expect(reason("+severity=warning")).toMatch(/not a fix/);
      expect(fakeFixReason({
        roots,
        reportNames: ["shellcheck"],
        diff: "diff --git a/src/a.sh b/src/a.sh\n+++ b/src/a.sh\n+# fixed the -a test; SC2166 was the warning\n",
        changed: ["src/a.sh"],
        commands,
      })).toBeUndefined();
    });

    it("refuses approval when the required gate set is incomplete or still red", () => {
      expect(approvalGateGap({ required: ["syntax", "shellcheck"], report: [{ name: "syntax", status: "pass" }] })).toMatch(/incomplete/);
      expect(approvalGateGap({ required: ["syntax"], report: [{ name: "syntax", status: "fail" }] })).toMatch(/not approving/);
      expect(approvalGateGap({ required: ["syntax", "unit"], report: [{ name: "syntax", status: "pass" }, { name: "unit", status: "pass" }] })).toBeUndefined();
    });

    it("handovers the remaining failure identity when one is known", () => {
      const text = repairHandover({
        cls: "code",
        attempts: 3,
        max: 3,
        diagnosis: "SyntaxError: Unexpected token",
        checkpoint: "abc123def456",
        next: "Fix the failing checks on this branch.",
        failure: { signature: "deadbeefcafe", unchanged: 3 },
      });
      expect(text).toContain("failure=deadbeefcafe unchanged=3");
    });
  });
});
