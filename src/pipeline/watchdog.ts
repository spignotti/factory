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
  /** Hard limit (epoch ms, real clock): abort with `error()` when reached, events or not. */
  deadline?: { at: number; error: () => Error };
  /** External abort (signal handler); rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Runs `fn` and aborts it when no event at all (heartbeat and progress included) arrived for
 * `windowMs`. Long but active sessions survive the watchdog, but not the `deadline` or an external
 * `signal`.
 */
export function supervise<T>(source: EventSource, opts: WatchdogOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? Math.max(1000, Math.min(30_000, opts.windowMs / 10));
  let last = now();
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
    if (opts.deadline && opts.deadline.at <= Date.now()) return fail(opts.deadline.error());
    timers.push(
      setInterval(() => {
        const silent = now() - last;
        if (silent > opts.windowMs) fail(new WatchdogAbort(silent));
      }, pollMs),
    );
    if (opts.deadline) {
      const { at, error } = opts.deadline;
      timers.push(setTimeout(() => fail(error()), at - Date.now()));
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
