/**
 * Issue #177: a `provider_window_wait` stop parks the queue entry WITHOUT a coding slot until the
 * provider usage window resets (bounded periodic recheck for far windows), on a bounded wait budget.
 * It must not consume `requeues`, must not reset spent budgets, and must fail closed (plain park)
 * when the reset metadata is missing, past or contradicted.
 */
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import type { QueueEntry, QueueFile } from "../../src/queue/store.js";
import { applyOutcome, MAX_WINDOW_WAITS, MAX_WINDOW_WAIT_MS } from "../../src/queue/worker.js";

const NOW = Date.parse("2026-01-15T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function entry(issue: number, extra: Partial<QueueEntry> = {}): QueueEntry {
  return { issue, status: "running", added_at: "2026-01-15T09:00:00Z", run_id: "20260115-090000-aaaaaa", issue_rev: "rev1", ...extra } as QueueEntry;
}

function windowResult(resetsAt: number | undefined, extra: Partial<RunResult> = {}): RunResult {
  return {
    run_id: "20260115-090000-aaaaaa",
    repo: "/r",
    task: "#1",
    type: "feature",
    lane: "standard",
    result: "needs_human",
    risk: null,
    merge_policy: null,
    pr: null,
    rounds: 0,
    minutes: 0,
    cost_usd: 0,
    reason: "every usable model is at its usage limit until the window resets; factory resume 20260115-090000-aaaaaa",
    branch: "factory/1-x",
    worktree: "/r/wt",
    run_dir: "/home/runs/20260115-090000-aaaaaa",
    stop: { cause: "provider_window_wait", action: "wait" },
    ...(resetsAt !== undefined ? { window_resets_at: resetsAt } : {}),
    ...extra,
  } as RunResult;
}

function apply(e: QueueEntry, result: RunResult, opts?: Parameters<typeof applyOutcome>[3]): ReturnType<typeof applyOutcome> {
  const q: QueueFile = { version: 1, repo: "/r", repo_key: "k", entries: [e] };
  return applyOutcome(q, e, { ...result, ...{ run_id: result.run_id } }, { now: NOW, ...opts });
}

describe("window wait parks without a slot (#177)", () => {
  it("parks with wait_until at the reset window, keeping run, checkpoint and PR, and never touches requeues", () => {
    const e = entry(1, { pr: "https://github.test/pr/9" });
    expect(apply(e, windowResult(NOW + 30 * MIN))).toBe("parked");
    expect(e.status).toBe("parked");
    expect(e.wait_until).toBe(NOW + 30 * MIN);
    expect(e.window_resets_at).toBe(NOW + 30 * MIN);
    expect(e.window_waits).toBe(1);
    // The original checkpoint and PR are kept; no implementation is duplicated later.
    expect(e.run_id).toBe("20260115-090000-aaaaaa");
    expect(e.issue_rev).toBe("rev1");
    expect(e.pr).toBe("https://github.test/pr/9");
    // A window wait is not a transient requeue: the requeue budget stays untouched.
    expect(e.requeues).toBeUndefined();
    expect(e.blocked_by).toBeUndefined();
    expect(e.blocked_runs).toBeUndefined();
    expect(e.pid).toBeUndefined();
  });

  it("a far window is capped to a bounded periodic recheck but keeps the real reset time", () => {
    const e = entry(1);
    apply(e, windowResult(NOW + 7 * 24 * HOUR));
    expect(e.wait_until).toBe(NOW + MAX_WINDOW_WAIT_MS);
    expect(e.window_resets_at).toBe(NOW + 7 * 24 * HOUR);
  });

  it("without reset metadata the stop fails closed to a plain park: no wait is scheduled", () => {
    const e = entry(1);
    expect(apply(e, windowResult(undefined))).toBe("parked");
    expect(e.status).toBe("parked");
    expect(e.wait_until).toBeUndefined();
    expect(e.window_resets_at).toBeUndefined();
  });

  it("a reset time already in the past does not resume inside applyOutcome, but stays due for the next revalidation", () => {
    const e = entry(1, { pr: "https://github.test/pr/9", requeues: 2 });
    expect(apply(e, windowResult(NOW - MIN))).toBe("parked");
    expect(e.status).toBe("parked");
    // The window has opened. The next tick revalidates; this function must not start a run itself.
    expect(e.wait_until).toBe(NOW);
    expect(e.window_resets_at).toBe(NOW - MIN);
    expect(e.run_id).toBe("20260115-090000-aaaaaa");
    expect(e.pr).toBe("https://github.test/pr/9");
    expect(e.requeues).toBe(2);
  });

  it("a state stop contradicting the window stop fails closed", () => {
    const e = entry(1);
    apply(e, windowResult(NOW + HOUR), { stateStop: { cause: "human_approval", action: "approve" } });
    expect(e.status).toBe("parked");
    expect(e.wait_until).toBeUndefined();
  });

  it("the wait budget is bounded: after MAX_WINDOW_WAITS window stops the entry parks permanently", () => {
    for (let i = 1; i <= MAX_WINDOW_WAITS; i++) {
      const e = entry(1, { window_waits: i - 1 });
      expect(apply(e, windowResult(NOW + HOUR)), `wait ${i}`).toBe("parked");
      expect(e.wait_until, `wait ${i}`).toBe(NOW + HOUR);
    }
    const spent = entry(1, { window_waits: MAX_WINDOW_WAITS });
    expect(apply(spent, windowResult(NOW + HOUR))).toBe("parked");
    expect(spent.status).toBe("parked");
    // Permanent stop: no wake-up, and the count records why.
    expect(spent.wait_until).toBeUndefined();
    expect(spent.window_resets_at).toBeUndefined();
    expect(spent.reason).toContain(`${MAX_WINDOW_WAITS}`);
  });

  it("spent code-repair budgets survive the window wait untouched", () => {
    const e = entry(1, { requeues: 2, window_waits: 1 });
    apply(e, windowResult(NOW + HOUR));
    expect(e.requeues).toBe(2);
    expect(e.window_waits).toBe(2);
    expect(e.wait_until).toBe(NOW + HOUR);
  });

  it("other stop causes are unaffected by the window fields", () => {
    const e = entry(1);
    const q: QueueFile = { version: 1, repo: "/r", repo_key: "k", entries: [e] };
    const retry = windowResult(NOW + HOUR, { stop: { cause: "transient_retry", action: "retry" } });
    expect(applyOutcome(q, e, retry, { now: NOW })).toBe("requeue");
    expect(e.status).toBe("pending");
    expect(e.wait_until).toBeUndefined();
  });
});
