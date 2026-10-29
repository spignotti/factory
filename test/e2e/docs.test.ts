import { describe, expect, it } from "vitest";
import { Context7Client, type FetchLike } from "../../src/docs/context7.js";
import { runScenario } from "../helpers/scenario.js";

const KEY = "ctx7sk-e2e-key-abcdef0123456789";

function fakeContext7(): { client: Context7Client; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (href) => {
    urls.push(href);
    const u = new URL(href);
    const body = u.pathname.endsWith("/search") ? JSON.stringify({ results: [{ id: "/nodejs/node", title: "Node.js" }] }) : "node:test docs ".repeat(20);
    return { status: 200, headers: { get: () => null }, text: async () => body };
  };
  return { client: new Context7Client({ apiKey: KEY, fetch }), urls };
}

describe("docs_lookup in a run (fake runner, fake Context7)", () => {
  it("plan, implement and fix get the tool, reviewers do not; every call is an event; the key stays in the factory", async () => {
    const c7 = fakeContext7();
    const r = await runScenario({
      script: "clean.json",
      deps: { docs: c7.client, parentEnv: { ...process.env, CONTEXT7_API_KEY: KEY } },
      steps: (steps) => steps.map((s) => (s.role === "implement" ? { ...s, tool_calls: [{ tool: "docs_lookup", args: { library: "node", topic: "node:test assertions" } }] } : s)),
    });
    expect(r.result.result).toBe("done");
    const byRole = Object.fromEntries(r.runner.calls.map((c) => [c.role, c.factoryTools]));
    expect(byRole.plan_high).toEqual(["docs_lookup"]);
    expect(byRole.implement).toEqual(["docs_lookup"]);
    expect(byRole.review_plan).toEqual([]);
    expect(byRole.pr_writer).toEqual([]);
    const impl = r.runner.calls.find((c) => c.role === "implement")!;
    expect(impl.toolResults?.[0]?.text).toContain("Library: /nodejs/node");
    const ev = r.events.filter((e) => e.event === "docs_lookup");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ step: "implement", role: "implement", data: { library: "node", library_id: "/nodejs/node", topic: "node:test assertions", status: "ok" } });
    expect(ev[0]!.data.tokens).toBeGreaterThan(0);
    expect(c7.urls.every((u) => u.startsWith("https://context7.com/"))).toBe(true);
    for (const call of r.runner.calls) expect(Object.values(call.env)).not.toContain(KEY);
    expect(r.eventsText).not.toContain(KEY);
  });

  it("repo.yaml docs_lookup.roles: [] turns the tool off", async () => {
    const r = await runScenario({ script: "clean.json", deps: { docs: fakeContext7().client }, patch: (cfg) => void (cfg.docs_lookup = { roles: [] }) });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.every((c) => c.factoryTools.length === 0)).toBe(true);
  });
});
