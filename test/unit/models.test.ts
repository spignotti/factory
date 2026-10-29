import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { backoffMs, billedUsage, callModel, chainFor, classifyError, InvalidOutputError } from "../../src/agents/models.js";
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
    [new Error("socket hang up"), "network"],
    [new Error("terminated"), "network"],
    [new Error("read ECONNRESET"), "network"],
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
