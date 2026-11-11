import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import type { QueueEntry, QueueFile } from "../../src/queue/store.js";
import { applyOutcome, overlapRunIds } from "../../src/queue/worker.js";

function entry(issue: number): QueueEntry {
  return { issue, status: "running", added_at: "2026-11-11T00:00:00Z" } as QueueEntry;
}

describe("queue outcome on a live-run overlap", () => {
  it("parks on the overlapping run ids, not for the night", () => {
    const reason =
      "planned paths overlap active runs: 20261110-231531-2c9ab6 (src/a.py, tests/test_a.py)";
    expect(overlapRunIds(reason)).toEqual(["20261110-231531-2c9ab6"]);
    const e = entry(284);
    const q = { entries: [e] } as unknown as QueueFile;
    const out = applyOutcome(q, e, { run_id: "20261111-010101-aaaaaa", result: "locked", reason } as unknown as RunResult);
    expect(out).toBe("parked");
    expect(e.blocked_runs).toEqual(["20261110-231531-2c9ab6"]);
    expect(e.blocked_by).toBeUndefined();
  });

  it("ignores reasons that are not a live-run overlap", () => {
    expect(overlapRunIds("planned paths overlap open factory PR #12 (a.py)")).toEqual([]);
    expect(overlapRunIds("plan needs input")).toEqual([]);
  });
});
