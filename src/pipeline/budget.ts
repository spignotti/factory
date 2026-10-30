import type { Clock } from "../events.js";
import { suspendSlackMs } from "./watchdog.js";

/** A run's outer time limit: epoch ms on the real clock; it may move later while the run lives. */
export interface Deadline {
  readonly at: number;
  /** Why the limit was reached, for the needs_human reason (active vs. suspended time). */
  describe?(): string;
}

export interface WallBudgetOptions {
  /** Real clock (default `Date.now`); tests inject one that jumps like a resumed VM. */
  now?: Clock;
  /** Liveness tick (default 5 s). A tick later than `pollMs + suspendSlackMs(pollMs)` is a frozen process. */
  pollMs?: number;
  /** Called with the frozen time when the process was paused (box/VM suspended, laptop asleep). */
  onSuspend?: (frozenMs: number) => void;
}

const MIN = 60_000;

/**
 * `max_wall_minutes` as active time: the deadline is `start + limit`, moved later by the time the
 * whole process was frozen and by waits that are not work (base CI). Same rule as the watchdog
 * (a paused box is not agent silence): a suspended box is not run time either.
 *
 * Before this, the limit was checked between steps on the real clock (suspend counted) but inside
 * an agent call by a `setTimeout` (monotonic clock, suspend not counted). Run 20261030-164929-9ca1f6
 * (tourenpilot-ops #82): 217 of its 258 minutes were box suspends inside one implement call, so the
 * in-call timer never fired, the next gates got a 1 s command timeout (spurious red shellcheck and
 * tests) and the run then stopped "max_wall_minutes (90) exceeded" after about 40 active minutes.
 */
export class WallBudget implements Deadline {
  private readonly now: Clock;
  private readonly pollMs: number;
  private readonly slackMs: number;
  private readonly startedAt: number;
  private lastTick: number;
  private frozenMs = 0;
  private extraMs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly limitMs: number,
    private readonly opts: WallBudgetOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 5000;
    this.slackMs = suspendSlackMs(this.pollMs);
    this.startedAt = this.now();
    this.lastTick = this.startedAt;
  }

  /** Starts the liveness tick (unref'd: it never keeps the process alive). */
  start(): this {
    if (!this.timer) {
      this.lastTick = this.now();
      this.timer = setInterval(() => this.sample(), this.pollMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Credits a frozen gap since the last observation. Also called on every read, so a check right
   * after a resume (before the next tick) already sees the moved deadline.
   */
  private sample(): void {
    const t = this.now();
    const gap = t - this.lastTick;
    this.lastTick = t;
    if (this.timer && gap > this.pollMs + this.slackMs) {
      const frozen = gap - this.pollMs;
      this.frozenMs += frozen;
      this.opts.onSuspend?.(frozen);
    }
  }

  get at(): number {
    this.sample();
    return this.startedAt + this.limitMs + this.extraMs + this.frozenMs;
  }

  /** Time that is not work (base CI wait): moves the deadline later. */
  extend(ms: number): void {
    if (ms > 0) this.extraMs += ms;
  }

  get suspendedMs(): number {
    this.sample();
    return this.frozenMs;
  }

  /** Run time that counts against the limit. */
  get activeMs(): number {
    this.sample();
    return this.now() - this.startedAt - this.extraMs - this.frozenMs;
  }

  exceeded(): boolean {
    return this.now() > this.at;
  }

  describe(): string {
    const active = Math.round(this.activeMs / MIN);
    const frozen = Math.round(this.suspendedMs / MIN);
    return `${active} active min${frozen > 0 ? `; ${frozen} min box suspended, not counted` : ""}`;
  }
}

/** A fixed deadline (one-shot agent calls, tests). */
export function fixedDeadline(at: number): Deadline {
  return { at };
}
