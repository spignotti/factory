import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { NotifyPayload } from "./notify.js";

export const OUTBOX_DIR = "outbox";

export const NOTIFY_SIGTERM_GRACE_MS = 45_000;

const OutboxEntrySchema = z
  .object({
    event_id: z.string().min(8).max(64),
    enqueued_at: z.string(),
    repo: z.string(),
    payload: z
      .object({
        event: z.enum(["factory.run_finished", "factory.notify_test"]),
        event_id: z.string(),
        run_id: z.string().nullable(),
        repo: z.string(),
        result: z.string(),
        reason: z.string(),
        pr: z.string().nullable(),
        finished_at: z.string(),
      })
      .strict(),
    kind: z.enum(["failed", "skipped", "error"]),
    detail: z.string().max(500).optional(),
  })
  .strict();
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

export function outboxPath(factoryHome: string): string {
  return join(factoryHome, OUTBOX_DIR);
}

/** Stable idempotency key for a notification (same run finish → same id). */
export function notifyEventId(repo: string, event: NotifyPayload["event"], runId: string | null, finishedAt: string): string {
  return createHash("sha256").update(`${repo}\0${event}\0${runId ?? ""}\0${finishedAt}`).digest("hex").slice(0, 24);
}

export function withEventId(payload: Omit<NotifyPayload, "event_id">, repo: string): NotifyPayload {
  return { ...payload, event_id: notifyEventId(repo, payload.event, payload.run_id, payload.finished_at) };
}

/** Writes one outbox file (0600). Payload never contains URL or key. */
export function enqueueOutbox(factoryHome: string, entry: OutboxEntry): void {
  const dir = outboxPath(factoryHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${entry.event_id}.json`);
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function listOutboxEntries(factoryHome: string): OutboxEntry[] {
  const dir = outboxPath(factoryHome);
  if (!existsSync(dir)) return [];
  const out: OutboxEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = OutboxEntrySchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      out.push(parsed);
    } catch {
      // corrupt entry: leave on disk for a human; flush skips it
    }
  }
  return out;
}

export function outboxCount(factoryHome: string): number {
  const dir = outboxPath(factoryHome);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.endsWith(".json")).length;
}

function removeOutboxFile(factoryHome: string, eventId: string): void {
  rmSync(join(outboxPath(factoryHome), `${eventId}.json`), { force: true });
}

export { removeOutboxFile };

/**
 * SIGTERM/SIGINT aborts the run immediately; notification retries use a separate signal that aborts
 * only after a grace period so a shutdown still delivers the webhook when possible.
 */
export function notifyAbortSignal(runSignal?: AbortSignal, graceMs = NOTIFY_SIGTERM_GRACE_MS): AbortSignal {
  const ctl = new AbortController();
  const arm = () => {
    const t = setTimeout(() => ctl.abort(), graceMs);
    t.unref?.();
  };
  if (runSignal?.aborted) arm();
  else runSignal?.addEventListener("abort", arm, { once: true });
  return ctl.signal;
}
