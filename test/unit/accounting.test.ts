import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, statsCommand } from "../../src/commands/stats.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import type { FactoryEvent, RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import { classifyWait, dedupeRuns, observeMerge, roundKinds } from "../../src/pipeline/accounting.js";
import { buildOutcome } from "../../src/pipeline/outcome.js";
import type { RunRecord } from "../../src/runs.js";
import { automationCoverage } from "../../src/standards.js";
import { resolvePlanEffort } from "../../src/steps/intake.js";

const FROM = new Date("2026-11-12T00:00:00Z");
const TO = new Date("2026-11-13T00:00:00Z");
const START = new Date("2026-11-12T10:00:00Z");

function stored(over: Partial<RunResult> & Pick<RunResult, "run_id">): RunResult {
  return {
    repo: "/r",
    task: "t",
    type: "feature",
    lane: "standard",
    result: "done",
    risk: "low",
    merge_policy: "auto",
    pr: null,
    rounds: 1,
    minutes: 1,
    cost_usd: 0,
    reason: "",
    branch: null,
    worktree: null,
    run_dir: "/runs/x",
    ...over,
  };
}

function record(result: RunResult, events: FactoryEvent[] = []): RunRecord & { events: FactoryEvent[] } {
  return { run_id: result.run_id, dir: `/runs/${result.run_id}`, started_at: START, result, events };
}

function ev(runId: string, event: FactoryEvent["event"], data: Record<string, unknown> = {}, extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: "2026-11-12T10:00:00.000Z",
    run_id: runId,
    step: "implement",
    event,
    role: null,
    model: null,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    data,
    ...extra,
  };
}

describe("F07 close", () => {
  it("classifies waits and keeps replan, retry and review out of those classes", () => {
    expect(classifyWait("after #3")).toBe("dependency");
    expect(classifyWait("dependency cycle: #1 -> #2 -> #1")).toBe("dependency");
    expect(classifyWait("global coding cap")).toBe("capacity");
    expect(classifyWait("resource db held by run 20261112-120000-aaaaaa (pid 9)")).toBe("capacity");
    expect(classifyWait("CI pending")).toBe("ci_runner");
    expect(classifyWait("CI on main is red", "base_red")).toBe("ci_runner");
    expect(classifyWait("Connection error.")).toBe("provider");
    expect(classifyWait("provider capacity")).toBe("provider");
    expect(classifyWait("stalemate: x", "needs_human")).toBe("human_decision");
    expect(classifyWait("needs a decision")).toBe("human_decision");
    expect(classifyWait("format the file")).toBe("technical_repair");
    expect(classifyWait("replan")).toBe("unclassified");
    expect(classifyWait("review round 2")).toBe("unclassified");
    expect(classifyWait("retry")).toBe("unclassified");
    const rounds = roundKinds([
      ev("r", "step_started", {}, { step: "plan_high" }),
      ev("r", "step_started", {}, { step: "plan_high" }),
      ev("r", "model_retry"),
      ev("r", "step_retry"),
      ev("r", "agent_finished", {}, { role: "review_diff" }),
    ]);
    expect(rounds).toEqual({ replan: 1, retry: 2, review: 1 });
  });

  it("V18: a done unmerged run and an external merge of unknown origin do not count as autonomous, and the same login is not proof", () => {
    expect(observeMerge({ stored: "no", github: "open", actorLogin: "silas", factoryLogin: "silas" })).toEqual({ autonomous: false, presentation: "unmerged" });
    expect(observeMerge({ stored: "no", github: "merged", actorLogin: "silas", factoryLogin: "silas" })).toEqual({ autonomous: false, presentation: "unknown_origin" });
    expect(observeMerge({ stored: "unknown", github: "merged", actorLogin: "silas", factoryLogin: "other" })).toEqual({ autonomous: false, presentation: "unknown_origin" });
    expect(observeMerge({ stored: "no", github: "closed", actorLogin: "silas", factoryLogin: "silas" })).toEqual({ autonomous: false, presentation: "closed_without_merge" });
    expect(observeMerge({ stored: "confirmed", github: "merged", actorLogin: "silas", factoryLogin: "silas" }).autonomous).toBe(true);
    expect(observeMerge({ stored: "confirmed", github: "merged", actorLogin: "someone-else", factoryLogin: "silas" }).autonomous).toBe(true);
    expect(observeMerge({ stored: "confirmed", github: "open" })).toEqual({ autonomous: false, presentation: "unmerged" });
    expect(observeMerge({ stored: "confirmed", github: "closed" })).toEqual({ autonomous: false, presentation: "closed_without_merge" });

    const id = "20261112-100000-aaaaaa";
    const kept = stored({
      run_id: id,
      minutes: 5,
      pr: "https://pr/confirmed",
      outcome: { ...buildOutcome({ ticket: 1, attempts: 2, pr: "https://pr/confirmed", result: "done" }), merged: "confirmed" },
    });
    const dropped = stored({
      run_id: id,
      minutes: 50,
      pr: "https://pr/confirmed",
      outcome: { ...buildOutcome({ ticket: 1, attempts: 1, pr: "https://pr/confirmed", result: "done" }), merged: "confirmed" },
    });
    const unmerged = stored({
      run_id: "20261112-100100-bbbbbb",
      minutes: 9,
      pr: "https://pr/open",
      reason: "after #3",
      outcome: buildOutcome({ ticket: 2, attempts: 1, pr: "https://pr/open", result: "done" }),
    });
    const parked = stored({
      run_id: "20261112-100200-cccccc",
      result: "needs_human",
      minutes: 1,
      reason: "global coding cap",
      outcome: buildOutcome({ ticket: 3, attempts: 1, pr: null, result: "needs_human" }),
    });
    const logs = new Map<string, FactoryEvent[]>([
      [id, [
        ev(id, "progress", { waited_ms: 120_000 }, { ts: "2026-11-12T10:02:00.000Z" }),
        ev(id, "run_finished", { merged_at: "2026-11-12T10:40:00.000Z" }, { ts: "2026-11-12T10:40:00.000Z" }),
        ev(id, "step_started", {}, { step: "plan_high" }),
        ev(id, "step_started", {}, { step: "plan_high" }),
        ev(id, "model_retry"),
        ev(id, "agent_finished", {}, { role: "review_diff" }),
      ]],
      [unmerged.run_id, [ev(unmerged.run_id, "run_finished", { merged_at: "2026-11-12T11:00:00.000Z" }, { ts: "2026-11-12T10:20:00.000Z" })]],
    ]);
    const rows = [record(dropped), record(kept), record(unmerged), record(parked)];
    expect(dedupeRuns(rows).map((row) => row.result?.outcome?.attempts)).toEqual([2, 1, 1]);
    const period = aggregate(rows, FROM, TO, (run) => logs.get(run.run_id) ?? []);
    expect(period.runs).toBe(3);
    expect(period.auto_merged).toBe(1);
    expect(period.outcomes.confirmed_merges).toBe(1);
    expect(period.outcomes.merges_unknown).toBe(0);
    expect(period.outcomes.attempts).toBe(4);
    expect(period.outcomes.delivered_prs).toBe(2);
    expect(period.reverted).toBeNull();
    expect(period.time.summed_run_minutes).toBe(15);
    expect(period.time.wall_clock_minutes).toBe(40);
    expect(period.time.summed_run_minutes).not.toBe(period.time.wall_clock_minutes);
    expect(period.time.active_minutes).toEqual({ median: 5, p90: 9 });
    expect(period.time.wait_minutes).toEqual({ median: 2, p90: 2 });
    expect(period.time.time_to_merge_minutes).toEqual({ median: 40, p90: 40 });
    expect(period.waits.dependency).toBe(1);
    expect(period.waits.capacity).toBe(1);
    expect(period.waits.technical_repair).toBe(0);
    expect(period.round_kinds).toEqual({ replan: 1, retry: 1, review: 1 });

    const recovery = aggregate(
      [record(stored({ run_id: id, minutes: 4, rounds: 2, outcome: buildOutcome({ ticket: 9, attempts: 2, pr: null, result: "needs_human" }), result: "needs_human" }))],
      FROM,
      TO,
    );
    const gates = aggregate(
      [record(stored({ run_id: "20261112-110000-f05aaa", minutes: 9 }), [ev("20261112-110000-f05aaa", "gate_result", { check: "unit", status: "fail" })])],
      FROM,
      TO,
      (run) => (run as { events?: FactoryEvent[] }).events ?? [],
    );
    const schedule = aggregate(
      [record(stored({ run_id: "20261112-120000-f08aaa", result: "needs_human", reason: "after #8", minutes: 0, outcome: buildOutcome({ ticket: 8, attempts: 1, pr: null, result: "needs_human" }) }))],
      FROM,
      TO,
    );
    for (const sample of [recovery, gates, schedule]) {
      expect(sample.time).toBeDefined();
      expect(sample.waits).toBeDefined();
      expect(sample.round_kinds).toBeDefined();
      expect(sample.outcomes).toBeDefined();
      expect(sample.reverted).toBeNull();
    }
    expect(recovery.outcomes.attempts).toBe(2);
    expect(recovery.runs).toBe(1);
    expect(gates.gate_failures).toEqual({ unit: 1 });
    expect(gates.time.summed_run_minutes).toBe(9);
    expect(gates.runs).toBe(1);
    expect(schedule.waits.dependency).toBe(1);
    expect(schedule.auto_merged).toBe(0);
    expect(schedule.outcomes.confirmed_merges).toBe(0);
  });

  it("V18: status separates an unknown GitHub merge, a closed PR, and a confirmed merge, and links artifacts", async () => {
    expect(resolvePlanEffort(undefined, [])).toBe("high");
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    mkdirSync(join(repo, ".factory"), { recursive: true });
    writeFileSync(join(repo, ".factory", "repo.yaml"), "checks:\n  - { name: lint, run: pnpm lint, tier: fast }\n");
    writeFileSync(
      join(repo, ".factory", "standards.md"),
      "# Standards\n\n## Rules\n\n- Sources are formatted <!-- check: lint -->\n- Secrets stay out of logs <!-- check: missing -->\n- A person reads the product diff\n",
    );
    const confirmed = "20261112-100000-cccc01";
    const external = "20261112-100100-cccc02";
    const closed = "20261112-100200-cccc03";
    const open = "20261112-100300-cccc04";
    const human = "20261112-100400-cccc05";
    const prs = {
      confirmed: "https://github.test/pull/31",
      external: "https://github.test/pull/32",
      closed: "https://github.test/pull/33",
      open: "https://github.test/pull/34",
    };
    const write = (id: string, result: string, pr: string | null, outcome?: RunResult["outcome"]) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `#${id}`, title: "t", text: "", labels: [] }, no_pr: false,
        step: "finished", result, reason: result === "needs_human" ? "which file?" : "", branch: null, worktree: null, pr,
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        run_id: id, repo, task: `#${id}`, type: "feature", lane: "standard", result, risk: "low",
        merge_policy: "auto", pr, rounds: 1, minutes: 3, cost_usd: 0, reason: result === "needs_human" ? "which file?" : "",
        branch: null, worktree: null, run_dir: dir,
        ...(outcome ? { outcome } : {}),
        ...(id === confirmed ? { provenance: { factory_version: "0.5.0", factory_commit: "abc", prompt_revision: "deadbeef", model: "opencode-go/deepseek-v4-pro", effort: "high", config_fingerprint: "0123456789abcdef", base: null, head: null, checks: [] } } : {}),
      }));
      if (id === confirmed) writeFileSync(join(dir, "recovery.json"), "{}\n");
    };
    write(confirmed, "done", prs.confirmed, { ...buildOutcome({ ticket: 31, attempts: 1, pr: prs.confirmed, result: "done" }), merged: "confirmed" });
    write(external, "done", prs.external);
    write(closed, "done", prs.closed, buildOutcome({ ticket: 33, attempts: 1, pr: prs.closed, result: "done" }));
    write(open, "done", prs.open, buildOutcome({ ticket: 34, attempts: 1, pr: prs.open, result: "done" }));
    write(human, "needs_human", null, buildOutcome({ ticket: 35, attempts: 1, pr: null, result: "needs_human" }));
    const github = new FakeGitHub();
    github.prStates.set(prs.confirmed, { state: "merged", draft: false, ci: "green" });
    github.prStates.set(prs.external, { state: "merged", draft: false, ci: "green" });
    github.prStates.set(prs.closed, { state: "closed", draft: false, ci: "green" });
    github.prStates.set(prs.open, { state: "open", draft: false, ci: "green" });
    const report = await statusReport({ factoryHome: home, github, now: () => Date.parse("2026-11-12T12:00:00Z") });
    expect(report.brief.actually_merged).toEqual([
      { run_id: confirmed, pr: prs.confirmed, origin: "confirmed" },
      { run_id: external, pr: prs.external, origin: "unknown" },
    ]);
    expect(report.brief.closed_without_merge).toEqual([{ run_id: closed, pr: prs.closed }]);
    expect(report.brief.actually_merged.map((row) => row.pr)).not.toContain(prs.open);
    expect(report.brief.actually_merged.map((row) => row.pr)).not.toContain(prs.closed);
    expect(report.brief.needs_silas.map((row) => row.run_id)).toContain(human);
    expect(report.brief.artifacts.join("\n")).toContain("recovery.json");
    expect(report.brief.artifacts.join("\n")).toContain("effort high");
    expect(report.brief.artifacts.join("\n")).toContain("prompt deadbeef");
    expect(report.automation).toEqual([
      expect.objectContaining({
        full: [],
        partial: ["Sources are formatted"],
        review_scope: ["Sources are formatted", "Secrets stay out of logs", "A person reads the product diff"],
      }),
    ]);
    const text = renderStatus(report);
    expect(text).toContain("running:");
    expect(text).toContain("waiting on:");
    expect(text).toContain(`${prs.external} (origin unknown)`);
    expect(text).not.toContain(`${prs.external} (autonomous merge)`);
    expect(text).toContain(`${prs.confirmed} (autonomous merge)`);
    expect(text).toContain("closed without merge:");
    expect(text).toContain(prs.closed);
    expect(text).toContain("needs Silas:");
    expect(text).toContain("which file?");
    expect(text).toContain("full 0, partial 1, review scope 3");
    expect(text).not.toContain("determinism_ratio");
    expect(text).toContain(`${join(home, "runs", confirmed, "result.json")}`);

    const lines: string[] = [];
    statsCommand({ factoryHome: home, since: "7d", json: false, now: () => Date.parse("2026-11-12T12:00:00Z") }, { out: (line) => lines.push(line), err: () => {} });
    const stats = lines.join("");
    expect(stats).toContain("confirmed merges 1");
    expect(stats).toContain("not wall-clock");
    expect(stats).toContain("a zero price is not an efficiency proof");
    expect(stats).toContain("regressions: unknown");
    expect(stats).not.toMatch(/regressions:\s*0/);
    expect(stats).toContain("subscription:");
    const current = aggregate(
      [
        record(stored({ run_id: confirmed, minutes: 3, pr: prs.confirmed, outcome: { ...buildOutcome({ ticket: 31, attempts: 1, pr: prs.confirmed, result: "done" }), merged: "confirmed" } })),
        record(stored({ run_id: confirmed, minutes: 3, pr: prs.confirmed, outcome: { ...buildOutcome({ ticket: 31, attempts: 1, pr: prs.confirmed, result: "done" }), merged: "confirmed" } })),
      ],
      FROM,
      TO,
      () => [ev(confirmed, "agent_finished", { billing: "subscription" }, { model: "opencode-go/kimi", tokens_in: 10, tokens_out: 4, cost_usd: 9 })],
    );
    expect(current.runs).toBe(1);
    expect(current.auto_merged).toBe(1);
    expect(current.cost_usd).toBe(0);
    expect(current.subscription_tokens).toEqual({ tokens_in: 10, tokens_out: 4 });
  });

  it("automation coverage is full, partial and review scope", () => {
    const checks = [{ name: "lint", run: "pnpm lint", tier: "fast" as const }];
    const coverage = automationCoverage(
      [
        { line: 1, text: "Sources are formatted", check: "lint" },
        { line: 2, text: "Secrets stay out of logs", check: "missing" },
        { line: 3, text: "A person reads the product diff" },
      ],
      checks,
    );
    expect(coverage).toEqual({
      full: [],
      partial: ["Sources are formatted"],
      review_scope: ["Sources are formatted", "Secrets stay out of logs", "A person reads the product diff"],
    });
    expect(coverage).not.toHaveProperty("determinism_ratio");
  });
});
