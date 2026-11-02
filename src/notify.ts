import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { realSleep, type Sleep } from "./agents/fake-runner.js";
import { type EventLog, redact, type RunResult } from "./events.js";
import { originUrl } from "./git.js";
import { canonicalRepoId } from "./memory.js";
import { listRuns, readEvents } from "./runs.js";
import { expandHome, looseMode } from "./secrets.js";
import { enqueueOutbox, listOutboxEntries, notifyAbortSignal, outboxCount, outboxPath, removeOutboxFile, withEventId, type OutboxEntry } from "./notify-outbox.js";

/**
 * Run-end notification: one POST per finished run to the webhook of the bot that owns the repo
 * (`$FACTORY_HOME/notify.yaml`, repo `owner/name` → webhook). It is the only way a bot learns that a run
 * ended. URL and key are secrets: they never reach events, logs, status, PR bodies, doctor output or agents
 * (the file lives in `$FACTORY_HOME`, which agent sandboxes do not see). A failed notification is logged as
 * a `notify` event and never changes the run's result.
 */

export const NOTIFY_FILE = "notify.yaml";
export const notifyPath = (factoryHome: string) => join(factoryHome, NOTIFY_FILE);

const REPO_KEY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEADER = /^[A-Za-z0-9-]+$/;

export const NotifyHookSchema = z
  .object({
    /** Webhook URL (https). Secret: never printed. */
    url: z.string().refine((u) => /^https:\/\/[^\s]+$/.test(u), "url must be an https URL"),
    /** The sender key inline (the file is 0600) … */
    key: z.string().min(1).optional(),
    /** … or a file holding only the key (0600, outside every repo). */
    key_file: z.string().min(1).optional(),
    /** Header that carries the key; Grok Bot routines: `Authorization` with scheme `Bearer`. */
    header: z.string().regex(HEADER, "header must be a plain header name").default("Authorization"),
    /** Prefix before the key in the header value; "" sends the bare key. */
    scheme: z.string().regex(/^[A-Za-z0-9-]*$/, "scheme must be a single word or empty").default("Bearer"),
  })
  .strict()
  .refine((h) => (h.key === undefined) !== (h.key_file === undefined), "set exactly one of key or key_file");
export type NotifyHook = z.infer<typeof NotifyHookSchema>;

export const NotifyConfigSchema = z
  .object({
    repos: z.record(z.string().regex(REPO_KEY, "repo keys are owner/name"), NotifyHookSchema).default({}),
    /** Attempts per notification (network errors, 408, 429, 5xx are retried with backoff). */
    attempts: z.number().int().min(1).max(10).default(4),
    timeout_s: z.number().positive().max(120).default(10),
  })
  .strict();
export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;

export class NotifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyConfigError";
  }
}

/** Zod issues as `path: message` only (zod can echo input values; these may be secrets). */
function issues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Reads notify.yaml: undefined when there is none. Throws NotifyConfigError (never with a URL or key in the
 * message) when it is readable by group or others, unparsable or invalid.
 */
export function loadNotifyConfig(factoryHome: string): NotifyConfig | undefined {
  const file = notifyPath(factoryHome);
  if (!existsSync(file)) return undefined;
  if (looseMode(file)) throw new NotifyConfigError(`${file} is readable by group or others; run chmod 600 ${file}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    // YAML errors quote the offending line, which may hold the key: report the position only.
    const pos = (e as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    throw new NotifyConfigError(`${file} is not valid YAML${pos ? ` (line ${pos.line}, column ${pos.col})` : ""}`);
  }
  const parsed = NotifyConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new NotifyConfigError(`${file}: ${issues(parsed.error)}`);
  return parsed.data;
}

/** The sender key of a hook (inline or from its 0600 key file). Errors name the file, never the value. */
export function hookKey(hook: NotifyHook): string {
  if (hook.key !== undefined) return hook.key;
  const file = resolve(expandHome(hook.key_file!));
  if (!existsSync(file)) throw new NotifyConfigError(`key_file ${file} does not exist`);
  if (looseMode(file)) throw new NotifyConfigError(`key_file ${file} is readable by group or others; run chmod 600 ${file}`);
  const key = readFileSync(file, "utf8").trim();
  if (!key) throw new NotifyConfigError(`key_file ${file} is empty`);
  return key;
}

/** `github.com/owner/name` → `owner/name`; undefined for local paths. */
export function ownerRepoOf(repoId: string): string | undefined {
  const [host, ...rest] = repoId.split("/");
  if (!host || !host.includes(".") || rest.length !== 2) return undefined;
  const key = rest.join("/");
  return REPO_KEY.test(key) ? key : undefined;
}

export async function ownerRepoOfDir(repoDir: string): Promise<string | undefined> {
  try {
    return ownerRepoOf(canonicalRepoId(await originUrl(repoDir), repoDir));
  } catch {
    return undefined;
  }
}

/** The JSON body a bot's webhook routine receives. Untrusted for the bot: it reads result.json itself. */
export interface NotifyPayload {
  event: "factory.run_finished" | "factory.notify_test";
  /** Stable idempotency key (same run finish → same value). */
  event_id: string;
  run_id: string | null;
  repo: string;
  result: string;
  reason: string;
  pr: string | null;
  finished_at: string;
}

export interface NotifyOutcome {
  status: "sent" | "failed";
  attempts: number;
  http_status: number | null;
  /** Redacted, short. */
  error?: string;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export interface SendOptions {
  fetch?: Fetch;
  sleep?: Sleep;
  attempts?: number;
  timeoutMs?: number;
  /** Delay before attempt n+1 (ms); the last entry repeats. */
  backoffMs?: number[];
  /** Aborted (SIGINT/SIGTERM): no further attempts. */
  signal?: AbortSignal;
}

export const DEFAULT_BACKOFF_MS = [2_000, 10_000, 30_000];
const RETRY_STATUS = new Set([408, 425, 429]);

/** POSTs the payload with retries. Never throws; nothing it returns contains the URL or the key. */
export async function sendNotification(hook: NotifyHook, key: string, payload: NotifyPayload, opts: SendOptions = {}): Promise<NotifyOutcome> {
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? realSleep;
  const attempts = opts.attempts ?? 4;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const secrets = [hook.url, key];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "factory-notify",
    [hook.header]: hook.scheme ? `${hook.scheme} ${key}` : key,
  };
  const body = JSON.stringify(payload);
  let last: NotifyOutcome = { status: "failed", attempts: 0, http_status: null };
  for (let n = 1; n <= attempts; n++) {
    if (n > 1) {
      if (opts.signal?.aborted) break;
      try {
        await sleep(backoff[Math.min(n - 2, backoff.length - 1)] ?? 0, opts.signal);
      } catch {
        break;
      }
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), opts.timeoutMs ?? 10_000);
    try {
      const res = await doFetch(hook.url, { method: "POST", headers, body, signal: ctl.signal });
      if (res.status >= 200 && res.status < 300) return { status: "sent", attempts: n, http_status: res.status };
      last = { status: "failed", attempts: n, http_status: res.status, error: `HTTP ${res.status}` };
      // Wrong key or URL (401/403/404 …): retrying does not help.
      if (res.status < 500 && !RETRY_STATUS.has(res.status)) break;
    } catch (e) {
      const err = e as Error & { cause?: { message?: string; code?: string } };
      const msg = [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(": ");
      last = { status: "failed", attempts: n, http_status: null, error: redact(msg, secrets).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
    if (opts.signal?.aborted) break;
  }
  return last;
}

export interface NotifyDeps {
  factoryHome: string;
  fetch?: Fetch;
  sleep?: Sleep;
  backoffMs?: number[];
  signal?: AbortSignal;
}

/** Payload of a finished run. */
export function runPayload(result: RunResult, repo: string, finishedAt: Date): NotifyPayload {
  const finished_at = finishedAt.toISOString();
  return withEventId(
    {
      event: "factory.run_finished",
      run_id: result.run_id,
      repo,
      result: result.result,
      reason: result.reason.slice(0, 500),
      pr: result.pr,
      finished_at,
    },
    repo,
  );
}

function outboxEnqueue(factoryHome: string, entry: Omit<OutboxEntry, "enqueued_at">): void {
  try {
    enqueueOutbox(factoryHome, { ...entry, enqueued_at: new Date().toISOString() });
  } catch {
    // outbox must not fail the run
  }
}

/**
 * Notifies the repo's bot that a run finished. Never throws and never changes the result; logs one
 * `notify` event (no URL, no key) when a notify.yaml exists.
 */
export async function notifyRunFinished(result: RunResult, deps: NotifyDeps, events?: EventLog, finishedAt = new Date()): Promise<NotifyOutcome | undefined> {
  const log = (data: Record<string, unknown>) => {
    try {
      events?.emit({ step: "run", event: "notify", data });
    } catch {
      // logging must not fail the run either
    }
  };
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(deps.factoryHome);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    log({ status: "error", error: msg });
    const repo = await ownerRepoOfDir(result.repo);
    if (repo) {
      const payload = runPayload(result, repo, finishedAt);
      outboxEnqueue(deps.factoryHome, { event_id: payload.event_id, repo, payload, kind: "error", detail: msg });
    }
    return undefined;
  }
  if (!cfg) return undefined;
  const repo = await ownerRepoOfDir(result.repo);
  const hook = repo ? cfg.repos[repo] : undefined;
  const payload = repo ? runPayload(result, repo, finishedAt) : undefined;
  if (!repo || !hook) {
    log({ status: "skipped", repo: repo ?? null, reason: "no hook for this repo in notify.yaml" });
    if (payload) {
      outboxEnqueue(deps.factoryHome, {
        event_id: payload.event_id,
        repo: payload.repo,
        payload,
        kind: "skipped",
        detail: "no hook for this repo in notify.yaml",
      });
    }
    return undefined;
  }
  let key: string;
  try {
    key = hookKey(hook);
  } catch (e) {
    log({ status: "error", repo, error: (e as Error).message.slice(0, 300) });
    if (payload) {
      outboxEnqueue(deps.factoryHome, {
        event_id: payload.event_id,
        repo: payload.repo,
        payload,
        kind: "error",
        detail: (e as Error).message.slice(0, 300),
      });
    }
    return undefined;
  }
  events?.addSecrets([hook.url, key]);
  const body = payload!;
  const out = await sendNotification(hook, key, body, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    attempts: cfg.attempts,
    timeoutMs: cfg.timeout_s * 1000,
    backoffMs: deps.backoffMs,
    signal: notifyAbortSignal(deps.signal),
  });
  log({ repo, result: result.result, event_id: body.event_id, ...out });
  if (out.status === "failed") {
    outboxEnqueue(deps.factoryHome, {
      event_id: body.event_id,
      repo: body.repo,
      payload: body,
      kind: "failed",
      detail: out.error ?? (out.http_status !== null ? `HTTP ${out.http_status}` : "delivery failed"),
    });
  }
  return out;
}

/** `factory notify test <owner/name>`: one test ping, so the bot's routine can be checked end to end. */
export async function notifyTest(repo: string, deps: NotifyDeps, now = new Date()): Promise<{ ok: boolean; message: string }> {
  if (!REPO_KEY.test(repo)) return { ok: false, message: `repo must be owner/name, got ${repo}` };
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(deps.factoryHome);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!cfg) return { ok: false, message: `no ${notifyPath(deps.factoryHome)} (see docs/BOTS.md)` };
  const hook = cfg.repos[repo];
  if (!hook) return { ok: false, message: `no hook for ${repo} in ${notifyPath(deps.factoryHome)}` };
  let key: string;
  try {
    key = hookKey(hook);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const finished_at = now.toISOString();
  const payload = withEventId({ event: "factory.notify_test", run_id: null, repo, result: "test", reason: "factory notify test", pr: null, finished_at }, repo);
  const out = await sendNotification(hook, key, payload, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    attempts: cfg.attempts,
    timeoutMs: cfg.timeout_s * 1000,
    backoffMs: deps.backoffMs,
    signal: notifyAbortSignal(deps.signal),
  });
  const tries = `${out.attempts} attempt${out.attempts === 1 ? "" : "s"}`;
  return out.status === "sent"
    ? { ok: true, message: `test ping for ${repo} sent (HTTP ${out.http_status}, ${tries})` }
    : { ok: false, message: `test ping for ${repo} failed after ${tries}: ${out.error ?? "unknown error"}` };
}

export interface NotifyCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

/** `doctor`: notify.yaml permissions and validity, which repos have a hook (never URLs or keys). */
export async function notifyChecks(factoryHome: string, repoDir?: string): Promise<NotifyCheck[]> {
  const name = "notify";
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(factoryHome);
  } catch (e) {
    return [{ name, status: "fail", detail: (e as Error).message }];
  }
  if (!cfg) return [{ name, status: "info", detail: `no ${notifyPath(factoryHome)}: no bot is woken when a run ends (docs/BOTS.md)` }];
  const checks: NotifyCheck[] = [];
  const repos = Object.keys(cfg.repos).sort();
  const broken: string[] = [];
  for (const r of repos) {
    try {
      hookKey(cfg.repos[r]!);
    } catch (e) {
      broken.push(`${r}: ${(e as Error).message}`);
    }
  }
  checks.push(
    broken.length
      ? { name, status: "fail", detail: `hook key not usable for ${broken.join("; ")}` }
      : { name, status: repos.length ? "ok" : "warn", detail: repos.length ? `notify.yaml 0600; hooks for ${repos.join(", ")}` : "notify.yaml has no repos" },
  );
  if (repoDir) {
    const repo = await ownerRepoOfDir(repoDir);
    if (repo && !cfg.repos[repo]) checks.push({ name: "notify repo", status: "warn", detail: `no hook for ${repo}: its bot is not woken when a run ends` });
    else if (repo) checks.push({ name: "notify repo", status: "ok", detail: `hook for ${repo} configured (test it with factory notify test ${repo})` });
  }
  return checks;
}

export interface FlushReport {
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  errors: string[];
}

/** Sends every deliverable outbox entry; leaves entries that still fail or have no hook. */
export async function flushNotifyOutbox(factoryHome: string, deps: NotifyDeps = { factoryHome }): Promise<FlushReport> {
  const report: FlushReport = { sent: 0, failed: 0, skipped: 0, remaining: 0, errors: [] };
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(factoryHome);
  } catch (e) {
    report.errors.push((e as Error).message.slice(0, 300));
    report.remaining = outboxCount(factoryHome);
    return report;
  }
  if (!cfg) {
    report.remaining = outboxCount(factoryHome);
    return report;
  }
  const signal = notifyAbortSignal(deps.signal);
  for (const entry of listOutboxEntries(factoryHome)) {
    const hook = cfg.repos[entry.repo];
    if (!hook) {
      report.skipped++;
      continue;
    }
    let key: string;
    try {
      key = hookKey(hook);
    } catch (e) {
      report.errors.push(`${entry.repo}: ${(e as Error).message.slice(0, 200)}`);
      report.skipped++;
      continue;
    }
    const out = await sendNotification(hook, key, entry.payload, {
      fetch: deps.fetch,
      sleep: deps.sleep,
      attempts: cfg.attempts,
      timeoutMs: cfg.timeout_s * 1000,
      backoffMs: deps.backoffMs,
      signal,
    });
    if (out.status === "sent") {
      removeOutboxFile(factoryHome, entry.event_id);
      report.sent++;
    } else report.failed++;
  }
  report.remaining = outboxCount(factoryHome);
  return report;
}

export { outboxCount, outboxPath, listOutboxEntries };

const NOTIFY_DOCTOR_DAYS = 7;
const MS_DAY = 86_400_000;

export async function reposWithRecentRunsMissingHook(factoryHome: string, sinceMs: number, now = Date.now()): Promise<string[]> {
  const cutoff = now - sinceMs;
  const counts = new Map<string, number>();
  for (const run of listRuns(factoryHome)) {
    if (run.started_at.getTime() < cutoff) continue;
    const dir = run.state?.repo ?? run.result?.repo;
    if (dir) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (!counts.size) return [];
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(factoryHome);
  } catch {
    cfg = undefined;
  }
  const missing: string[] = [];
  for (const dir of counts.keys()) {
    const key = await ownerRepoOfDir(dir);
    if (!key) continue;
    if (!cfg?.repos[key]) missing.push(key);
  }
  return missing.sort();
}

/** Extra doctor checks: outbox backlog, recent skipped/failed notify, repos with runs but no hook. */
export async function notifyDoctorChecks(factoryHome: string, now = Date.now()): Promise<NotifyCheck[]> {
  const checks: NotifyCheck[] = [];
  const pending = outboxCount(factoryHome);
  if (pending > 0) {
    checks.push({
      name: "notify outbox",
      status: "fail",
      detail: `${pending} pending notification(s) in ${outboxPath(factoryHome)}; run factory notify flush`,
    });
  }
  const window = NOTIFY_DOCTOR_DAYS * MS_DAY;
  const missing = await reposWithRecentRunsMissingHook(factoryHome, window, now);
  if (missing.length) {
    checks.push({
      name: "notify coverage",
      status: "fail",
      detail: `recent runs but no hook for ${missing.join(", ")} (see docs/BOTS.md)`,
    });
  }
  let skipped = 0;
  let failed = 0;
  const cutoff = now - window;
  for (const run of listRuns(factoryHome)) {
    if (run.started_at.getTime() < cutoff) continue;
    for (const e of readEvents(run)) {
      if (e.event !== "notify") continue;
      if (e.data.status === "skipped") skipped++;
      if (e.data.status === "failed") failed++;
    }
  }
  if (skipped > 0 || failed > 0) {
    checks.push({
      name: "notify delivery",
      status: "fail",
      detail: `last ${NOTIFY_DOCTOR_DAYS} days: ${skipped} skipped, ${failed} failed notification(s) in run events; fix hooks and run factory notify flush`,
    });
  }
  if (!checks.length) checks.push({ name: "notify delivery", status: "ok", detail: `no outbox backlog; hooks cover recent repos (last ${NOTIFY_DOCTOR_DAYS} days)` });
  return checks;
}

/** Whether a GitHub-origin repo has a configured hook (used before factory run). */
export async function requireNotifyHook(factoryHome: string, repoDir: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const repo = await ownerRepoOfDir(repoDir);
  if (!repo) return { ok: true };
  let cfg: NotifyConfig | undefined;
  try {
    cfg = loadNotifyConfig(factoryHome);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!cfg) return { ok: false, message: `no ${notifyPath(factoryHome)}: factory run requires a notify hook (see docs/BOTS.md) or pass --no-notify` };
  if (!cfg.repos[repo]) return { ok: false, message: `no hook for ${repo} in ${notifyPath(factoryHome)}; pass --no-notify to run without waking the bot` };
  try {
    hookKey(cfg.repos[repo]!);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  return { ok: true };
}
