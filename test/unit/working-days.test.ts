import { describe, expect, it } from "vitest";
import { RepoConfigSchema } from "../../src/schemas/repo.js";
import { addWorkingDays, workingDaysElapsed } from "../../src/working-days.js";

describe("working days (Europe/Berlin)", () => {
  it("counts Mon–Fri and keeps the clock time across the weekend and DST", () => {
    const monday = new Date("2026-11-02T09:00:00.000Z"); // Monday 10:00 Berlin (CET)
    expect(addWorkingDays(monday, 2).toISOString()).toBe("2026-11-04T09:00:00.000Z");
    const friday = new Date("2026-11-06T09:00:00.000Z");
    expect(addWorkingDays(friday, 2).toISOString()).toBe("2026-11-10T09:00:00.000Z");
    const saturday = new Date("2026-11-07T09:00:00.000Z");
    expect(addWorkingDays(saturday, 2).toISOString()).toBe("2026-11-10T09:00:00.000Z");
    expect(workingDaysElapsed(friday, new Date("2026-11-09T09:00:00.000Z"), 2)).toBe(false);
    expect(workingDaysElapsed(friday, new Date("2026-11-10T09:00:00.000Z"), 2)).toBe(true);

    // 2026-03-29 is the DST start. Friday 10:00 CET + 2 working days = Tuesday 10:00 CEST.
    const before = new Date("2026-03-27T09:00:00.000Z");
    expect(addWorkingDays(before, 2).toISOString()).toBe("2026-03-31T08:00:00.000Z");
  });
});

describe("limit defaults", () => {
  it("wall clock is 4 h, PR CI waits 20 min, base_red resumes for 48 h", () => {
    expect(RepoConfigSchema.parse({}).limits).toMatchObject({
      max_wall_minutes: 240,
      pr_ci_wait_minutes: 20,
      base_red_resume_hours: 48,
    });
  });
});
