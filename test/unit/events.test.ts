import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog, ResultSchema, writeResult } from "../../src/events.js";

describe("events", () => {
  it("appends typed events with all SPEC fields and sums usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    const log = new EventLog(dir, "run-1", () => Date.UTC(2026, 9, 29));
    const seen: string[] = [];
    log.onEvent((e) => seen.push(e.event));
    log.emit({ step: "plan", event: "step_started" });
    log.emit({ step: "plan", event: "agent_error", role: "plan_high", model: "m", tokens_in: 5, tokens_out: 1, cost_usd: 0.5 });
    log.emit({ step: "plan", event: "heartbeat", role: "plan_high", model: "m" });
    const lines = readFileSync(log.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(Object.keys(lines[0]).sort()).toEqual(
      ["cost_usd", "data", "event", "model", "role", "run_id", "step", "tokens_in", "tokens_out", "ts"].sort(),
    );
    expect(lines[0]).toMatchObject({ ts: "2026-10-29T00:00:00.000Z", run_id: "run-1", role: null, tokens_in: 0 });
    expect(seen).toEqual(["step_started", "agent_error", "heartbeat"]);
    expect(log.totals).toEqual({ tokens_in: 5, tokens_out: 1, cost_usd: 0.5 });
  });

  it("writes result.json as one validated line", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-"));
    const path = join(dir, "result.json");
    const result = {
      run_id: "r", repo: "/x", task: "#12", type: "bug" as const, lane: "standard" as const, result: "done" as const,
      risk: "low" as const, merge_policy: "human_review" as const, pr: "https://pr", rounds: 1, minutes: 4.2,
      cost_usd: 0.03, reason: "",
    };
    writeResult(path, result);
    const text = readFileSync(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(ResultSchema.parse(JSON.parse(text))).toEqual(result);
    expect(() => writeResult(path, { ...result, result: "weird" as never })).toThrow();
  });
});
