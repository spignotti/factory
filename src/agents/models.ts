import type { EventLog } from "../events.js";
import { billingOf, familyOf, type ModelEntry, type Profile, profileRoleOf } from "../schemas/profile.js";
import { realSleep, type Sleep } from "./fake-runner.js";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, type AgentUsage } from "./runner.js";

export type ErrorClass = "capacity" | "network" | "stream" | "limit" | "auth" | "invalid_output" | "other";

/**
 * A dropped, failed or timed-out connection: worth retrying the same model. undici reports a cut stream as
 * `terminated`; the OpenAI-compatible SDK reports a request timeout as `Request timed out.` and a failed
 * connection as `Connection error.` (20261030-125347-5b7ada: a request in flight across a 19 min box freeze).
 * A TLS appendix on that message (`certificate verify failed`, `unable to verify the first certificate`,
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `TLS handshake`) is the same class. The word "certificate" alone is not.
 */
const NETWORK = /^terminated$|^request timed out\.?$|^connection error\b|\bAPIConnectionTimeoutError\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEPIPE\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|socket hang up|fetch failed|other side closed|premature close|\bTLS handshake\b|unable to verify the first certificate|\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b|certificate verify failed/i;

/**
 * The provider closed the token stream before a finish reason (20261104-150805-15d527:
 * `Stream ended without finish_reason` on a multi-million-token implement call). Same idea as a
 * transport drop, but its retry budget is `limits.stream_retries`, not `retry.attempts`.
 */
const STREAM = /stream ended without finish_reason|\bwithout finish_reason\b|\bpremature eof\b|\bunexpected eof\b|connection reset during streaming|\berror while streaming\b|\bwhile processing the stream\b|\b(?:sse |response )?stream closed\b|\bstream(?:ing)? (?:response )?ended\b|\bincomplete chunked (?:read|encoding)\b/i;

/** Bad agent output; never a reason to fall back to another model. */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

/**
 * Quota, usage or billing limit. Not a 429 and not "rate limit": those are capacity (retried).
 * Checked before auth status so a 403 quota error is not "auth".
 */
const LIMIT = /\bquota\b|usage limit|insufficient_quota|spending limit|used all available credits/i;

/** `rate limit … try again in N` — capacity, and the delay is parsed from the same text. */
const RATE_LIMIT_BACKOFF = /rate.?limit[\s\S]{0,160}?try again in\s+\d/i;

/**
 * Milliseconds to wait before a same-model retry.
 * Pi's `formatProviderError` copies status and body into `errorMessage` and drops response headers,
 * so a header-only `Retry-After` is not available. `AgentError.retryAfterMs` is set only when a caller
 * already parsed a delay (tests, fakes). Production reads the text form (`try again in N`, `retry-after: N`).
 */
export function providerRetryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const fromField = err instanceof AgentError ? err.retryAfterMs : undefined;
  if (fromField !== undefined && Number.isFinite(fromField) && fromField > 0) return fromField;
  const message = err instanceof Error ? err.message : String(err);
  return parseRetryAfterText(message, now);
}

function unitMs(n: number, unit: string | undefined): number {
  const u = (unit ?? "s").toLowerCase();
  if (u === "ms" || u.startsWith("milli")) return n;
  if (u === "m" || u.startsWith("min")) return n * 60_000;
  return n * 1000;
}

/** Retry-After as a header line (`retry-after: 30`, `retry-after-ms: 1500`, HTTP-date) or prose. */
export function parseRetryAfterText(message: string, now = Date.now()): number | undefined {
  const msHeader = /retry-after-ms:\s*(\d+(?:\.\d+)?)/i.exec(message);
  if (msHeader) return Number(msHeader[1]);
  const header = /retry-after:\s*([^\n]+)/i.exec(message);
  if (header) {
    const raw = header[1]!.trim();
    const seconds = /^(\d+(?:\.\d+)?)(?:\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes))?$/i.exec(raw);
    if (seconds) return unitMs(Number(seconds[1]), seconds[2]);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      const delta = at - now;
      return delta > 0 ? delta : undefined;
    }
  }
  const prose = /(?:try again in|retry after)\s+(\d+(?:\.\d+)?)\s*(milliseconds|millisecond|ms|seconds|second|secs|sec|s|minutes|minute|mins|min|m)?\b/i.exec(message);
  if (prose) return unitMs(Number(prose[1]), prose[2]);
  return undefined;
}

/**
 * Provider capacity errors are their own class. A 429, "at capacity", or "rate limit … try again in N"
 * is capacity (retried, honoring a delay parsed from the text). Only explicit quota, usage or billing
 * wording is a limit, even when the status is 429.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof InvalidOutputError) return "invalid_output";
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof AgentError ? err.status : undefined;
  const retryAfter = providerRetryAfterMs(err);
  if (LIMIT.test(message)) return "limit";
  if (
    status === 429 ||
    /at capacity|ttft_admission_refused|overloaded/i.test(message) ||
    RATE_LIMIT_BACKOFF.test(message) ||
    (status === 503 && (/retry shortly|try again shortly/i.test(message) || retryAfter !== undefined))
  ) {
    return "capacity";
  }
  if (status === undefined && NETWORK.test(message.trim())) return "network";
  if (STREAM.test(message)) return "stream";
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authenticat|forbidden|not logged in/i.test(message)) {
    return "auth";
  }
  return "other";
}

/** Provider stream abort (`stream`), as opposed to a transport drop (`network`). */
export function isStreamAbort(err: unknown): boolean {
  return classifyError(err) === "stream";
}

export interface CallDeps {
  runner: AgentRunner;
  profile: Profile;
  events: EventLog;
  sleep?: Sleep;
  /**
   * Number of process freezes (box/VM paused) seen so far, from the watchdog. A call that failed with a
   * network or unclassified error while a freeze happened is retried on the same model without using up
   * a retry attempt (at most `SUSPEND_RETRIES` times per call): the provider dropped it because we were gone.
   */
  suspends?: () => number;
  /**
   * Same-model retries for a `stream` abort (`limits.stream_retries`). Default 2. `0` does not retry.
   * Capacity and network keep `profile.retry.attempts`.
   */
  streamRetries?: number;
  /** Emit a `progress` warning when one call's `tokens_in` reaches this (`limits.step_token_warn`). `0`/absent disables. */
  tokenWarn?: number;
  /**
   * Same-model network retries already spent in this run. When set, resume continues from `n`
   * instead of granting `retry.attempts` again. Absent: the per-call budget only (unchanged).
   */
  networkRetries?: { n: number };
  /** Called after `networkRetries.n` advances, so the run can persist it. */
  onNetworkRetry?: (n: number) => void;
}

/** Extra same-model retries per call for attempts that spanned a box freeze. */
export const SUSPEND_RETRIES = 2;

/** Error classes that are the provider's or the network's fault, not the task's: the run stays resumable. */
export const TRANSIENT_CLASSES: readonly ErrorClass[] = ["capacity", "network", "stream"];

/**
 * The model chain gave up on a transient error (capacity, network, stream abort). The run ends `needs_human`
 * (resumable, worktree kept) instead of `failed`.
 */
export class TransientAgentError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    cause: unknown,
    message?: string,
  ) {
    super(message ?? `transient ${errorClass} error after retries: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TransientAgentError";
  }
}

/**
 * The epoch ms when an explicitly resetting provider usage window opens (#177). Only the
 * `limit` class can carry a window. `AgentError.windowResetsAtMs` is set when a caller already
 * parsed the time; production reads the explicit wording (`resets at <date>`, `resets in <duration>`).
 * Generic capacity and `rate limit … try again in N` are never a window: this parser only accepts
 * the verb `reset(s)`/`resetting` with a concrete time, so a 429 stays the existing transient retry.
 * Duration units are the explicit tokens below. A prefix match is not a unit: `m` is a minute, `month` is not.
 */
const WINDOW_DURATION_UNIT = "ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?";
const WINDOW_DURATION_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export function providerWindowResetsAtMs(err: unknown, now = Date.now()): number | undefined {
  const fromField = err instanceof AgentError ? err.windowResetsAtMs : undefined;
  if (fromField !== undefined && Number.isFinite(fromField) && fromField > now) return fromField;
  const message = err instanceof Error ? err.message : String(err);
  const at = /\bresets?\s+at\s+([^\n.;]+)/i.exec(message);
  if (at) {
    const parsed = Date.parse(at[1]!.trim());
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const inMatch = new RegExp(String.raw`\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:${WINDOW_DURATION_UNIT})\b\.?\s*){1,4})`, "i").exec(message);
  if (inMatch) {
    const units = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(${WINDOW_DURATION_UNIT})\b`, "gi");
    let total = 0;
    for (const token of inMatch[1]!.matchAll(units)) {
      const n = Number(token[1]);
      const ms = WINDOW_DURATION_MS[token[2]!.toLowerCase()];
      if (ms === undefined || !Number.isFinite(n)) return undefined;
      total += n * ms;
    }
    if (total > 0 && now + total > now) return now + total;
  }
  return undefined;
}

/**
 * Every usable (non `capacity_only`) entry of the chain ended on a `limit` error with an explicitly
 * resetting usage window (#177). The fallback chain was exhausted first. Not transient: an immediate
 * retry would hit the same window, so the queue parks the entry without a coding slot until the
 * latest window resets. A provider stop without an explicit window is never this error.
 */
export class ProviderWindowError extends Error {
  constructor(
    readonly resetsAtMs: number,
    cause: unknown,
  ) {
    super(`every usable model is at its usage limit until ${new Date(resetsAtMs).toISOString()}`, { cause });
    this.name = "ProviderWindowError";
  }
}

export type ModelRequest = Omit<AgentRequest, "model" | "thinking"> & {
  /** Implement package this call belongs to; copied onto `step_retry` for `factory status`. */
  packageId?: string;
};

export interface ModelResponse extends AgentResponse {
  model: string;
}

/**
 * Same-model backoff: base * 2^attempt, capped at max.
 * A provider retry-after is a floor (wait at least that long), itself capped at `max_ms * 2`.
 */
export function backoffMs(attempt: number, retry: Profile["retry"], retryAfter?: number): number {
  const exp = Math.min(retry.base_ms * 2 ** attempt, retry.max_ms);
  const cap = retry.max_ms * 2;
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter <= 0) return Math.min(exp, cap);
  return Math.min(Math.max(exp, retryAfter), cap);
}

/**
 * The chain for a role. Defense in depth (the profile is validated at load too):
 * an `implement` entry of another model family than the first is kept only when it is
 * `capacity_only`.
 */
export function chainFor(profile: Profile, role: string): ModelEntry[] {
  const profileRole = profileRoleOf(role);
  const chain = profile.roles[profileRole];
  if (!chain?.length) throw new Error(`profile has no models for role ${profileRole}`);
  if (profileRole !== "implement") return chain;
  const family = familyOf(chain[0]!);
  return chain.filter((e) => familyOf(e) === family || e.capacity_only === true);
}

/** Next usable entry after index i for an error class: capacity_only entries only after capacity errors. */
function nextEntry(chain: ModelEntry[], i: number, cls: ErrorClass): number {
  for (let j = i + 1; j < chain.length; j++) if (!chain[j]!.capacity_only || cls === "capacity") return j;
  return -1;
}

/**
 * Usage as recorded: a subscription provider bills no per-call USD, so its catalog cost is dropped
 * (reports show its tokens instead); `data.billing` keeps the kind for `stats`.
 */
export function billedUsage(model: string, usage: Partial<AgentUsage> | undefined, profile: Profile): Partial<AgentUsage> & { billing: "subscription" | "metered" } {
  const billing = billingOf(model, profile.billing);
  return { ...usage, ...(billing === "subscription" ? { cost_usd: 0 } : {}), billing };
}

/** One call's input size, without putting the tokens on the event (that would double-count usage). */
function warnStepTokens(events: EventLog, step: string, role: string, model: string, tokensIn: number | undefined, threshold: number | undefined): void {
  if (!threshold || threshold <= 0 || tokensIn === undefined || tokensIn < threshold) return;
  events.emit({
    step,
    event: "progress",
    role,
    model,
    data: {
      warning: "step_tokens",
      detail: `single step used ${tokensIn} tokens_in (threshold ${threshold})`,
      tokens_in: tokensIn,
      threshold,
    },
  });
}

/**
 * Runs one agent call with the role's model chain: capacity and network errors retry the same model with
 * exponential backoff, then fall back (network like other: never to `capacity_only`); a provider stream abort
 * retries the same model up to `streamRetries` (the current call only) and then falls back the same way; limit/auth/other
 * fall back directly, skipping `capacity_only` entries; invalid output never falls back.
 * An attempt that spanned a box freeze and failed with a network, stream or unclassified error is retried
 * without counting (`SUSPEND_RETRIES`). When the chain gives up on a transient class it throws
 * `TransientAgentError`; when every usable model's last error was a `limit` with an explicit resetting
 * window it throws `ProviderWindowError` (#177). Usage is recorded from successful and failed calls.
 */
export async function callModel(deps: CallDeps, step: string, req: ModelRequest): Promise<ModelResponse> {
  const { profile, events } = deps;
  const sleep = deps.sleep ?? realSleep;
  const chain = chainFor(profile, req.role);
  const suspends = deps.suspends ?? (() => 0);
  const streamRetries = deps.streamRetries ?? 2;
  let suspendRetries = 0;
  let streamRetriesUsed = 0;
  let lastError: unknown;
  let lastClass: ErrorClass = "other";
  /** Chain index -> explicit reset window of that entry's final `limit` error. */
  const windows = new Map<number, number>();
  const { packageId, ...agentReq } = req;
  for (let i = 0; i >= 0 && i < chain.length; ) {
    const entry = chain[i]!;
    let next: number;
    for (let attempt = 0; ; attempt++) {
      const suspendsBefore = suspends();
      try {
        const res = await deps.runner.run({ ...agentReq, model: entry.model, thinking: entry.thinking });
        const { billing, ...usage } = billedUsage(entry.model, res.usage, profile);
        events.emit({ step, event: "agent_finished", role: req.role, model: entry.model, ...usage, data: { billing } });
        warnStepTokens(events, step, req.role, entry.model, res.usage?.tokens_in, deps.tokenWarn);
        return { ...res, model: entry.model };
      } catch (err) {
        lastError = err;
        const cls = classifyError(err);
        lastClass = cls;
        const { billing, ...usage } = billedUsage(entry.model, err instanceof AgentError ? err.usage : undefined, profile);
        events.emit({
          step,
          event: "agent_error",
          role: req.role,
          model: entry.model,
          ...usage,
          data: { class: cls, message: (err as Error).message.slice(0, 500), billing },
        });
        warnStepTokens(events, step, req.role, entry.model, err instanceof AgentError ? err.usage.tokens_in : undefined, deps.tokenWarn);
        if (req.signal?.aborted) throw err;
        if (cls === "invalid_output") throw err;
        if ((cls === "network" || cls === "stream" || cls === "other") && suspends() > suspendsBefore && suspendRetries < SUSPEND_RETRIES) {
          // The box was frozen while this request was in flight: not the model's fault, not counted as an attempt.
          suspendRetries++;
          attempt--;
          events.emit({ step, event: "model_retry", role: req.role, model: entry.model, data: { after_suspend: true, suspend_retry: suspendRetries } });
          continue;
        }
        if (cls === "stream" && attempt < streamRetries) {
          const delay = backoffMs(attempt, profile.retry, providerRetryAfterMs(err));
          streamRetriesUsed++;
          events.emit({
            step,
            event: "step_retry",
            role: req.role,
            model: entry.model,
            data: {
              class: "stream",
              attempt: attempt + 1,
              max: streamRetries,
              delay_ms: delay,
              ...(packageId ? { package: packageId } : {}),
            },
          });
          await sleep(delay, req.signal);
          continue;
        }
        let retrySame = (cls === "capacity" || cls === "network") && attempt + 1 < profile.retry.attempts;
        if (retrySame && cls === "network" && deps.networkRetries && deps.networkRetries.n + 1 >= profile.retry.attempts) retrySame = false;
        if (retrySame) {
          if (cls === "network" && deps.networkRetries) {
            deps.networkRetries.n += 1;
            deps.onNetworkRetry?.(deps.networkRetries.n);
          }
          const delay = backoffMs(attempt, profile.retry, providerRetryAfterMs(err));
          events.emit({ step, event: "model_retry", role: req.role, model: entry.model, data: { attempt: attempt + 1, delay_ms: delay } });
          await sleep(delay, req.signal);
          continue;
        }
        next = nextEntry(chain, i, cls);
        if (cls === "limit") {
          const resetsAt = providerWindowResetsAtMs(err);
          if (resetsAt !== undefined) windows.set(i, resetsAt);
        }
        if (next >= 0) {
          events.emit({
            step,
            event: "model_fallback",
            role: req.role,
            model: entry.model,
            data: { from: entry.model, to: chain[next]!.model, class: cls, ...(chain[next]!.capacity_only ? { capacity_only: true } : {}) },
          });
        }
        break;
      }
    }
    i = next;
  }
  if (!req.signal?.aborted) {
    // Fallback had its chance: only when every usable model waited on an explicit window the entry waits (#177).
    const usable = chain.map((e, idx) => (e.capacity_only ? -1 : idx)).filter((idx) => idx >= 0);
    if (usable.length > 0 && usable.every((idx) => windows.has(idx))) {
      throw new ProviderWindowError(Math.max(...usable.map((idx) => windows.get(idx)!)), lastError);
    }
  }
  if (TRANSIENT_CLASSES.includes(lastClass) && !req.signal?.aborted) {
    const causeText = lastError instanceof Error ? lastError.message : String(lastError);
    const message = lastClass === "stream" ? `provider stream aborted after ${streamRetriesUsed} ${streamRetriesUsed === 1 ? "retry" : "retries"}: ${causeText}` : undefined;
    throw new TransientAgentError(lastClass, lastError, message);
  }
  throw lastError;
}
