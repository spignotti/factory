import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRunner, realSleep } from "../../src/agents/fake-runner.js";
import { EventLog } from "../../src/events.js";
import { fixedDeadline, WallBudget } from "../../src/pipeline/budget.js";
import { type RunContext, WallTimeExceeded } from "../../src/pipeline/context.js";
import { supervise, WatchdogAbort } from "../../src/pipeline/watchdog.js";
import { RepoConfigSchema } from "../../src/schemas/repo.js";
import { runGates } from "../../src/steps/gates.js";
import { gitIn } from "../helpers/repo.js";

const MIN = 60_000;

// A resumed VM: the wall clock jumps, timers (monotonic) did not run meanwhile.
const suspend = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("WallBudget: max_wall_minutes as active time", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves the deadline by the frozen time and reports it", async () => {
    const frozen: number[] = [];
    const b = new WallBudget(90 * MIN, { onSuspend: (ms) => frozen.push(ms) }).start();
    const at0 = b.at;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    suspend(60 * MIN);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toBeGreaterThanOrEqual(60 * MIN - 5_000);
    expect(b.at - at0).toBe(frozen[0]);
    expect(Math.round(b.activeMs / MIN)).toBe(10);
    expect(b.exceeded()).toBe(false);
    expect(b.describe()).toBe("10 active min; 60 min box suspended, not counted");
    b.stop();
  });

  it("credits a suspend on the first read after resume, before its own tick", async () => {
    const b = new WallBudget(30 * MIN).start();
    await vi.advanceTimersByTimeAsync(MIN);
    suspend(120 * MIN);
    // No timer has run since the jump: a deadline check right now must not see the run as over.
    expect(Date.now() > b.at).toBe(false);
    expect(Math.round(b.suspendedMs / MIN)).toBe(120);
    b.stop();
  });

  it("ordinary timer jitter is not a suspend", async () => {
    const b = new WallBudget(90 * MIN).start();
    for (let i = 0; i < 60; i++) {
      suspend(10_000); // late ticks, under the slack
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(b.suspendedMs).toBe(0);
    b.stop();
  });

  it("waits that are not work (base CI) extend it; it is exceeded after the active limit", async () => {
    const b = new WallBudget(10 * MIN).start();
    b.extend(5 * MIN);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(b.exceeded()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(b.exceeded()).toBe(true);
    b.stop();
  });

  it("does not count gaps while not started (no liveness tick to compare against)", () => {
    const b = new WallBudget(10 * MIN);
    suspend(30 * MIN);
    expect(b.suspendedMs).toBe(0);
  });
});

describe("max_wall_minutes inside an agent call", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const log = () => new EventLog(mkdtempSync(join(tmpdir(), "wb-")), "r");
  const heartbeating = (events: EventLog) => (signal: AbortSignal) =>
    new FakeRunner([{ role: "implement", heartbeats: { count: 100_000, interval_ms: MIN }, raw: "done" }], realSleep).run({
      role: "implement", model: "a/b", cwd: tmpdir(), system: "", prompt: "", tools: "none", env: {}, signal,
      onActivity: (a) => void events.emit({ step: "implement", event: a.kind }),
    });

  it("replay of run 20261030-164929-9ca1f6: 217 min of suspends inside P2 do not end the run, 90 active minutes do", async () => {
    const events = log();
    const budget = new WallBudget(90 * MIN).start();
    let aborted: unknown;
    const p = supervise(events, { windowMs: 15 * MIN, pollMs: 30_000, deadline: { at: () => budget.at, error: () => new Error("wall") } }, (signal) => {
      signal.addEventListener("abort", () => (aborted = signal.reason));
      return heartbeating(events)(signal);
    });
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    for (const pause of [60, 1, 42, 114]) {
      suspend(pause * MIN);
      await vi.advanceTimersByTimeAsync(5 * MIN);
    }
    // 35 active minutes, 217 suspended: before, the next gates got a 1 s timeout and the run stopped.
    expect(aborted).toBeUndefined();
    expect(Math.round(budget.suspendedMs / MIN)).toBe(217);
    await vi.advanceTimersByTimeAsync(54 * MIN);
    expect(aborted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(((await outcome) as Error).message).toBe("wall");
    expect((aborted as Error).message).toBe("wall");
    budget.stop();
  });

  it("a deadline that passes mid-call aborts the session, even while it heartbeats", async () => {
    const events = log();
    const budget = new WallBudget(20 * MIN).start();
    const p = supervise(events, { windowMs: 15 * MIN, deadline: { at: () => budget.at, error: () => new Error("wall") } }, heartbeating(events));
    const outcome = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(19 * MIN);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(MIN + 1000);
    const e = await outcome;
    expect(e).not.toBeInstanceOf(WatchdogAbort);
    expect((e as Error).message).toBe("wall");
    budget.stop();
  });
});

describe("gates at the wall limit", () => {
  it("stop the run instead of running every check with a 1 s timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-gates-"));
    gitIn(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const baseSha = gitIn(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "b\n");
    const home = join(dir, "..", `${dir.split("/").pop()}-home`);
    mkdirSync(home, { recursive: true });
    const repo = RepoConfigSchema.parse({ checks: [{ name: "probe", run: "touch probe-ran", tier: "fast" }], limits: { max_wall_minutes: 90 } });
    const ctx = {
      deps: { parentEnv: {} }, repo, agentHome: home, worktree: dir, baseSha, events: new EventLog(home, "r"),
      plan: { type: "chore", packages: [] }, handoffs: [], gateCount: 0,
      deadline: { ...fixedDeadline(Date.now() - 1), describe: () => "91 active min" },
    } as unknown as RunContext;
    const e = await runGates(ctx, "fast", []).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WallTimeExceeded);
    expect((e as Error).message).toBe("max_wall_minutes (90) exceeded (91 active min)");
    expect(existsSync(join(dir, "probe-ran"))).toBe(false);
  });
});
