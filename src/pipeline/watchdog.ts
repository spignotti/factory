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
}

/**
 * Runs `fn` and aborts it only when no event at all (heartbeat and progress included) arrived for
 * `windowMs`. Long but active sessions survive.
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
    const timer = setInterval(() => {
      const silent = now() - last;
      if (silent > opts.windowMs) {
        clearInterval(timer);
        const err = new WatchdogAbort(silent);
        controller.abort(err);
        reject(err);
      }
    }, pollMs);
    fn(controller.signal)
      .then(resolve, reject)
      .finally(() => {
        clearInterval(timer);
        off();
      });
  });
}
