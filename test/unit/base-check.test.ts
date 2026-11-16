import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseCheckGate, baseProblem, baseRecheckMs, readBaseCheck, writeBaseCheck } from "../../src/pipeline/base-check.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T08:00:00.000Z");
const at = new Date(T0).toISOString();

describe("local base check re-check backoff", () => {
  it("waits 30 min, then 1 h, 2 h and at most 4 h while the same base stays red", () => {
    expect([0, 1, 2, 3, 4, 9].map((rechecks) => baseRecheckMs({ rechecks }) / MIN)).toEqual([30, 60, 120, 240, 240, 240]);
    for (const [rechecks, minutes] of [[undefined, 30], [1, 60], [2, 120], [3, 240], [6, 240]] as const) {
      const record = { sha: "abc1234", status: "red" as const, failed: ["unit"], at, ...(rechecks !== undefined ? { rechecks } : {}) };
      expect(baseCheckGate(record, "abc1234", T0 + (minutes - 1) * MIN), `${rechecks}`).toBe("block");
      expect(baseCheckGate(record, "abc1234", T0 + (minutes + 1) * MIN), `${rechecks}`).toBe("recheck");
    }
    expect(baseProblem({ sha: "abc1234", status: "red", failed: ["unit"], at, rechecks: 2 })).toContain(`re-check after ${new Date(T0 + 120 * MIN).toISOString()}`);
  });

  it("a new base SHA starts at once and resets the backoff", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-base-check-"));
    expect(baseCheckGate({ sha: "abc1234", status: "red", failed: [], at, rechecks: 3 }, "def5678", T0)).toBe("start");
    writeBaseCheck(home, "k", { sha: "abc1234", status: "red", failed: ["unit"], at, rechecks: 2 });
    // A run that finds the same base red again keeps the count the worker raised.
    writeBaseCheck(home, "k", { sha: "abc1234", status: "red", failed: ["unit"], at });
    expect(readBaseCheck(home, "k")?.rechecks).toBe(2);
    writeBaseCheck(home, "k", { sha: "def5678", status: "red", failed: ["unit"], at });
    expect(readBaseCheck(home, "k")?.rechecks).toBeUndefined();
    writeBaseCheck(home, "k", { sha: "def5678", status: "red", failed: ["unit"], at, rechecks: 1 });
    writeBaseCheck(home, "k", { sha: "def5678", status: "green", failed: [], at });
    expect(readBaseCheck(home, "k")?.rechecks).toBeUndefined();
  });
});
