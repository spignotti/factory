import { describe, expect, it } from "vitest";
import { Context7Client } from "../../src/docs/context7.js";

/** Live Context7 call (anonymous unless CONTEXT7_API_KEY is set); skipped without network or when rate-limited. */
describe("Context7 live", () => {
  it("resolves zod and returns docs for safeParse", async (ctx) => {
    const client = Context7Client.fromEnv(process.env);
    let reachable: boolean;
    try {
      const probe = await client.get("/api/v2/libs/search", { libraryName: "zod", query: "safeParse" });
      reachable = probe.status === 200;
    } catch {
      reachable = false;
    }
    if (!reachable) ctx.skip();
    const r = await client.lookup({ library: "zod", topic: "safeParse" });
    if (r.status === "rate_limited") ctx.skip();
    expect(r.status).toBe("ok");
    expect(r.library_id).toMatch(/^\//);
    expect(r.text).toMatch(/safeParse/);
  }, 60_000);
});
