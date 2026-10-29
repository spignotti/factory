import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRunner, realSleep } from "../../src/agents/fake-runner.js";
import { EventLog } from "../../src/events.js";
import { supervise, WatchdogAbort } from "../../src/pipeline/watchdog.js";

const MIN = 60_000;

describe("watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const log = () => new EventLog(mkdtempSync(join(tmpdir(), "wd-")), "r");

  function session(events: EventLog, step: ConstructorParameters<typeof FakeRunner>[0][number]) {
    const runner = new FakeRunner([step], realSleep);
    return (signal: AbortSignal) =>
      runner.run({
        role: "implement", model: "a/b", cwd: tmpdir(), system: "", prompt: "", tools: "none", env: {}, signal,
        onActivity: (a) => void events.emit({ step: "implement", event: a.kind }),
      });
  }

  it("keeps a long session alive while heartbeats arrive", async () => {
    const events = log();
    const p = supervise(events, { windowMs: 15 * MIN }, session(events, {
      role: "implement", heartbeats: { count: 12, interval_ms: 5 * MIN }, raw: "done",
    }));
    await vi.advanceTimersByTimeAsync(61 * MIN);
    await expect(p).resolves.toMatchObject({ text: "done" });
  });

  it("kills a session that is silent beyond the window", async () => {
    const events = log();
    let aborted = false;
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 1000 }, (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return session(events, { role: "implement", silent_ms: 60 * MIN, raw: "late" })(signal);
    });
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(await outcome).toBeInstanceOf(WatchdogAbort);
    expect(aborted).toBe(true);
  });

  it("counts silence from the last event, not from the start", async () => {
    const events = log();
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 1000 }, session(events, {
      role: "implement", heartbeats: { count: 2, interval_ms: 10 * MIN }, silent_ms: 20 * MIN, raw: "x",
    }));
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(34 * MIN);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(await outcome).toBeInstanceOf(WatchdogAbort);
  });
});
