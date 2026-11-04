import { describe, expect, it, vi } from "vitest";
import { fixedDeadline } from "../../src/pipeline/budget.js";
import { gateCheckTimeoutMs } from "../../src/gates/timeout.js";
import { repoConfigLoosening } from "../../src/gates/config-guard.js";
import { adoptCheckTimeoutMinutes } from "../../src/adopt/draft.js";
import { currentCheckName } from "../../src/run-health.js";
import { RepoConfigSchema } from "../../src/schemas/repo.js";
import { baseCheckOutcome, runChecks } from "../../src/steps/gates.js";
import { baseSyncFailureReason } from "../../src/steps/finalize.js";
import type { FactoryEvent } from "../../src/events.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("gate check timeout", () => {
  it("defaults gate_timeout_minutes to 10 (600s) in repo.yaml", () => {
    expect(RepoConfigSchema.parse({}).limits.gate_timeout_minutes).toBe(10);
    expect(gateCheckTimeoutMs({ gateTimeoutMinutes: 10 })).toBe(600_000);
  });

  it("effective timeout uses per-check override and caps at the wall budget", () => {
    // The cap is deadline.at - Date.now(). A real clock moves between the calls, so the
    // second assertion was 119999 instead of 120000 (CI run 41659495140).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const inTwoMin = fixedDeadline(Date.now() + 120_000);
      expect(gateCheckTimeoutMs({ gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
      expect(gateCheckTimeoutMs({ check: { timeout_minutes: 5 }, gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
      expect(gateCheckTimeoutMs({ check: { timeout_minutes: 30 }, gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
      expect(gateCheckTimeoutMs({ gateTimeoutMinutes: 20 })).toBe(20 * 60_000);
      expect(gateCheckTimeoutMs({ check: { timeout_s: 30 }, gateTimeoutMinutes: 20 })).toBe(30_000);
      expect(gateCheckTimeoutMs({ check: { timeout_s: 30, timeout_minutes: 5 }, gateTimeoutMinutes: 20 })).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sleeping check is killed and recorded as timeout", async () => {
    const started = Date.now();
    const [timed] = await runChecks([{ name: "hang", run: "sleep 60", tier: "fast", timeout_minutes: 1 / 60 }], {
      cwd: "/tmp",
      env,
      envCommand: "",
      gateTimeoutMinutes: 20,
    });
    expect(timed!).toMatchObject({ name: "hang", status: "timeout", timed_out: true });
    expect(timed!.output_tail).toMatch(/timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("timeout_s kills a hanging command and records timeout, not a pass", async () => {
    const started = Date.now();
    const seen: { check: string; event: string }[] = [];
    const [timed] = await runChecks([{ name: "hang", run: "sleep 30", tier: "fast", timeout_s: 0.2 }], {
      cwd: "/tmp",
      env,
      envCommand: "",
      gateTimeoutMinutes: 10,
      heartbeatMs: 50,
      onCheck: (e) => seen.push({ check: e.check, event: e.event }),
    });
    expect(timed!).toMatchObject({ name: "hang", status: "timeout", timed_out: true });
    expect(timed!.status).not.toBe("pass");
    expect(timed!.output_tail).toMatch(/timed out after /);
    expect(seen.some((e) => e.event === "progress" && e.check === "hang")).toBe(true);
    expect(seen.some((e) => e.event === "heartbeat" && e.check === "hang")).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("a base-check timeout is inconclusive, a real failure is base_red", () => {
    expect(baseCheckOutcome([{ name: "unit", kind: "check", status: "timeout", duration_ms: 1, output_tail: "timed out", timed_out: true }])).toEqual({
      result: "needs_human",
      reason: "fast checks timed out on base (inconclusive): unit",
    });
    expect(baseCheckOutcome([{ name: "unit", kind: "check", status: "fail", duration_ms: 1, output_tail: "no" }])).toEqual({
      result: "base_red",
      reason: "fast checks red on base: unit",
    });
    expect(baseCheckOutcome([{ name: "unit", kind: "check", status: "pass", duration_ms: 1, output_tail: "" }])).toBeUndefined();
  });

  it("a timed-out check is not retried as flaky", async () => {
    const started = Date.now();
    const [t] = await runChecks([{ name: "once", run: "sleep 30", tier: "fast", timeout_minutes: 1 / 60 }], {
      cwd: "/tmp",
      env,
      envCommand: "",
      gateTimeoutMinutes: 20,
    });
    expect(t!.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("adopt proposes 5× measured duration with a 5 minute floor", () => {
    expect(adoptCheckTimeoutMinutes(null)).toBeUndefined();
    expect(adoptCheckTimeoutMinutes(10)).toBe(5);
    expect(adoptCheckTimeoutMinutes(180)).toBe(15);
  });
});

describe("config_guard gate timeouts", () => {
  const base = `checks:
  - { name: typecheck, run: npm run typecheck, tier: fast, timeout_minutes: 10 }
limits: { gate_timeout_minutes: 20 }
`;

  it("raising limits.gate_timeout_minutes is loosening; lowering is not", () => {
    expect(repoConfigLoosening(base, base.replace("gate_timeout_minutes: 20", "gate_timeout_minutes: 30"))).toEqual(["limits.gate_timeout_minutes raised"]);
    expect(repoConfigLoosening(base.replace("gate_timeout_minutes: 30", "gate_timeout_minutes: 20"), base.replace("gate_timeout_minutes: 30", "gate_timeout_minutes: 15"))).toEqual([]);
  });

  it("raising a per-check timeout is loosening; lowering is not", () => {
    expect(repoConfigLoosening(base, base.replace("timeout_minutes: 10", "timeout_minutes: 15"))).toEqual(["check typecheck timeout raised"]);
    expect(repoConfigLoosening(base, base.replace("timeout_minutes: 10", "timeout_minutes: 5"))).toEqual([]);
    const noExplicit = `checks:
  - { name: typecheck, run: npm run typecheck, tier: fast }
limits: { gate_timeout_minutes: 20 }
`;
    expect(repoConfigLoosening(base, noExplicit)).toEqual(["check typecheck timeout raised"]);
    const seconds = base.replace("timeout_minutes: 10", "timeout_s: 30");
    expect(repoConfigLoosening(seconds, seconds.replace("timeout_s: 30", "timeout_s: 90"))).toEqual(["check typecheck timeout raised"]);
    expect(repoConfigLoosening(seconds, seconds.replace("timeout_s: 30", "timeout_s: 10"))).toEqual([]);
  });

  it("raising tests.timeout_s is loosening", () => {
    const before = `tests: { run: npm test, timeout_s: 60 }\nlimits: { gate_timeout_minutes: 10 }\n`;
    expect(repoConfigLoosening(before, before.replace("timeout_s: 60", "timeout_s: 120"))).toEqual(["tests.timeout_s raised"]);
    expect(repoConfigLoosening(before, before.replace("timeout_s: 60", "timeout_s: 30"))).toEqual([]);
  });
});

describe("check progress for status", () => {
  const ev = (event: FactoryEvent["event"], data: FactoryEvent["data"]): FactoryEvent => ({
    ts: new Date().toISOString(),
    run_id: "r",
    step: "finalize",
    event,
    role: null,
    model: null,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    data,
  });

  it("names the check from the latest running heartbeat until a gate result", () => {
    expect(currentCheckName([ev("progress", { check: "red_green", phase: "running", where: "base" })])).toBe("red_green");
    expect(currentCheckName([
      ev("progress", { check: "red_green", phase: "running" }),
      ev("heartbeat", { check: "red_green", phase: "running" }),
    ])).toBe("red_green");
    expect(currentCheckName([
      ev("heartbeat", { check: "red_green", phase: "running" }),
      ev("gate_result", { check: "red_green", status: "timeout" }),
    ])).toBeNull();
  });

  it("a red_green timeout after base moved is inconclusive in the run reason", () => {
    const reason = baseSyncFailureReason("main", {
      n: 1,
      tier: "full",
      green: false,
      changed_files: [],
      scope_report: [],
      checks: [{ name: "red_green", kind: "builtin", status: "timeout", duration_ms: 200, output_tail: "timed out on base", timed_out: true }],
    });
    expect(reason).toBe("base main moved: red_green timed out (inconclusive, not a red result)");
    expect(reason).not.toMatch(/gates red/);
  });
});
