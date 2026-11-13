/**
 * Issue #177: a provider usage limit with an explicitly resetting usage window parks the queue
 * entry until that window instead of requeueing it. Only explicit reset wording on a `limit`
 * error is a window; generic 429/capacity stays the existing transient retry.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { callModel, ProviderWindowError, providerWindowResetsAtMs, TransientAgentError } from "../../src/agents/models.js";
import { AgentError } from "../../src/agents/runner.js";
import { EventLog } from "../../src/events.js";
import { parseProfile, PROFILE_ROLES } from "../../src/schemas/profile.js";

function rolesYaml(implement: string, retryAttempts = 3): ReturnType<typeof parseProfile> {
  const roles: Record<string, string> = Object.fromEntries(PROFILE_ROLES.map((r) => [r, "[{ model: openai/x }]"]));
  return parseProfile(
    `roles:\n${Object.entries(roles)
      .map(([k, v]) => (k === "implement" ? `  ${k}: ${implement}` : `  ${k}: ${v}`))
      .join("\n")}\nretry: { base_ms: 10, max_ms: 20, attempts: ${retryAttempts} }\n`,
  );
}

const chainProfile = rolesYaml("[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }, { model: opencode-go/mimo-v2.6-flash, capacity_only: true }]");

function setup(profile: ReturnType<typeof parseProfile>, steps: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "pw-"));
  const events = new EventLog(dir, "r");
  const runner = new FakeRunner(steps);
  const slept: number[] = [];
  const deps = { runner, profile, events, sleep: async (ms: number) => void slept.push(ms) };
  const read = () => readFileSync(events.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { deps, runner, slept, read };
}

const req = { role: "implement", cwd: "/tmp", system: "", prompt: "p", tools: "none" as const, env: {} };

describe("explicit usage window reset time (#177)", () => {
  const now = Date.parse("2026-01-15T10:00:00.000Z");
  const HOUR = 3_600_000;

  it.each([
    ["Weekly usage limit reached. Resets in 2 hours.", now + 2 * HOUR],
    ["Usage limit reached; resets in 45m", now + 45 * 60_000],
    ["You have used your weekly usage limit. It resets at 2026-01-18T09:00:00Z", Date.parse("2026-01-18T09:00:00Z")],
    ["usage limit, window resets in 1d 4h", now + 28 * HOUR],
    ["quota exhausted; your limit resets at 2026-01-16T00:00:00Z", Date.parse("2026-01-16T00:00:00Z")],
  ])("parses %s", (message, expected) => {
    expect(providerWindowResetsAtMs(new AgentError(message), now)).toBe(expected);
  });

  it("never infers a window from generic capacity or rate-limit wording", () => {
    expect(providerWindowResetsAtMs(new AgentError("429 at capacity, try again in 60 seconds", undefined, 429, 60_000), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("rate limit exceeded, try again in 5 minutes"), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("Too Many Requests, please retry later"), now)).toBeUndefined();
  });

  it("requires an explicit reset time on the usage limit", () => {
    expect(providerWindowResetsAtMs(new AgentError("usage limit reached"), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("quota exceeded, will reset eventually"), now)).toBeUndefined();
  });

  it("a reset time in the past is not a usable window", () => {
    expect(providerWindowResetsAtMs(new AgentError("usage limit; resets at 2020-01-01T00:00:00Z"), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("usage limit; resets in 0 minutes"), now)).toBeUndefined();
  });

  it("does not treat month as minutes; only explicit supported units are a window", () => {
    expect(providerWindowResetsAtMs(new AgentError("usage limit reached; resets in 1 month"), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("quota exhausted; resets in 2 months"), now)).toBeUndefined();
    expect(providerWindowResetsAtMs(new AgentError("usage limit; resets in 1m"), now)).toBe(now + 60_000);
    expect(providerWindowResetsAtMs(new AgentError("usage limit; resets in 1 min"), now)).toBe(now + 60_000);
    expect(providerWindowResetsAtMs(new AgentError("usage limit; resets in 1 minute"), now)).toBe(now + 60_000);
  });

  it("reads an already parsed reset time from the error field", () => {
    const err = Object.assign(new AgentError("monthly usage limit"), { windowResetsAtMs: now + HOUR });
    expect(providerWindowResetsAtMs(err, now)).toBe(now + HOUR);
  });
});

describe("callModel provider window error (#177)", () => {
  it("throws ProviderWindowError only when every usable model has an explicit resetting window", async () => {
    const { deps, runner, slept } = setup(chainProfile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "Weekly usage limit reached. Resets in 2 hours." } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", error: { message: "Weekly usage limit reached. Resets in 3 hours." } },
    ]);
    const before = Date.now();
    const err = await callModel(deps, "implement", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderWindowError);
    // capacity_only entries are not usable for a limit error: the chain stops after the two usable models.
    expect(runner.calls.map((c) => c.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4-pro"]);
    // The wait covers every usable window: the latest reset wins. No same-model retries for a limit.
    const resetsAt = (err as ProviderWindowError).resetsAtMs;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 3 * 3_600_000 - 5_000);
    expect(resetsAt).toBeLessThanOrEqual(Date.now() + 3 * 3_600_000 + 5_000);
    expect(slept).toEqual([]);
  });

  it("a usable model without an explicit window is not a window wait", async () => {
    const { deps } = setup(chainProfile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "Weekly usage limit reached. Resets in 2 hours." } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", error: { message: "usage limit reached" } },
    ]);
    const err = await callModel(deps, "implement", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).not.toBeInstanceOf(ProviderWindowError);
  });

  it("model fallback still comes first: a later usable model without a limit wins", async () => {
    const { deps, runner } = setup(chainProfile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "Weekly usage limit reached. Resets in 2 hours." } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", raw: "ok" },
    ]);
    const res = await callModel(deps, "implement", req);
    expect(res).toMatchObject({ text: "ok", model: "opencode-go/deepseek-v4-pro" });
    expect(runner.calls.map((c) => c.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4-pro"]);
  });

  it("generic capacity with reset-like text stays a transient retry, never a window", async () => {
    const profile = rolesYaml("[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }]", 1);
    const { deps } = setup(profile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "429 at capacity, resets in 1 minute", status: 429 } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", error: { message: "429 at capacity, resets in 1 minute", status: 429 } },
    ]);
    const err = await callModel(deps, "implement", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err).not.toBeInstanceOf(ProviderWindowError);
  });

  it("permanent auth and billing failures are not a window and are not retried", async () => {
    const profile = rolesYaml("[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }]", 3);
    const { deps, runner } = setup(profile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "401 unauthorized, billing account suspended. Resets in 2 hours.", status: 401 } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", error: { message: "403 payment required, card declined", status: 403 } },
    ]);
    const err = await callModel(deps, "implement", req).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderWindowError);
    expect(err).not.toBeInstanceOf(TransientAgentError);
    expect(runner.calls).toHaveLength(2);
  });

  it("a billing limit without an explicit resetting window is not retried and not a window", async () => {
    const profile = rolesYaml("[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }]", 3);
    const { deps, runner, slept } = setup(profile, [
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "insufficient_quota: billing hard limit", status: 402 } },
      { role: "implement", model: "opencode-go/deepseek-v4-pro", error: { message: "used all available credits", status: 402 } },
    ]);
    const err = await callModel(deps, "implement", req).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderWindowError);
    expect(err).not.toBeInstanceOf(TransientAgentError);
    expect(runner.calls).toHaveLength(2);
    expect(slept).toEqual([]);
  });
});
