import { describe, expect, it } from "vitest";
import { aggregateCheckRuns, type CheckRunView } from "../../src/pipeline/ci-status.js";

const run = (over: Partial<CheckRunView> & Pick<CheckRunView, "name" | "status">): CheckRunView => ({
  conclusion: null,
  started_at: "2026-11-06T00:00:00Z",
  id: 1,
  suite: 1,
  ...over,
});

describe("aggregateCheckRuns", () => {
  it("is none with no runs and green when the full suite succeeded", () => {
    expect(aggregateCheckRuns([])).toBe("none");
    expect(
      aggregateCheckRuns([
        run({ name: "select", status: "completed", conclusion: "success", id: 1 }),
        run({ name: "check (unit)", status: "completed", conclusion: "success", id: 2 }),
        run({ name: "done", status: "completed", conclusion: "success", id: 3 }),
      ]),
    ).toBe("green");
  });

  it("a draft hold is not a pass and does not settle red before the ready suite starts", () => {
    const draft = [
      run({ name: "select", status: "completed", conclusion: "skipped", suite: 1, id: 1 }),
      run({ name: "check", status: "completed", conclusion: "skipped", suite: 1, id: 2 }),
      run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 3, started_at: "2026-11-06T00:00:01Z" }),
    ];
    expect(aggregateCheckRuns(draft)).toBe("pending");
    expect(
      aggregateCheckRuns([
        ...draft,
        run({ name: "select", status: "in_progress", conclusion: null, suite: 2, id: 4, started_at: "2026-11-06T00:00:02Z" }),
      ]),
    ).toBe("pending");
  });

  it("the ready suite's later success replaces the draft failure", () => {
    expect(
      aggregateCheckRuns([
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 1, started_at: "2026-11-06T00:00:01Z" }),
        run({ name: "select", status: "completed", conclusion: "skipped", suite: 1, id: 2 }),
        run({ name: "select", status: "completed", conclusion: "success", suite: 2, id: 3, started_at: "2026-11-06T00:01:00Z" }),
        run({ name: "check (unit)", status: "completed", conclusion: "success", suite: 2, id: 4, started_at: "2026-11-06T00:02:00Z" }),
        run({ name: "done", status: "completed", conclusion: "success", suite: 2, id: 5, started_at: "2026-11-06T00:03:00Z" }),
      ]),
    ).toBe("green");
  });

  it("converting back to draft fails the check after a success, and a skipped done is not green", () => {
    const ready = [
      run({ name: "select", status: "completed", conclusion: "success", suite: 2, id: 3, started_at: "2026-11-06T00:01:00Z" }),
      run({ name: "check (unit)", status: "completed", conclusion: "success", suite: 2, id: 4, started_at: "2026-11-06T00:02:00Z" }),
      run({ name: "done", status: "completed", conclusion: "success", suite: 2, id: 5, started_at: "2026-11-06T00:03:00Z" }),
    ];
    expect(
      aggregateCheckRuns([
        ...ready,
        run({ name: "select", status: "completed", conclusion: "skipped", suite: 3, id: 6, started_at: "2026-11-06T00:04:00Z" }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 3, id: 7, started_at: "2026-11-06T00:04:01Z" }),
      ]),
    ).toBe("red");
    expect(aggregateCheckRuns([run({ name: "done", status: "completed", conclusion: "skipped", id: 1 })])).toBe("red");
  });

  it("a real gate failure is red immediately, including when a newer run of that check succeeded", () => {
    expect(
      aggregateCheckRuns([
        run({ name: "select", status: "completed", conclusion: "success", id: 1 }),
        run({ name: "check (unit)", status: "completed", conclusion: "failure", id: 2 }),
        run({ name: "done", status: "in_progress", conclusion: null, id: 3 }),
      ]),
    ).toBe("red");
    expect(
      aggregateCheckRuns([
        run({ name: "check (unit)", status: "completed", conclusion: "failure", id: 1, started_at: "2026-11-06T00:00:01Z" }),
        run({ name: "check (unit)", status: "completed", conclusion: "success", id: 2, started_at: "2026-11-06T00:05:00Z" }),
        run({ name: "select", status: "completed", conclusion: "success", id: 3 }),
        run({ name: "done", status: "completed", conclusion: "success", id: 4, started_at: "2026-11-06T00:06:00Z" }),
      ]),
    ).toBe("green");
    expect(aggregateCheckRuns([run({ name: "select", status: "completed", conclusion: "cancelled", id: 1 })])).toBe("red");
    expect(aggregateCheckRuns([run({ name: "lint", status: "completed", conclusion: "failure", suite: 9, id: 1 })])).toBe("red");
  });

  it("a done-only failure or cancel is red; the minimal stub's draft marker keeps the hold pending", () => {
    expect(aggregateCheckRuns([run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 1 })])).toBe("red");
    expect(aggregateCheckRuns([run({ name: "done", status: "completed", conclusion: "cancelled", suite: 2, id: 2 })])).toBe("red");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "success", suite: 1, id: 1 }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 2, started_at: "2026-11-06T00:00:01Z" }),
      ]),
    ).toBe("pending");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "success", suite: 1, id: 1 }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 2, started_at: "2026-11-06T00:00:01Z" }),
        run({ name: "draft", status: "completed", conclusion: "skipped", suite: 2, id: 3, started_at: "2026-11-06T00:01:00Z" }),
        run({ name: "done", status: "completed", conclusion: "cancelled", suite: 2, id: 4, started_at: "2026-11-06T00:01:01Z" }),
      ]),
    ).toBe("red");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "success", suite: 1, id: 1 }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 2, started_at: "2026-11-06T00:00:01Z" }),
        run({ name: "draft", status: "completed", conclusion: "skipped", suite: 2, id: 3, started_at: "2026-11-06T00:01:00Z" }),
        run({ name: "done", status: "completed", conclusion: "success", suite: 2, id: 4, started_at: "2026-11-06T00:01:01Z" }),
      ]),
    ).toBe("green");
  });

  it("draft push then markReady is green: the later event wins, not the done job that started last", () => {
    // The draft run waits on a runner for `draft`, so its `done` starts after the ready `done`.
    // Event order is the workflow created_at (suite id when that time is missing). A cancelled
    // draft run must not become latest after the ready run, and must not settle red before that
    // run has reported `done`.
    const draftWaited = [
      run({ name: "draft", status: "completed", conclusion: "success", suite: 10, id: 1, created_at: "2026-11-06T00:00:00Z", started_at: "2026-11-06T00:00:30Z" }),
      run({ name: "done", status: "completed", conclusion: "failure", suite: 10, id: 2, created_at: "2026-11-06T00:00:00Z", started_at: "2026-11-06T00:02:00Z" }),
    ];
    const ready = [
      run({ name: "draft", status: "completed", conclusion: "skipped", suite: 4, id: 3, created_at: "2026-11-06T00:01:00Z", started_at: "2026-11-06T00:01:00Z" }),
      run({ name: "done", status: "completed", conclusion: "success", suite: 4, id: 4, created_at: "2026-11-06T00:01:00Z", started_at: "2026-11-06T00:01:01Z" }),
    ];
    expect(aggregateCheckRuns([...draftWaited, ...ready])).toBe("green");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "cancelled", suite: 1, id: 1, started_at: "2026-11-06T00:03:00Z" }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 2, started_at: "2026-11-06T00:03:01Z" }),
        run({ name: "draft", status: "completed", conclusion: "skipped", suite: 2, id: 3, started_at: "2026-11-06T00:01:00Z" }),
        run({ name: "done", status: "completed", conclusion: "success", suite: 2, id: 4, started_at: "2026-11-06T00:01:01Z" }),
      ]),
    ).toBe("green");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "cancelled", suite: 1, id: 1, created_at: "2026-11-06T00:00:00Z" }),
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 2, created_at: "2026-11-06T00:00:00Z", started_at: "2026-11-06T00:03:00Z" }),
        run({ name: "draft", status: "completed", conclusion: "skipped", suite: 2, id: 3, created_at: "2026-11-06T00:01:00Z", started_at: "2026-11-06T00:01:00Z" }),
      ]),
    ).toBe("pending");
    expect(
      aggregateCheckRuns([
        run({ name: "done", status: "completed", conclusion: "failure", suite: 1, id: 1, created_at: "2026-11-06T00:00:00Z" }),
        run({ name: "lint", status: "completed", conclusion: "success", suite: 9, id: 2, created_at: "2026-11-06T00:05:00Z" }),
      ]),
    ).toBe("red");
  });

  it("a finished foreign workflow with a job named check is not a factory run", () => {
    const foreign = [
      run({ name: "check", status: "completed", conclusion: "success", workflow: "ci", suite: 9, id: 1, created_at: "2026-11-06T00:05:00Z" }),
      run({ name: "done", status: "completed", conclusion: "success", workflow: "ci", suite: 9, id: 2, created_at: "2026-11-06T00:04:00Z" }),
    ];
    expect(aggregateCheckRuns(foreign)).toBe("green");
    expect(
      aggregateCheckRuns([
        run({ name: "select", status: "completed", conclusion: "success", workflow: "factory", suite: 1, id: 3, created_at: "2026-11-06T00:00:00Z" }),
        run({ name: "done", status: "completed", conclusion: "success", workflow: "factory", suite: 1, id: 4, created_at: "2026-11-06T00:00:00Z" }),
        ...foreign,
      ]),
    ).toBe("green");
    // A later foreign `check` must not hide a settled factory failure, and a factory-named suite still holds.
    expect(
      aggregateCheckRuns([
        run({ name: "done", status: "completed", conclusion: "failure", workflow: "factory", suite: 1, id: 4, created_at: "2026-11-06T00:00:00Z" }),
        run({ name: "check", status: "completed", conclusion: "success", workflow: "ci", suite: 9, id: 5, created_at: "2026-11-06T00:05:00Z" }),
      ]),
    ).toBe("red");
    expect(
      aggregateCheckRuns([
        run({ name: "draft", status: "completed", conclusion: "success", workflow: "factory", suite: 1, id: 1 }),
        run({ name: "done", status: "completed", conclusion: "failure", workflow: "factory", suite: 1, id: 2 }),
      ]),
    ).toBe("pending");
  });
});
