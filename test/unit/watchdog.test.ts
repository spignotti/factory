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

describe("watchdog: frozen process (box/VM paused)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const log = () => new EventLog(mkdtempSync(join(tmpdir(), "wd-")), "r");
  // Wall clock that can jump while timers stand still: what a resumed VM sees.
  const pausable = () => {
    let jump = 0;
    return { now: () => Date.now() + jump, pause: (ms: number) => void (jump += ms) };
  };
  const silent = (events: EventLog, ms: number) => (signal: AbortSignal) =>
    new FakeRunner([{ role: "implement", silent_ms: ms, raw: "ok" }], realSleep).run({
      role: "implement", model: "a/b", cwd: tmpdir(), system: "", prompt: "", tools: "none", env: {}, signal,
      onActivity: (a) => void events.emit({ step: "implement", event: a.kind }),
    });

  it("does not count a 25 min pause as silence (20261029 incident)", async () => {
    const events = log();
    const clock = pausable();
    const frozen: number[] = [];
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 30_000, now: clock.now, onSuspend: (ms) => frozen.push(ms) }, silent(events, 2 * MIN));
    await vi.advanceTimersByTimeAsync(10_000);
    clock.pause(25 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await expect(p).resolves.toMatchObject({ text: "ok" });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toBe(25 * MIN);
  });

  it("still aborts real silence after a pause", async () => {
    const events = log();
    const clock = pausable();
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 30_000, now: clock.now }, silent(events, 60 * MIN));
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    clock.pause(25 * MIN);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(2 * MIN);
    const e = await outcome;
    expect(e).toBeInstanceOf(WatchdogAbort);
    expect((e as WatchdogAbort).silentMs).toBeLessThan(16 * MIN);
  });

  it("ordinary timer jitter is not a pause", async () => {
    const events = log();
    const clock = pausable();
    const frozen: number[] = [];
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 30_000, now: clock.now, onSuspend: (ms) => frozen.push(ms) }, silent(events, 60 * MIN));
    const outcome = p.catch((e: unknown) => e);
    for (let i = 0; i < 40; i++) {
      clock.pause(5_000);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(frozen).toEqual([]);
    expect(await outcome).toBeInstanceOf(WatchdogAbort);
  });
});

describe("supervise: deadline and external abort", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const log = () => new EventLog(mkdtempSync(join(tmpdir(), "wd-")), "r");
  const heartbeating = (events: EventLog) => (signal: AbortSignal) =>
    new FakeRunner([{ role: "implement", heartbeats: { count: 1000, interval_ms: MIN }, raw: "done" }], realSleep).run({
      role: "implement", model: "a/b", cwd: tmpdir(), system: "", prompt: "", tools: "none", env: {}, signal,
      onActivity: (a) => void events.emit({ step: "implement", event: a.kind }),
    });

  it("aborts a heartbeating session at the deadline", async () => {
    const events = log();
    let aborted: unknown;
    const p = supervise(events, { windowMs: 15 * MIN, deadline: { at: Date.now() + 30 * MIN, error: () => new Error("wall") } }, (signal) => {
      signal.addEventListener("abort", () => (aborted = signal.reason));
      return heartbeating(events)(signal);
    });
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(aborted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(((await outcome) as Error).message).toBe("wall");
    expect((aborted as Error).message).toBe("wall");
  });

  it("does not start when the deadline already passed", async () => {
    let started = false;
    const p = supervise(log(), { windowMs: MIN, deadline: { at: Date.now() - 1, error: () => new Error("wall") } }, async () => {
      started = true;
      return 1;
    });
    await expect(p).rejects.toThrow("wall");
    expect(started).toBe(false);
  });

  it("rejects with the external signal's reason and aborts the session", async () => {
    const events = log();
    const ext = new AbortController();
    let aborted = false;
    const p = supervise(events, { windowMs: 15 * MIN, signal: ext.signal }, (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return heartbeating(events)(signal);
    });
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    ext.abort(new Error("interrupted by SIGINT"));
    expect(((await outcome) as Error).message).toBe("interrupted by SIGINT");
    expect(aborted).toBe(true);
  });
});
