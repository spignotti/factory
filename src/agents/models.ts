import type { EventLog } from "../events.js";
import { billingOf, familyOf, type ModelEntry, type Profile, profileRoleOf } from "../schemas/profile.js";
import { realSleep, type Sleep } from "./fake-runner.js";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, type AgentUsage } from "./runner.js";

export type ErrorClass = "capacity" | "limit" | "auth" | "invalid_output" | "other";

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
 * Runs one agent call with the role's model chain: capacity errors retry the same model with
 * exponential backoff, then fall back; limit/auth/other fall back directly, skipping
 * `capacity_only` entries; invalid output never falls back. Usage is recorded from successful and failed calls.
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
  let lastError: unknown;
  for (let i = 0; i >= 0 && i < chain.length; ) {
    const entry = chain[i]!;
    let next: number;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await deps.runner.run({ ...req, model: entry.model, thinking: entry.thinking });
        const { billing, ...usage } = billedUsage(entry.model, res.usage, profile);
        events.emit({ step, event: "agent_finished", role: req.role, model: entry.model, ...usage, data: { billing } });
        return { ...res, model: entry.model };
      } catch (err) {
        lastError = err;
        const cls = classifyError(err);
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
        if (cls === "capacity" && attempt + 1 < profile.retry.attempts) {
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
  throw lastError;
}
