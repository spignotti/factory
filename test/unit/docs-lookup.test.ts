import { describe, expect, it } from "vitest";
import { Context7Client, context7Probe, docsTools, type FetchLike, MAX_DOC_CHARS } from "../../src/docs/context7.js";
import { docsLookupCheck } from "../../src/commands/doctor.js";
import { buildAgentEnv } from "../../src/agents/env.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { parseLayer, resolveProfile, loadLayers } from "../../src/config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "ctx7sk-test-key-0123456789";

interface Seen {
  url: URL;
  headers: Record<string, string>;
  redirect: string;
}

/** Fake Context7: `routes` maps a path to [status, body, headers]. */
function fakeFetch(routes: (url: URL) => [number, string, Record<string, string>?]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (href, init) => {
    const url = new URL(href);
    seen.push({ url, headers: init.headers, redirect: init.redirect });
    const [status, body, headers = {}] = routes(url);
    return { status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body };
  };
  return { fetch, seen };
}

const search = JSON.stringify({ results: [{ id: "/colinhacks/zod", title: "Zod", versions: ["v4.0.1"] }, { id: "/websites/zod_dev", title: "Zod docs" }] });

describe("Context7 client (docs_lookup)", () => {
  it("resolves a library name, then fetches docs; only context7.com, no redirects, no key header without a key", async () => {
    const f = fakeFetch((u) => (u.pathname === "/api/v2/libs/search" ? [200, search] : [200, "### safeParse\nReturns a result."]));
    const r = await new Context7Client({ fetch: f.fetch }).lookup({ library: "zod", topic: "safeParse" });
    expect(r).toMatchObject({ status: "ok", library_id: "/colinhacks/zod" });
    expect(r.text).toContain("Library: /colinhacks/zod (Zod); other matches: /websites/zod_dev");
    expect(r.text).toContain("Returns a result.");
    expect(r.tokens).toBeGreaterThan(0);
    expect(f.seen.map((s) => `${s.url.origin}${s.url.pathname}`)).toEqual(["https://context7.com/api/v2/libs/search", "https://context7.com/api/v2/context"]);
    expect(f.seen[1]!.url.searchParams.get("libraryId")).toBe("/colinhacks/zod");
    expect(f.seen[1]!.url.searchParams.get("type")).toBe("txt");
    expect(f.seen.every((s) => s.redirect === "manual" && !("authorization" in s.headers))).toBe(true);
  });

  it("sends the key as a bearer token when configured; an id skips resolve; version is appended", async () => {
    const f = fakeFetch(() => [200, "docs"]);
    const client = Context7Client.fromEnv({ CONTEXT7_API_KEY: KEY }, f.fetch);
    const r = await client.lookup({ library: "/vercel/next.js", topic: "app router", version: "v16.2.9" });
    expect(r.status).toBe("ok");
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.url.searchParams.get("libraryId")).toBe("/vercel/next.js/v16.2.9");
    expect(f.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // the key never shows up in what the model gets
    expect(r.text).not.toContain(KEY);
  });

  it("caches repeated lookups, truncates long docs and follows a 301 library move by id", async () => {
    let n = 0;
    const f = fakeFetch((u) => {
      n++;
      if (u.searchParams.get("libraryId") === "/old/lib") return [301, JSON.stringify({ redirectUrl: "/new/lib" })];
      return [200, "x".repeat(MAX_DOC_CHARS + 100)];
    });
    const client = new Context7Client({ fetch: f.fetch });
    const a = await client.lookup({ library: "/old/lib", topic: "t" });
    const b = await client.lookup({ library: "/old/lib", topic: "t" });
    expect(a.library_id).toBe("/old/lib");
    expect(a.text).toContain("(truncated; ask a narrower topic)");
    expect(b.cached).toBe(true);
    expect(n).toBe(2);
    expect(f.seen[1]!.url.searchParams.get("libraryId")).toBe("/new/lib");
  });

  it("maps errors to results the model can continue from", async () => {
    const limited = new Context7Client({ fetch: fakeFetch(() => [429, "{}", { "retry-after": "30" }]).fetch });
    expect(await limited.lookup({ library: "zod", topic: "x" })).toMatchObject({ status: "rate_limited", tokens: 0 });
    const none = new Context7Client({ fetch: fakeFetch(() => [200, JSON.stringify({ results: [] })]).fetch });
    expect((await none.lookup({ library: "nope", topic: "x" })).status).toBe("not_found");
    const down = new Context7Client({ fetch: async () => { throw new Error("ENOTFOUND context7.com"); } });
    const r = await down.lookup({ library: "zod", topic: "x" });
    expect(r.status).toBe("error");
    expect(r.text).toMatch(/Continue without it/);
  });

  it("the tool reports every call (library, topic, tokens) and rejects empty input", async () => {
    const calls: unknown[] = [];
    const tools = docsTools(new Context7Client({ fetch: fakeFetch((u) => (u.pathname.endsWith("search") ? [200, search] : [200, "abcd".repeat(10)])).fetch }), (c) => calls.push(c));
    expect(tools.specs.map((s) => s.name)).toEqual(["docs_lookup"]);
    expect((await tools.call("docs_lookup", { library: "zod", topic: "safeParse" })).isError).toBeUndefined();
    expect((await tools.call("docs_lookup", { library: "", topic: "x" })).isError).toBe(true);
    expect(calls).toEqual([{ library: "zod", library_id: "/colinhacks/zod", topic: "safeParse", tokens: 10, status: "ok" }]);
  });

  it("doctor: reachable anonymously, key rejected, unreachable, off", async () => {
    const ok = await docsLookupCheck(new Context7Client({ fetch: fakeFetch(() => [200, search, { "ratelimit-remaining": "190" }]).fetch }), ["plan"]);
    expect(ok).toMatchObject({ status: "ok" });
    expect(ok.detail).toMatch(/without API key.*190 requests left/);
    const bad = await context7Probe(new Context7Client({ apiKey: KEY, fetch: fakeFetch(() => [401, "{}"]).fetch }));
    expect(bad).toEqual({ status: "fail", detail: "CONTEXT7_API_KEY rejected (401)" });
    const down = await context7Probe(new Context7Client({ fetch: async () => { throw new Error("offline"); } }));
    expect(down.status).toBe("warn");
    expect((await docsLookupCheck(new Context7Client(), [])).status).toBe("info");
  });

  it("CONTEXT7_API_KEY never reaches agent tool processes, even when allowlisted", () => {
    const env = buildAgentEnv({ PATH: "/bin", CONTEXT7_API_KEY: KEY }, { home: "/tmp/h", extra: ["CONTEXT7_API_KEY"] });
    expect(Object.values(env)).not.toContain(KEY);
  });

  it("roles: default plan, implement, fix; a profile layer or repo.yaml replaces the list", () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    expect(resolveProfile(loadLayers({ factoryHome: home })).docs_lookup.roles).toEqual(["plan", "implement", "fix"]);
    const off = resolveProfile([...loadLayers({ factoryHome: home }), parseLayer("cli", "x.yaml", "docs_lookup: { roles: [] }")]);
    expect(off.docs_lookup.roles).toEqual([]);
    expect(parseRepoConfig("docs_lookup: { roles: [plan, review] }").docs_lookup?.roles).toEqual(["plan", "review"]);
    expect(() => parseRepoConfig("docs_lookup: { roles: [nope] }")).toThrow();
  });
});
