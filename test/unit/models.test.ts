import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { backoffMs, billedUsage, callModel, chainFor, classifyError, parseRetryAfterText, providerRetryAfterMs, InvalidOutputError, TransientAgentError } from "../../src/agents/models.js";
import { AgentError } from "../../src/agents/runner.js";
import { EventLog } from "../../src/events.js";
import { loadProfile, parseProfile, PROFILE_ROLES } from "../../src/schemas/profile.js";

/** Every role on one model, then overrides. */
function rolesYaml(overrides: Record<string, string> = {}): string {
  const roles: Record<string, string> = Object.fromEntries(PROFILE_ROLES.map((r) => [r, "[{ model: openai/x }]"]));
  roles.implement = "[{ model: opencode-go/deepseek-v4.1-flash }]";
  Object.assign(roles, overrides);
  return `roles:\n${Object.entries(roles).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;
}

const profile = parseProfile(
  rolesYaml({
    plan_high: "[{ model: openai/sol, thinking: high }, { model: opencode-go/grok-4.7 }]",
    plan_medium: "[{ model: openai/sol }]",
    implement: "[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }, { model: opencode-go/mimo-v2.6-flash, capacity_only: true }]",
    review_plan: "[{ model: openai/codex }, { model: opencode-go/grok-4.7 }]",
  }) + "retry: { base_ms: 100, max_ms: 250, attempts: 3 }\n",
);

function setup(steps: ConstructorParameters<typeof FakeRunner>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "m-"));
  const events = new EventLog(dir, "r");
  const runner = new FakeRunner(steps);
  const slept: number[] = [];
  const deps = { runner, profile, events, sleep: async (ms: number) => void slept.push(ms) };
  const read = () => readFileSync(events.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { deps, runner, slept, read };
}

const req = (role: string) => ({ role, cwd: "/tmp", system: "", prompt: "p", tools: "none" as const, env: {} });

describe("error classification", () => {
  it.each([
    [new AgentError("Model is at capacity"), "capacity"],
    [new AgentError("The model is currently at capacity due to high demand"), "capacity"],
    [new AgentError("The model is currently at capacity due to high demand. Please try again later.", undefined, 429), "capacity"],
    [new AgentError("Your team has either used all available credits or reached its monthly spending limit."), "limit"],
    [new AgentError("xAI API error (403): Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.", undefined, 403), "limit"],
    [new AgentError("Team usage limit reached", undefined, 429, 5_000), "limit"],
    [new AgentError("used all available credits; try again in 60 seconds"), "limit"],
    [new AgentError("error: ttft_admission_refused"), "capacity"],
    [new AgentError("503 Service Unavailable, please retry shortly", undefined, 503), "capacity"],
    [new AgentError("429", undefined, 429, 5000), "capacity"],
    [new AgentError("429 Too Many Requests", undefined, 429), "capacity"],
    [new AgentError("rate limit exceeded, try again in 60 seconds"), "capacity"],
    [new AgentError("rate limit"), "other"],
    [new AgentError("You exceeded your current quota"), "limit"],
    [new AgentError("usage limit reached"), "limit"],
    [new AgentError("401 Unauthorized", undefined, 401), "auth"],
    [new AgentError("invalid api key"), "auth"],
    [new InvalidOutputError("handoff invalid"), "invalid_output"],
    [new AgentError("500 internal error", undefined, 500), "other"],
    [new Error("socket hang up"), "network"],
    [new Error("terminated"), "network"],
    [new Error("read ECONNRESET"), "network"],
    [new AgentError("Stream ended without finish_reason"), "stream"],
    [new Error("premature EOF"), "stream"],
    [new Error("unexpected EOF"), "stream"],
    [new Error("connection reset during streaming"), "stream"],
    [new Error("Error while streaming the response"), "stream"],
    [new AgentError("Request timed out."), "network"],
    [new AgentError("request timed out"), "network"],
    [new AgentError("Connection error."), "network"],
    [new AgentError("Connection error.\nTLS: certificate verify failed: unable to verify the first certificate"), "network"],
    [new Error("TLS handshake timeout"), "network"],
    [new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "network"],
    [new Error("certificate"), "other"],
    [new Error("missing configuration for the provider"), "other"],
    [new AgentError("Connection error.", undefined, 401), "auth"],
    [new AgentError("APIConnectionTimeoutError: Request timed out."), "network"],
    [new AgentError("Command timed out after 600 seconds"), "other"],
    [new AgentError("fetch failed", undefined, 502), "other"],
    [new AgentError("tool terminated the process"), "other"],
  ])("%s -> %s", (err, cls) => {
    expect(classifyError(err)).toBe(cls);
  });
});

describe("fallback", () => {
  it("retries the same model with exponential backoff on capacity, then falls back", async () => {
    const cap = { message: "at capacity", status: 503 };
    const { deps, slept, read, runner } = setup([
      { role: "plan_high", model: "openai/sol", error: cap, usage: { tokens_in: 10, tokens_out: 0, cost_usd: 0.01 } },
      { role: "plan_high", model: "openai/sol", error: cap },
      { role: "plan_high", model: "openai/sol", error: cap },
      { role: "plan_high", model: "opencode-go/grok-4.7", raw: "ok", usage: { tokens_in: 5, tokens_out: 5, cost_usd: 0 } },
    ]);
    const res = await callModel(deps, "plan", req("plan_high"));
    expect(res).toMatchObject({ text: "ok", model: "opencode-go/grok-4.7" });
    expect(slept).toEqual([100, 200]);
    expect(runner.calls.map((c) => c.model)).toEqual(["openai/sol", "openai/sol", "openai/sol", "opencode-go/grok-4.7"]);
    expect(runner.calls[0]?.thinking).toBe("high");
    const ev = read();
    expect(ev.map((e) => e.event)).toEqual([
      "agent_error", "model_retry", "agent_error", "model_retry", "agent_error", "model_fallback", "agent_finished",
    ]);
    // usage recorded from the error event too
    // openai (ChatGPT login) is a subscription: tokens are kept, the catalog price is not
    expect(ev[0]).toMatchObject({ tokens_in: 10, cost_usd: 0, data: { class: "capacity", billing: "subscription" } });
    expect(ev[5]).toMatchObject({ data: { from: "openai/sol", to: "opencode-go/grok-4.7", class: "capacity" } });
  });

  it("retries the same model on a dropped stream, never falling back to capacity_only", async () => {
    const { deps, slept, runner, read } = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "terminated" } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    const res = await callModel(deps, "plan", req("plan_high"));
    expect(res).toMatchObject({ text: "ok", model: "openai/sol" });
    expect(slept).toEqual([100]);
    expect(runner.calls.map((c) => c.model)).toEqual(["openai/sol", "openai/sol"]);
    expect(read()[0]).toMatchObject({ event: "agent_error", data: { class: "network" } });
  });

  it("falls back immediately on limit without backoff", async () => {
    const { deps, slept, runner } = setup([
      { role: "review_plan", error: { message: "usage limit reached", status: 429 } },
      { role: "review_plan", raw: "ok" },
    ]);
    await callModel(deps, "review", req("review_plan"));
    expect(slept).toEqual([]);
    expect(runner.calls.map((c) => c.model)).toEqual(["openai/codex", "opencode-go/grok-4.7"]);
  });

  it("never falls back on invalid output", async () => {
    const runner = { run: async () => Promise.reject(new InvalidOutputError("bad")) };
    const { deps } = setup([]);
    await expect(callModel({ ...deps, runner }, "x", req("plan_high"))).rejects.toBeInstanceOf(InvalidOutputError);
  });

  it("throws the last error when the chain is exhausted", async () => {
    const { deps } = setup([{ role: "plan_medium", error: { message: "boom" } }]);
    await expect(callModel(deps, "plan", req("plan_medium"))).rejects.toThrow("boom");
  });

  it("V06: a TLS appendix uses the same network retries, and auth does not", async () => {
    const tls = "Connection error.\nTLS: certificate verify failed: unable to verify the first certificate";
    const bare = setup([
      { role: "plan_medium", error: { message: "Connection error." } },
      { role: "plan_medium", error: { message: "Connection error." } },
      { role: "plan_medium", raw: "ok" },
    ]);
    await callModel(bare.deps, "plan", req("plan_medium"));
    const withTls = setup([
      { role: "plan_medium", error: { message: tls } },
      { role: "plan_medium", error: { message: tls } },
      { role: "plan_medium", raw: "ok" },
    ]);
    await callModel(withTls.deps, "plan", req("plan_medium"));
    expect(withTls.runner.calls).toHaveLength(bare.runner.calls.length);
    expect(withTls.slept).toEqual(bare.slept);
    expect(withTls.slept).toEqual([100, 200]);

    const box = { n: 0 };
    const auth = setup([{ role: "plan_medium", error: { message: "invalid api key" } }]);
    await expect(callModel({ ...auth.deps, networkRetries: box }, "plan", req("plan_medium"))).rejects.toThrow(/invalid api key/);
    expect(auth.slept).toEqual([]);
    expect(auth.runner.calls).toHaveLength(1);
    expect(box.n).toBe(0);

    const quota = setup([{ role: "plan_medium", error: { message: "You exceeded your current quota" } }]);
    await expect(callModel({ ...quota.deps, networkRetries: box }, "plan", req("plan_medium"))).rejects.toThrow(/quota/);
    expect(quota.slept).toEqual([]);
    expect(box.n).toBe(0);

    const config = setup([{ role: "plan_medium", error: { message: "missing configuration for the provider" } }]);
    await expect(callModel({ ...config.deps, networkRetries: box }, "plan", req("plan_medium"))).rejects.toThrow(/configuration/);
    expect(config.slept).toEqual([]);
    expect(box.n).toBe(0);
  });

  it("V07: a later call keeps the network retries already spent", async () => {
    const box = { n: 0 };
    const tls = "Connection error.\nUNABLE_TO_VERIFY_LEAF_SIGNATURE";
    const first = setup([
      { role: "plan_medium", error: { message: "Connection error." } },
      { role: "plan_medium", raw: "ok" },
    ]);
    await callModel({ ...first.deps, networkRetries: box }, "plan", req("plan_medium"));
    expect(box.n).toBe(1);
    expect(first.slept).toEqual([100]);
    expect(first.runner.calls).toHaveLength(2);

    const second = setup([
      { role: "plan_medium", error: { message: tls } },
      { role: "plan_medium", error: { message: tls } },
      { role: "plan_medium", error: { message: tls } },
    ]);
    const err = await callModel({ ...second.deps, networkRetries: box }, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err).toMatchObject({ errorClass: "network" });
    // One retry was already spent, so this call gets one retry (two attempts), not a fresh three.
    expect(second.runner.calls).toHaveLength(2);
    expect(second.slept).toEqual([100]);
    expect(box.n).toBe(2);
  });

  it("retries a provider request timeout on the same model (20261030-125347-5b7ada)", async () => {
    const { deps, slept, runner } = setup([
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "Request timed out." } },
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", raw: "ok" },
    ]);
    const res = await callModel(deps, "implement", req("implement"));
    expect(res).toMatchObject({ text: "ok", model: "opencode-go/deepseek-v4.1-flash" });
    expect(slept).toEqual([100]);
    expect(runner.calls).toHaveLength(2);
  });

  it("retries a provider stream abort on the same model, then succeeds", async () => {
    const { deps, slept, runner, read } = setup([
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: { message: "Stream ended without finish_reason" }, usage: { tokens_in: 2_500_000, tokens_out: 0, cost_usd: 1 } },
      { role: "implement", model: "opencode-go/deepseek-v4.1-flash", raw: "ok", usage: { tokens_in: 10, tokens_out: 1, cost_usd: 0 } },
    ]);
    const res = await callModel({ ...deps, tokenWarn: 1_000_000 }, "implement", { ...req("implement"), packageId: "P5" });
    expect(res).toMatchObject({ text: "ok", model: "opencode-go/deepseek-v4.1-flash" });
    expect(slept).toEqual([100]);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every((c) => c.model === "opencode-go/deepseek-v4.1-flash")).toBe(true);
    const ev = read();
    expect(ev.filter((e) => e.event === "step_retry")).toEqual([
      expect.objectContaining({ data: { class: "stream", attempt: 1, max: 2, delay_ms: 100, package: "P5" } }),
    ]);
    expect(ev.filter((e) => e.event === "model_fallback")).toEqual([]);
    expect(ev.find((e) => e.event === "agent_error")).toMatchObject({ data: { class: "stream" }, tokens_in: 2_500_000 });
    const warning = ev.find((e) => e.data.warning === "step_tokens");
    expect(warning).toMatchObject({ event: "progress", tokens_in: 0, data: { tokens_in: 2_500_000, threshold: 1_000_000 } });
    // The warning must not double-count the call's tokens.
    expect(deps.events.totals.tokens_in).toBe(2_500_010);
  });

  it("throws TransientAgentError when stream retries are exhausted", async () => {
    const abort = { role: "plan_medium", error: { message: "Stream ended without finish_reason" } };
    const { deps, slept, runner, read } = setup([abort, abort, abort]);
    const err = await callModel(deps, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err).toMatchObject({ errorClass: "stream", message: "provider stream aborted after 2 retries: Stream ended without finish_reason" });
    expect(slept).toEqual([100, 200]);
    expect(runner.calls).toHaveLength(3);
    expect(read().filter((e) => e.event === "step_retry")).toHaveLength(2);
  });

  it("does not fall back to a capacity_only model after stream retries", async () => {
    const abort = { message: "premature EOF" };
    const { deps, runner } = setup([
      ...Array.from({ length: 3 }, () => ({ role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: abort })),
      ...Array.from({ length: 3 }, () => ({ role: "implement", model: "opencode-go/deepseek-v4-pro", error: abort })),
      { role: "implement", model: "opencode-go/mimo-v2.6-flash", raw: "should-not-run" },
    ]);
    const err = await callModel(deps, "implement", req("implement")).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorClass: "stream", message: "provider stream aborted after 4 retries: premature EOF" });
    expect(runner.calls.map((c) => c.model)).toEqual([
      "opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash",
      "opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4-pro",
    ]);
  });

  it("does not retry auth, limit, invalid output or other errors as stream aborts", async () => {
    const auth = setup([{ role: "plan_medium", error: { message: "401 Unauthorized", status: 401 } }]);
    await expect(callModel(auth.deps, "plan", req("plan_medium"))).rejects.toThrow(/Unauthorized/);
    expect(auth.read().some((e) => e.event === "step_retry")).toBe(false);
    expect(auth.runner.calls).toHaveLength(1);

    const other = setup([{ role: "plan_medium", error: { message: "boom" } }]);
    const err = await callModel(other.deps, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransientAgentError);
    expect(other.read().some((e) => e.event === "step_retry")).toBe(false);

    const bad = setup([]);
    const runner = { run: async () => Promise.reject(new InvalidOutputError("handoff schema")) };
    await expect(callModel({ ...bad.deps, runner }, "x", req("plan_high"))).rejects.toBeInstanceOf(InvalidOutputError);
    expect(bad.read().some((e) => e.event === "step_retry")).toBe(false);

    const limit = setup([
      { role: "review_plan", error: { message: "usage limit reached", status: 429 } },
      { role: "review_plan", raw: "ok" },
    ]);
    await callModel(limit.deps, "review", req("review_plan"));
    expect(limit.slept).toEqual([]);
    expect(limit.read().some((e) => e.event === "step_retry")).toBe(false);
    expect(limit.runner.calls.map((c) => c.model)).toEqual(["openai/codex", "opencode-go/grok-4.7"]);
  });

  it("honours streamRetries 0", async () => {
    const { deps, slept, runner } = setup([{ role: "plan_medium", error: { message: "unexpected EOF" } }]);
    const err = await callModel({ ...deps, streamRetries: 0 }, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorClass: "stream", message: "provider stream aborted after 0 retries: unexpected EOF" });
    expect(slept).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });

  it("throws TransientAgentError when the chain gives up on a network error", async () => {
    const t = { role: "plan_medium", error: { message: "Request timed out." } };
    const { deps } = setup([t, t, t]);
    const err = await callModel(deps, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientAgentError);
    expect(err).toMatchObject({ errorClass: "network", message: "transient network error after retries: Request timed out." });
    expect((err as Error).cause).toBeInstanceOf(AgentError);
  });

  it("does not wrap a non-transient final error", async () => {
    const { deps } = setup([{ role: "plan_medium", error: { message: "boom" } }]);
    const err = await callModel(deps, "plan", req("plan_medium")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TransientAgentError);
  });

  it("retries an attempt that spanned a box freeze without counting it, even for an unclassified error", async () => {
    let suspends = 0;
    const { deps, slept, runner, read } = setup([
      { role: "plan_medium", error: { message: "weird provider hiccup" } },
      { role: "plan_medium", error: { message: "Request timed out." } },
      { role: "plan_medium", raw: "ok" },
    ]);
    const freezing = { run: async (r: Parameters<typeof runner.run>[0]) => (suspends++, runner.run(r)) };
    const res = await callModel({ ...deps, runner: freezing, suspends: () => suspends }, "plan", req("plan_medium"));
    expect(res.text).toBe("ok");
    // both failures were during a freeze: free retries, no backoff
    expect(slept).toEqual([]);
    expect(read().filter((e) => e.event === "model_retry").map((e) => e.data)).toEqual([
      { after_suspend: true, suspend_retry: 1 },
      { after_suspend: true, suspend_retry: 2 },
    ]);
  });

  it("caps the free suspend retries, then falls back to the normal budget", async () => {
    let suspends = 0;
    const other = { role: "plan_medium", error: { message: "weird provider hiccup" } };
    const { deps, runner } = setup([other, other, other, other]);
    const freezing = { run: async (r: Parameters<typeof runner.run>[0]) => (suspends++, runner.run(r)) };
    await expect(callModel({ ...deps, runner: freezing, suspends: () => suspends }, "plan", req("plan_medium"))).rejects.toThrow("weird provider hiccup");
    // 1 + 2 free retries; "other" has no same-model retry budget and plan_medium has no fallback
    expect(runner.calls).toHaveLength(3);
  });

  it("caps the backoff at max_ms", () => {
    expect([0, 1, 2, 3].map((a) => backoffMs(a, profile.retry))).toEqual([100, 200, 250, 250]);
  });

  it("waits at least the provider retry-after, capped at max_ms * 2", () => {
    expect(backoffMs(0, profile.retry, 400)).toBe(400);
    expect(backoffMs(0, profile.retry, 10_000)).toBe(500);
    expect(backoffMs(1, profile.retry, 50)).toBe(200);
    expect(parseRetryAfterText("please try again in 2 seconds")).toBe(2_000);
    expect(parseRetryAfterText("Please try again in 7.648s.")).toBe(7648);
    expect(parseRetryAfterText("503 overloaded\nretry-after: 0.4")).toBe(400);
    expect(parseRetryAfterText("retry-after-ms: 1500")).toBe(1500);
    expect(providerRetryAfterMs(new AgentError("at capacity", undefined, 503, 400))).toBe(400);
    // Header-only Retry-After is not in the text Pi keeps. No delay is invented.
    expect(providerRetryAfterMs(new AgentError("The model is at capacity", undefined, 429))).toBeUndefined();
    expect(parseRetryAfterText("429 at capacity")).toBeUndefined();
  });

  it("retries a 429 and a rate-limit delay parsed from the error text, without a retryAfter field", async () => {
    const text = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "rate limit exceeded, try again in 60 seconds" } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    await callModel(text.deps, "plan", req("plan_high"));
    expect(text.slept).toEqual([500]);
    expect(text.read()[0]).toMatchObject({ data: { class: "capacity" } });
    expect(text.runner.calls.map((c) => c.model)).toEqual(["openai/sol", "openai/sol"]);

    const status = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "429 Too Many Requests", status: 429 } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    await callModel(status.deps, "plan", req("plan_high"));
    expect(status.slept).toEqual([100]);
    expect(status.read()[0]).toMatchObject({ data: { class: "capacity" } });
  });

  it("same-model backoff uses retry-after from the field and from the error text", async () => {
    const field = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "at capacity", status: 503, retry_after_ms: 400 } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    await callModel(field.deps, "plan", req("plan_high"));
    expect(field.slept).toEqual([400]);

    const text = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "at capacity, try again in 30 seconds", status: 503 } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    await callModel(text.deps, "plan", req("plan_high"));
    expect(text.slept).toEqual([500]);

    const header = setup([
      { role: "plan_high", model: "openai/sol", error: { message: "503 overloaded\nretry-after: 0.4", status: 503 } },
      { role: "plan_high", model: "openai/sol", raw: "ok" },
    ]);
    await callModel(header.deps, "plan", req("plan_high"));
    expect(header.slept).toEqual([400]);
  });
});

describe("implement model family", () => {
  it("rejects a cross-family implement entry that is not capacity_only", () => {
    expect(() => parseProfile(rolesYaml({ implement: "[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/grok-4.7 }]" }))).toThrow(
      /capacity_only/,
    );
  });

  it("accepts an explicit cross-family capacity_only backup", () => {
    const p = parseProfile(rolesYaml({ implement: "[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/mimo-v2.6-flash, capacity_only: true }]" }));
    expect(chainFor(p, "implement").map((e) => e.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.6-flash"]);
  });

  it("rejects capacity_only as the first entry", () => {
    expect(() => parseProfile(rolesYaml({ review_plan: "[{ model: openai/x, capacity_only: true }]" }))).toThrow(/first entry/);
  });

  it("rejects a reviewer in an implement model family, including the backup's family", () => {
    expect(() => parseProfile(rolesYaml({ review_security: "[{ model: opencode-go/deepseek-v4-pro }]" }))).toThrow(/reviewers must differ/);
    expect(() =>
      parseProfile(
        rolesYaml({
          implement: "[{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/mimo-v2.6-flash, capacity_only: true }]",
          review_simplicity: "[{ model: opencode-go/mimo-v2.6-flash }]",
        }),
      ),
    ).toThrow(/reviewers must differ/);
  });

  it("drops a cross-family entry without capacity_only at runtime (defense in depth)", () => {
    const p = { ...profile, roles: { ...profile.roles, implement: [{ model: "a/deepseek-1" }, { model: "b/grok-2" }] } };
    expect(chainFor(p, "implement").map((e) => e.model)).toEqual(["a/deepseek-1"]);
  });

  it("falls back within the family on a limit error and never to the capacity-only backup", async () => {
    const { deps, runner } = setup([
      { role: "implement", error: { message: "quota exceeded" } },
      { role: "implement", error: { message: "quota exceeded" } },
    ]);
    await expect(callModel(deps, "implement", req("implement"))).rejects.toThrow(/quota/);
    expect(runner.calls.map((c) => c.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4-pro"]);
  });

  it("uses the capacity-only backup only after capacity retries are exhausted", async () => {
    const cap = { message: "at capacity", status: 503 };
    const { deps, runner, slept, read } = setup([
      ...Array.from({ length: 3 }, () => ({ role: "implement", model: "opencode-go/deepseek-v4.1-flash", error: cap })),
      ...Array.from({ length: 3 }, () => ({ role: "implement", model: "opencode-go/deepseek-v4-pro", error: cap })),
      { role: "implement", model: "opencode-go/mimo-v2.6-flash", raw: "ok" },
    ]);
    const res = await callModel(deps, "implement", req("implement"));
    expect(res.model).toBe("opencode-go/mimo-v2.6-flash");
    expect(runner.calls).toHaveLength(7);
    expect(slept).toEqual([100, 200, 100, 200]);
    expect(read().filter((e) => e.event === "model_fallback").at(-1)).toMatchObject({ data: { to: "opencode-go/mimo-v2.6-flash", class: "capacity", capacity_only: true } });
  });

  it("ships a valid default profile with Silas's models", () => {
    const p = loadProfile("default");
    expect(p.roles.implement).toEqual([
      { model: "opencode-go/deepseek-v4.1-flash", thinking: "high" },
      { model: "opencode-go/mimo-v2.6-flash", capacity_only: true },
    ]);
    expect(p.roles.review_security[0]).toEqual({ model: "openai/gpt-6.1-sol", thinking: "high" });
    expect(p.roles.review_simplicity[0]).toEqual({ model: "openai/gpt-6-luna", thinking: "medium" });
    expect(JSON.stringify(p)).not.toMatch(/haiku/);
  });
});

describe("provider allowlist", () => {
  const PIN = "providers: { allow: [opencode-go, openai] }\n";
  const withImplement = (model: string) => rolesYaml({ implement: `[{ model: ${model} }]` }) + PIN;

  it("accepts opencode-go and openai", () => {
    expect(() => parseProfile(withImplement("opencode-go/deepseek-v4-pro"))).not.toThrow();
    expect(() => parseProfile(rolesYaml({ review_plan: "[{ model: openai/mid-codex }]" }) + PIN)).not.toThrow();
  });

  it("rejects the pay-per-use opencode (Zen) provider with a pointed message", () => {
    expect(() => parseProfile(withImplement("opencode/deepseek-v4-pro"))).toThrow(/OpenCode Zen \(pay-per-use\)/);
  });

  it.each(["anthropic/claude-x", "openai-codex/gpt-5", "openrouter/x", "OpenAI/x"])("rejects %s", (model) => {
    expect(() => parseProfile(withImplement(model))).toThrow(/is not allowed/);
  });

  it("checks every role, and denies Zen even without a pin", () => {
    expect(() => parseProfile(rolesYaml({ evaluate: "[{ model: opencode/x }]" }))).toThrow(/Zen/);
    expect(() => parseProfile(rolesYaml({ evaluate: "[{ model: anthropic/x }]" }))).not.toThrow();
  });

  it("every shipped profile passes the allowlist", () => {
    const dir = join(import.meta.dirname, "..", "..", "profiles");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) expect(() => loadProfile(join(dir, f))).not.toThrow();
  });
});

describe("billing", () => {
  it("metered providers keep their USD cost; subscriptions report tokens only", () => {
    const profile = { billing: { "opencode-go": "subscription", openai: "subscription" } } as unknown as Parameters<typeof billedUsage>[2];
    expect(billedUsage("anthropic/x", { tokens_in: 3, tokens_out: 1, cost_usd: 0.2 }, profile)).toEqual({ tokens_in: 3, tokens_out: 1, cost_usd: 0.2, billing: "metered" });
    expect(billedUsage("opencode-go/m", { tokens_in: 3, tokens_out: 1, cost_usd: 0.2 }, profile)).toEqual({ tokens_in: 3, tokens_out: 1, cost_usd: 0, billing: "subscription" });
    expect(billedUsage("openai/m", undefined, profile)).toEqual({ cost_usd: 0, billing: "subscription" });
  });
});
