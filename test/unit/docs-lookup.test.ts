import { describe, expect, it } from "vitest";
import { Context7Client, context7Probe, docsTools, docsUnavailableUntil, parseRetryAfter, type FetchLike, MAX_DOC_CHARS } from "../../src/docs/context7.js";
import { docsLookupCheck } from "../../src/commands/doctor.js";
import { buildAgentEnv } from "../../src/agents/env.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { parseLayer, resolveProfile, loadLayers } from "../../src/config.js";
import { mkdtempSync, readFileSync } from "node:fs";
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

  it("parses Retry-After as seconds, implausible milliseconds, or an HTTP date", () => {
    const now = Date.parse("2026-04-08T00:00:00.000Z");
    expect(parseRetryAfter("30", now)?.retryAt).toBe(now + 30_000);
    // 1733683s is about 20 days; that header value is milliseconds.
    expect(parseRetryAfter("1733683", now)?.retryAt).toBe(now + 1_733_683);
    expect(docsUnavailableUntil(now + 1_733_683)).toBe("docs lookup unavailable until 2026-04-08T00:28:53.683Z");
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now)?.retryAt).toBe(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"));
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
  });

  it("maps errors to results the model can continue from", async () => {
    const now = Date.parse("2026-04-08T00:00:00.000Z");
    let calls = 0;
    const limited = new Context7Client({
      now: () => now,
      fetch: fakeFetch(() => {
        calls++;
        return [429, "{}", { "retry-after": "1733683" }];
      }).fetch,
    });
    const first = await limited.lookup({ library: "zod", topic: "x" });
    expect(first).toEqual({ status: "rate_limited", text: "docs lookup unavailable until 2026-04-08T00:28:53.683Z", tokens: 0 });
    const second = await limited.lookup({ library: "other", topic: "y" });
    expect(second.text).toBe(first.text);
    expect(calls).toBe(1);
    const probe = await context7Probe(limited, now);
    expect(probe.detail).toBe("anonymous rate limit reached (no CONTEXT7_API_KEY set); docs lookup unavailable until 2026-04-08T00:28:53.683Z");
    expect(probe.detail).not.toContain("1733683s");
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
    const limited = docsTools(new Context7Client({ fetch: fakeFetch(() => [429, "{}", { "retry-after": "30" }]).fetch }), () => {});
    const blocked = await limited.call("docs_lookup", { library: "zod", topic: "safeParse" });
    expect(blocked.isError).toBeUndefined();
    expect(blocked.text).toMatch(/^docs lookup unavailable until /);
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

  it("doctor probe: a key that is accepted but out of quota is not reported as missing or rejected", async () => {
    const now = Date.parse("2026-04-08T00:00:00.000Z");
    const limited = () => fakeFetch(() => [429, "{}", { "retry-after": "30" }]).fetch;
    const withKey = await context7Probe(new Context7Client({ apiKey: KEY, fetch: limited() }), now);
    expect(withKey.status).toBe("warn");
    expect(withKey.detail).toBe("CONTEXT7_API_KEY accepted, quota exhausted; docs lookup unavailable until 2026-04-08T00:00:30.000Z");
    expect(withKey.detail).not.toContain(KEY);

    const anonymous = await context7Probe(new Context7Client({ fetch: limited() }), now);
    expect(anonymous.detail).toMatch(/no CONTEXT7_API_KEY set/);
    expect(anonymous.detail).not.toMatch(/accepted/);

    const rejected = await context7Probe(new Context7Client({ apiKey: KEY, fetch: fakeFetch(() => [403, "{}"]).fetch }));
    expect(rejected).toEqual({ status: "fail", detail: "CONTEXT7_API_KEY rejected (403)" });
    expect(rejected.detail).not.toContain(KEY);
  });

  it("doctor probe: a network failure still says whether the key is configured, never its value", async () => {
    const down = () => {
      throw new Error("ENOTFOUND context7.com");
    };
    const configured = await context7Probe(new Context7Client({ apiKey: KEY, fetch: down as unknown as FetchLike }));
    const configuredDetail = "unreachable (ENOTFOUND context7.com); CONTEXT7_API_KEY is set (value not shown); docs_lookup returns errors to agents";
    const unsetDetail = "unreachable (ENOTFOUND context7.com); no CONTEXT7_API_KEY in the environment; docs_lookup returns errors to agents";
    expect(configured).toEqual({ status: "warn", detail: configuredDetail });
    expect(configured.detail).not.toContain(KEY);
    const unset = await context7Probe(new Context7Client({ fetch: down as unknown as FetchLike }));
    expect(unset).toEqual({ status: "warn", detail: unsetDetail });
    const roles = ["plan", "implement", "fix"];
    const doctor = await docsLookupCheck(new Context7Client({ apiKey: KEY, fetch: down as unknown as FetchLike }), roles);
    const doctorSet = `Context7 for ${roles.join(", ")}: ${configuredDetail}`;
    const doctorUnset = `Context7 for ${roles.join(", ")}: ${unsetDetail}`;
    expect(doctor).toEqual({ name: "docs_lookup", status: "warn", detail: doctorSet });
    expect((await docsLookupCheck(new Context7Client({ fetch: down as unknown as FetchLike }), roles)).detail).toBe(doctorUnset);
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const startup = readme.slice(readme.indexOf("### Getting the key into the worker"), readme.indexOf("## Secrets"));
    const scriptStart = startup.indexOf("#!/bin/sh");
    const script = startup.slice(scriptStart, startup.indexOf("```", scriptStart));
    expect(startup).toContain(doctorSet);
    expect(startup).toContain(doctorUnset);
    expect(script).not.toMatch(/--client-secret|--client-id|--token=/);
    expect(script).toContain('export CONTEXT7_API_KEY="$key"');
    expect(script).toContain('--path="$INFISICAL_SECRET_PATH"');
    expect(script).not.toMatch(/\becho\b/);
    expect(startup).toContain("launchctl bootout");
    expect(startup).toContain("launchctl bootstrap");
    expect(startup).not.toMatch(/exported by the host/);
    expect(startup).toContain("does not exclude imported secrets");
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
