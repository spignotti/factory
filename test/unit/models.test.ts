import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { backoffMs, callModel, chainFor, classifyError, InvalidOutputError } from "../../src/agents/models.js";
import { AgentError } from "../../src/agents/runner.js";
import { EventLog } from "../../src/events.js";
import { loadProfile, parseProfile } from "../../src/schemas/profile.js";

const profile = parseProfile(`
roles:
  plan_high: [{ model: openai/sol, thinking: high }, { model: opencode-go/grok-4.7 }]
  plan_medium: [{ model: openai/sol }]
  plan_normalize: [{ model: opencode-go/deepseek-v4.1-flash }]
  implement: [{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/deepseek-v4-pro }]
  review: [{ model: openai/codex }, { model: opencode-go/grok-4.7 }]
  pr_writer: [{ model: opencode-go/deepseek-v4.1-flash }]
retry: { base_ms: 100, max_ms: 250, attempts: 3 }
`);

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
    [new AgentError("error: ttft_admission_refused"), "capacity"],
    [new AgentError("503 Service Unavailable, please retry shortly", undefined, 503), "capacity"],
    [new AgentError("429", undefined, 429, 5000), "capacity"],
    [new AgentError("429 Too Many Requests", undefined, 429), "limit"],
    [new AgentError("You exceeded your current quota"), "limit"],
    [new AgentError("usage limit reached"), "limit"],
    [new AgentError("401 Unauthorized", undefined, 401), "auth"],
    [new AgentError("invalid api key"), "auth"],
    [new InvalidOutputError("handoff invalid"), "invalid_output"],
    [new AgentError("500 internal error", undefined, 500), "other"],
    [new Error("socket hang up"), "other"],
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
    expect(ev[0]).toMatchObject({ tokens_in: 10, cost_usd: 0.01, data: { class: "capacity" } });
    expect(ev[5]).toMatchObject({ data: { from: "openai/sol", to: "opencode-go/grok-4.7", class: "capacity" } });
  });

  it("falls back immediately on limit without backoff", async () => {
    const { deps, slept, runner } = setup([
      { role: "review_plan", error: { message: "rate limit", status: 429 } },
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

  it("caps the backoff at max_ms", () => {
    expect([0, 1, 2, 3].map((a) => backoffMs(a, profile.retry))).toEqual([100, 200, 250, 250]);
  });
});

describe("implement model family", () => {
  it("rejects an implement chain that crosses model families at config load", () => {
    expect(() =>
      parseProfile(`
roles:
  plan_high: [{ model: a/x }]
  plan_medium: [{ model: a/x }]
  plan_normalize: [{ model: a/x }]
  implement: [{ model: opencode-go/deepseek-v4.1-flash }, { model: opencode-go/grok-4.7 }]
  review: [{ model: a/x }]
  pr_writer: [{ model: a/x }]
`),
    ).toThrow(/one model family/);
  });

  it("stays within the family at runtime even with an explicit family override", () => {
    const p = { ...profile, roles: { ...profile.roles, implement: [{ model: "a/deepseek-1" }, { model: "b/grok-2" }] } };
    expect(chainFor(p, "implement").map((e) => e.model)).toEqual(["a/deepseek-1"]);
  });

  it("falls back within the implement family", async () => {
    const { deps, runner } = setup([
      { role: "implement", error: { message: "quota exceeded" } },
      { role: "implement", raw: "ok" },
    ]);
    await callModel(deps, "implement", req("implement"));
    expect(runner.calls.map((c) => c.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4-pro"]);
  });

  it("ships a valid default profile", () => {
    expect(loadProfile("default").roles.implement.length).toBeGreaterThan(0);
  });
});
