import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { AgentError, type AgentRequest, extractJson } from "../../src/agents/runner.js";

const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  role: "implement", model: "p/m", cwd: mkdtempSync(join(tmpdir(), "fr-")), system: "", prompt: "go",
  tools: "coding", env: {}, ...over,
});

describe("fake runner", () => {
  it("returns scripted JSON, writes files and records calls", async () => {
    const r = new FakeRunner([
      { role: "implement", output: { package: "P1" }, writes: { "src/a.js": "x", "gone.txt": null }, usage: { tokens_in: 3, tokens_out: 2, cost_usd: 0 } },
    ]);
    const rq = req();
    writeFileSync(join(rq.cwd, "gone.txt"), "y");
    const res = await r.run(rq);
    expect(extractJson(res.text)).toEqual({ package: "P1" });
    expect(readFileSync(join(rq.cwd, "src/a.js"), "utf8")).toBe("x");
    expect(existsSync(join(rq.cwd, "gone.txt"))).toBe(false);
    expect(res.usage.tokens_in).toBe(3);
    expect(r.calls[0]?.role).toBe("implement");
    expect(r.remaining()).toEqual({});
  });

  it("loads scripts from fixture files", async () => {
    const r = FakeRunner.fromFile(join(import.meta.dirname, "../fixtures/scripts/unit-fake.json"));
    expect((await r.run(req({ role: "pr_writer" }))).text).toBe("Summary text.");
  });

  it("simulates errors with usage, invalid output, and a wrong model", async () => {
    const r = new FakeRunner([
      { role: "implement", error: { message: "at capacity", status: 503 }, usage: { tokens_in: 7, tokens_out: 0, cost_usd: 0 } },
      { role: "implement", raw: "not json" },
      { role: "implement", model: "x/y", raw: "" },
    ]);
    const err = await r.run(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).usage.tokens_in).toBe(7);
    expect((err as AgentError).status).toBe(503);
    expect(extractJson((await r.run(req())).text)).toBeUndefined();
    await expect(r.run(req())).rejects.toThrow(/expected model x\/y/);
    await expect(r.run(req())).rejects.toThrow(/no scripted step/);
  });

  it("emits heartbeats while slow", async () => {
    const slept: number[] = [];
    const r = new FakeRunner([{ role: "implement", heartbeats: { count: 3, interval_ms: 1000 }, raw: "ok" }], async (ms) => {
      slept.push(ms);
    });
    const kinds: string[] = [];
    await r.run(req({ onActivity: (a) => kinds.push(a.kind) }));
    expect(slept).toEqual([1000, 1000, 1000]);
    expect(kinds).toEqual(["heartbeat", "heartbeat", "heartbeat", "progress"]);
  });
});

describe("extractJson", () => {
  it("takes the last fenced block, or a bare object", () => {
    expect(extractJson("a\n```json\n{\"a\":1}\n```\nb\n```json\n{\"b\":2}\n```")).toEqual({ b: 2 });
    expect(extractJson("Here: {\"c\": 3} done")).toEqual({ c: 3 });
    expect(extractJson("```factory-plan\n{\"d\":4}\n```")).toEqual({ d: 4 });
  });
});
