import type { Clock, FactoryEvent } from "../events.js";

export class WatchdogAbort extends Error {
  constructor(readonly silentMs: number) {
    super(`watchdog: no event for ${Math.round(silentMs / 1000)}s`);
    this.name = "WatchdogAbort";
  }
}

export interface EventSource {
  onEvent(listener: (e: FactoryEvent) => void): () => void;
}

export interface WatchdogOptions {
  windowMs: number;
  pollMs?: number;
  now?: Clock;
  /**
   * Hard limit (epoch ms, real clock): abort with `error()` when reached, events or not. A function
   * is re-read when its timer fires and on every poll tick, so a deadline that moves later
   * (WallBudget crediting a box suspend) is honoured.
   */
  deadline?: { at: number | (() => number); error: () => Error };
  /** External abort (signal handler); rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Called when the process was frozen (box/VM paused, laptop asleep): a poll tick arrived far
   * later than scheduled. The frozen time is not counted as silence.
   */
  onSuspend?: (frozenMs: number) => void;
}

/** Extra lateness of a poll tick, beyond `pollMs`, that counts as a frozen process. */
export function suspendSlackMs(pollMs: number): number {
  return Math.max(pollMs, 30_000);
}

/**
 * Runs `fn` and aborts it when no event at all (heartbeat and progress included) arrived for
 * `windowMs`. Long but active sessions survive the watchdog, but not the `deadline` or an external
 * `signal`.
 *
 * Silence is wall-clock time, so a paused box would look like a silent agent once it resumes
 * (the 20261029 incident: VM paused 25 min mid `npm run typecheck`, watchdog fired 4 s after
 * resume). A poll tick that arrives much later than `pollMs` means the whole process was frozen;
 * that gap is credited back instead of being counted as agent silence.
 */
export function supervise<T>(source: EventSource, opts: WatchdogOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? Math.max(1000, Math.min(30_000, opts.windowMs / 10));
  let last = now();
  let lastTick = last;
  const slack = suspendSlackMs(pollMs);
  const off = source.onEvent(() => {
    last = now();
  });
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timers: NodeJS.Timeout[] = [];
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      for (const t of timers) clearTimeout(t);
      off();
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      cleanup();
      controller.abort(err);
      reject(err);
    };
    if (opts.signal?.aborted) return fail(asError(opts.signal.reason));
    const deadlineAt = () => (opts.deadline ? (typeof opts.deadline.at === "function" ? opts.deadline.at() : opts.deadline.at) : Infinity);
    if (opts.deadline && deadlineAt() <= Date.now()) return fail(opts.deadline.error());
    timers.push(
      setInterval(() => {
        const t = now();
        const gap = t - lastTick;
        lastTick = t;
        if (gap > pollMs + slack) {
          const frozen = gap - pollMs;
          last = Math.min(t, last + frozen);
          opts.onSuspend?.(frozen);
        }
        // Real clock, read after the suspend credit (a moving deadline has already moved).
        if (opts.deadline && Date.now() > deadlineAt()) return fail(opts.deadline.error());
        const silent = t - last;
        if (silent > opts.windowMs) fail(new WatchdogAbort(silent));
      }, pollMs),
    );
    if (opts.deadline) {
      // Precise timer too; on firing it re-reads the deadline and re-arms when it moved later.
      const { error } = opts.deadline;
      const arm = (): void => {
        const ms = deadlineAt() - Date.now();
        if (ms <= 0) return fail(error());
        timers.push(setTimeout(arm, Math.min(ms, 2 ** 31 - 1)));
      };
      arm();
    }
    if (opts.signal) {
      const signal = opts.signal;
      onAbort = () => fail(asError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
    }
    fn(controller.signal).then(resolve, reject).finally(cleanup);
  });
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? "aborted"));
}
