import { describe, expect, it } from "vitest";
import { fixedDeadline } from "../../src/pipeline/budget.js";
import { gateCheckTimeoutMs } from "../../src/gates/timeout.js";
import { repoConfigLoosening } from "../../src/gates/config-guard.js";
import { adoptCheckTimeoutMinutes } from "../../src/adopt/draft.js";
import { RepoConfigSchema } from "../../src/schemas/repo.js";
import { runChecks } from "../../src/steps/gates.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("gate check timeout", () => {
  it("defaults gate_timeout_minutes to 20 in repo.yaml", () => {
    expect(RepoConfigSchema.parse({}).limits.gate_timeout_minutes).toBe(20);
  });

  it("effective timeout uses per-check override and caps at the wall budget", () => {
    const inTwoMin = fixedDeadline(Date.now() + 120_000);
    expect(gateCheckTimeoutMs({ gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
    expect(gateCheckTimeoutMs({ check: { timeout_minutes: 5 }, gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
    expect(gateCheckTimeoutMs({ check: { timeout_minutes: 30 }, gateTimeoutMinutes: 20, deadline: inTwoMin })).toBe(120_000);
    expect(gateCheckTimeoutMs({ gateTimeoutMinutes: 20 })).toBe(20 * 60_000);
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
  });
});
