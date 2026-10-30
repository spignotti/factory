import type { EventLog } from "../events.js";
import { billingOf, familyOf, type ModelEntry, type Profile, profileRoleOf } from "../schemas/profile.js";
import { realSleep, type Sleep } from "./fake-runner.js";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, type AgentUsage } from "./runner.js";

export type ErrorClass = "capacity" | "network" | "limit" | "auth" | "invalid_output" | "other";

/**
 * A dropped, failed or timed-out connection: worth retrying the same model. undici reports a cut stream as
 * `terminated`; the OpenAI-compatible SDK reports a request timeout as `Request timed out.` and a failed
 * connection as `Connection error.` (20261030-125347-5b7ada: a request in flight across a 19 min box freeze).
 */
const NETWORK = /^terminated$|^request timed out\.?$|^connection error\.?$|\bAPIConnectionTimeoutError\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEPIPE\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|socket hang up|fetch failed|other side closed|premature close/i;

/** Bad agent output; never a reason to fall back to another model. */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

/** Provider capacity errors are their own class. */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof InvalidOutputError) return "invalid_output";
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof AgentError ? err.status : undefined;
  const retryAfter = err instanceof AgentError ? err.retryAfterMs : undefined;
  if (/at capacity|ttft_admission_refused|overloaded/i.test(message)) return "capacity";
  if ((status === 429 || status === 503) && (/retry shortly|try again shortly/i.test(message) || retryAfter !== undefined)) {
    return "capacity";
  }
  if (status === undefined && NETWORK.test(message.trim())) return "network";
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authenticat|forbidden|not logged in/i.test(message)) {
    return "auth";
  }
  if (status === 429 || /rate.?limit|quota|usage limit|limit reached|insufficient_quota|too many requests/i.test(message)) {
    return "limit";
  }
  return "other";
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
}

/** Extra same-model retries per call for attempts that spanned a box freeze. */
export const SUSPEND_RETRIES = 2;

/** Error classes that are the provider's or the network's fault, not the task's: the run stays resumable. */
export const TRANSIENT_CLASSES: readonly ErrorClass[] = ["capacity", "network"];

/**
 * The model chain gave up on a transient error (capacity, network, timeout). The run ends `needs_human`
 * (resumable, worktree kept) instead of `failed`.
 */
export class TransientAgentError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    cause: unknown,
  ) {
    super(`transient ${errorClass} error after retries: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TransientAgentError";
  }
}

export type ModelRequest = Omit<AgentRequest, "model" | "thinking">;

export interface ModelResponse extends AgentResponse {
  model: string;
}

/** Capacity backoff: base * 2^attempt, capped at max. */
export function backoffMs(attempt: number, retry: Profile["retry"]): number {
  return Math.min(retry.base_ms * 2 ** attempt, retry.max_ms);
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
 * Runs one agent call with the role's model chain: capacity and network errors retry the same model with
 * exponential backoff, then fall back (network like other: never to `capacity_only`); limit/auth/other fall back directly, skipping
 * `capacity_only` entries; invalid output never falls back. An attempt that spanned a box freeze and failed
 * with a network or unclassified error is retried without counting (`SUSPEND_RETRIES`). When the chain gives
 * up on a transient class it throws `TransientAgentError`. Usage is recorded from successful and failed calls.
 */
/**
 * Usage as recorded: a subscription provider bills no per-call USD, so its catalog cost is dropped
 * (reports show its tokens instead); `data.billing` keeps the kind for `stats`.
 */
export function billedUsage(model: string, usage: Partial<AgentUsage> | undefined, profile: Profile): Partial<AgentUsage> & { billing: "subscription" | "metered" } {
  const billing = billingOf(model, profile.billing);
  return { ...usage, ...(billing === "subscription" ? { cost_usd: 0 } : {}), billing };
}

export async function callModel(deps: CallDeps, step: string, req: ModelRequest): Promise<ModelResponse> {
  const { profile, events } = deps;
  const sleep = deps.sleep ?? realSleep;
  const chain = chainFor(profile, req.role);
  const suspends = deps.suspends ?? (() => 0);
  let suspendRetries = 0;
  let lastError: unknown;
  let lastClass: ErrorClass = "other";
  for (let i = 0; i >= 0 && i < chain.length; ) {
    const entry = chain[i]!;
    let next: number;
    for (let attempt = 0; ; attempt++) {
      const suspendsBefore = suspends();
      try {
        const res = await deps.runner.run({ ...req, model: entry.model, thinking: entry.thinking });
        const { billing, ...usage } = billedUsage(entry.model, res.usage, profile);
        events.emit({ step, event: "agent_finished", role: req.role, model: entry.model, ...usage, data: { billing } });
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
        if (req.signal?.aborted) throw err;
        if (cls === "invalid_output") throw err;
        if ((cls === "network" || cls === "other") && suspends() > suspendsBefore && suspendRetries < SUSPEND_RETRIES) {
          // The box was frozen while this request was in flight: not the model's fault, not counted as an attempt.
          suspendRetries++;
          attempt--;
          events.emit({ step, event: "model_retry", role: req.role, model: entry.model, data: { after_suspend: true, suspend_retry: suspendRetries } });
          continue;
        }
        if ((cls === "capacity" || cls === "network") && attempt + 1 < profile.retry.attempts) {
          const delay = backoffMs(attempt, profile.retry);
          events.emit({ step, event: "model_retry", role: req.role, model: entry.model, data: { attempt: attempt + 1, delay_ms: delay } });
          await sleep(delay, req.signal);
          continue;
        }
        next = nextEntry(chain, i, cls);
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
  if (TRANSIENT_CLASSES.includes(lastClass) && !req.signal?.aborted) throw new TransientAgentError(lastClass, lastError);
  throw lastError;
}
