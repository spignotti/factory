import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runScenario } from "../helpers/scenario.js";

describe("gate phase", () => {
  it("runs one command once and does not repeat a baseline name", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => {
        (c.checks as Record<string, unknown>[]).push({ name: "gitleaks", run: "true", tier: "fast" });
      },
    });
    expect(r.result.result).toBe("done");
    const reports = readdirSync(r.runDir)
      .filter((name) => /^gates-\d+\.json$/.test(name))
      .map((name) => JSON.parse(r.file(name)) as { tier: string; checks: { name: string; kind: string; status: string; duration_ms: number; output_tail: string }[] });
    const full = reports.filter((gate) => gate.tier === "full");
    expect(full.length).toBeGreaterThan(0);
    const gate = full[full.length - 1]!;
    const unit = gate.checks.find((check) => check.name === "unit");
    const suite = gate.checks.find((check) => check.name === "suite");
    expect(unit).toMatchObject({ status: "pass" });
    expect(unit!.duration_ms).toBeGreaterThan(0);
    expect(suite).toMatchObject({ status: "pass", duration_ms: 0 });
    expect(suite!.output_tail).toMatch(/same command as unit/);
    const leaks = gate.checks.filter((check) => check.name === "gitleaks");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ kind: "check", status: "pass" });
  });
});
