import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseCheckOutcome, checkBlocksGate, failureSummary, formatGateResults, runChecks, type GateReport } from "../../src/steps/gates.js";
import type { Check } from "../../src/schemas/repo.js";

const env = { PATH: process.env.PATH ?? "" };

function dirWith(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-flake-"));
  writeFileSync(join(dir, name), source);
  return dir;
}

/** First process fails, the second passes. Both wait so duration_ms is the sum. */
function flipScript(counter: string, prelude: string, fail: string): string {
  return `${prelude}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
const p = ${JSON.stringify(counter)};
const n = existsSync(p) ? Number(readFileSync(p, "utf8")) : 0;
writeFileSync(p, String(n + 1));
if (n === 0) {
${fail}
}
`;
}

const opts = (cwd: string) => ({ cwd, env, envCommand: "", gateTimeoutMinutes: 20 });

describe("red then green", () => {
  it("a product flake stays visible, blocks the gate, and records both attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-flake-"));
    writeFileSync(join(dir, "flake.mjs"), flipScript(join(dir, "n"), 'import assert from "node:assert/strict";', "assert.equal(1, 2);"));
    const [row] = await runChecks([{ name: "unit", run: "node flake.mjs", tier: "fast" }], opts(dir));
    expect(row).toMatchObject({ status: "flaky" });
    expect(row!.flake_allowed).toBeUndefined();
    expect(checkBlocksGate(row!)).toBe(true);
    expect(row!.output_tail).toMatch(/instability: red then green; not a pass/);
    expect(row!.output_tail).toMatch(/AssertionError/);
    expect(row!.duration_ms).toBeGreaterThanOrEqual(350);
    const report = { n: 1, tier: "fast", green: false, changed_files: [], checks: [row!], scope_report: [] } satisfies GateReport;
    expect(failureSummary(report)).toMatch(/instability: red then green/);
    expect(formatGateResults(report.checks)).toMatch(/instability: red then green/);
  }, 15_000);

  it("an infrastructure retry passes and names both attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-flake-"));
    writeFileSync(join(dir, "flake.mjs"), flipScript(join(dir, "n"), "", 'console.error("connect ECONNRESET");\nprocess.exit(1);'));
    const [row] = await runChecks([{ name: "unit", run: "node flake.mjs", tier: "fast" }], opts(dir));
    expect(row).toMatchObject({ status: "pass" });
    expect(row!.output_tail).toMatch(/infrastructure retry: first attempt failed, second passed/);
    expect(row!.output_tail).toMatch(/ECONNRESET/);
    expect(checkBlocksGate(row!)).toBe(false);
    expect(row!.duration_ms).toBeGreaterThanOrEqual(350);
  }, 15_000);

  it("flake_allow is the only product exception, and it stays visible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-flake-"));
    writeFileSync(join(dir, "flake.mjs"), flipScript(join(dir, "n"), 'import assert from "node:assert/strict";', "assert.equal(1, 2);"));
    const check: Check = { name: "unit", run: "node flake.mjs", tier: "fast", flake_allow: "known ordering in the fixture clock" };
    const [row] = await runChecks([check], opts(dir));
    expect(row).toMatchObject({ status: "flaky", flake_allowed: true });
    expect(row!.output_tail).toMatch(/flake allowed \(known ordering in the fixture clock\): red then green/);
    expect(row!.output_tail).toMatch(/AssertionError/);
    expect(checkBlocksGate(row!)).toBe(false);
    expect(row!.duration_ms).toBeGreaterThanOrEqual(350);
  }, 15_000);

  it("a manual check without an owner fails closed and does not run", async () => {
    const dir = dirWith("ran.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync("ran", "x");\n');
    const [row] = await runChecks([{ name: "cloud", run: "node ran.mjs", tier: "manual" }], opts(dir));
    expect(row).toMatchObject({ status: "fail", duration_ms: 0 });
    expect(row!.output_tail).toMatch(/manual check has no owner/);
    expect(existsSync(join(dir, "ran"))).toBe(false);
    expect(checkBlocksGate(row!)).toBe(true);
  });

  it("a manual check with an owner is a pass that names the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-flake-"));
    const [row] = await runChecks([{ name: "cloud", run: "true", tier: "manual", owner: "ops" }], opts(dir));
    expect(row).toMatchObject({ status: "pass", output_tail: "owner: ops" });
    expect(checkBlocksGate(row!)).toBe(false);
  });

  it("an unexplained flake on the base is not a green base", () => {
    const flaky = { name: "unit", kind: "check" as const, status: "flaky" as const, duration_ms: 400, output_tail: "instability: red then green; not a pass" };
    expect(baseCheckOutcome([flaky])).toEqual({
      result: "needs_human",
      reason: "fast checks unstable on base (red then green, not a pass): unit",
    });
    expect(baseCheckOutcome([{ ...flaky, flake_allowed: true, output_tail: "flake allowed (clock): red then green" }])).toBeUndefined();
  });
});
