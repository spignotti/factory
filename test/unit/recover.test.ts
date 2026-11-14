import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueRevision } from "../../src/queue/admit.js";
import { factKey, recoverApply, recoverPreview, type RecoverFacts } from "../../src/queue/recover.js";
import { loadAllQueues, repoQueueKey, saveQueue, type QueueEntry } from "../../src/queue/store.js";
import { gateLimit, stopCauseForBudget } from "../../src/pipeline/recovery.js";
import { requestPause } from "../../src/queue/pause.js";
import { createFixtureRepo } from "../helpers/repo.js";

const TITLE = "Multiply";
const BODY = "Add multiply.";
const RUN = "20261114-120000-aaaaaa";
const OTHER = "20261114-120001-bbbbbb";
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

function rev(): string {
  return issueRevision(TITLE, BODY);
}

function entry(issue: number, extra: Partial<QueueEntry> = {}): QueueEntry {
  return { issue, status: "parked", added_at: "2026-11-14T00:00:00.000Z", run_id: RUN, issue_rev: rev(), requeues: 1, ...extra };
}

function stop(cause: string, action: string): { cause: string; action: string } {
  return { cause, action };
}

async function home(entries: QueueEntry[], runs: { id: string; state: Record<string, unknown>; result?: Record<string, unknown>; checkpoint?: boolean }[] = []) {
  const repo = createFixtureRepo();
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-recover-"));
  const key = await repoQueueKey(repo);
  for (const run of runs) {
    const dir = join(factoryHome, "runs", run.id);
    mkdirSync(dir, { recursive: true });
    if (run.checkpoint !== false) {
      writeFileSync(join(dir, "plan.json"), "{}\n");
      mkdirSync(join(dir, "worktree"));
    }
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, step: "review", repo, ...run.state }, null, 2));
    if (run.result) writeFileSync(join(dir, "result.json"), JSON.stringify(run.result) + "\n");
  }
  saveQueue(factoryHome, { version: 1, repo, repo_key: key, entries });
  return { repo, factoryHome };
}

function factsFor(repo: string, issue: number, extra: Partial<RecoverFacts> = {}): Map<string, RecoverFacts> {
  return new Map([[factKey(repo, issue), { issue: { title: TITLE, body: BODY, labels: ["factory-ready"], state: "open" }, ...extra }]]);
}

function stateOf(factoryHome: string, id = RUN): Record<string, unknown> {
  return JSON.parse(readFileSync(join(factoryHome, "runs", id, "state.json"), "utf8")) as Record<string, unknown>;
}

describe("targeted recovery (#188)", () => {
  it("an operator-fixed branch is a revalidation of the same PR, and prior evidence is named not cleared", async () => {
    const { repo, factoryHome } = await home([entry(7, { pr: "https://github.test/pr/7" })], [{
      id: RUN,
      state: {
        stop: stop("technical_repair", "repair"),
        pr: "https://github.test/pr/7",
        branch: "factory/7-fix",
        reviewed_sha: "old",
        approved_sha: "old",
        repair: { gate_attempts: 2 },
        continuation_attempts: 1,
      },
    }]);
    const facts = factsFor(repo, 7, { pr: { state: "open", headSha: "new", conflicting: false } });
    const [row] = recoverPreview(factoryHome, { issues: [7] }, facts, NOW);
    expect(row).toMatchObject({ action: "revalidate", invalidated: ["reviewed old", "approved old"] });
    const applied = await recoverApply(factoryHome, { issues: [7] }, { facts, nowMs: NOW });
    expect(applied.released.map((r) => r.issue)).toEqual([7]);
    const saved = stateOf(factoryHome);
    expect(saved.reviewed_sha).toBe("old");
    expect((saved.repair as { gate_attempts: number }).gate_attempts).toBe(2);
    expect(saved.continuation_attempts).toBe(1);
    expect(loadAllQueues(factoryHome)[0]?.entries[0]).toMatchObject({ status: "pending", run_id: RUN, requeues: 1, issue_rev: rev() });
  });

  it("a changed issue or a broken config is explained and not released", async () => {
    const { repo, factoryHome } = await home([entry(7), entry(8, { run_id: OTHER })], [
      { id: RUN, state: { stop: stop("technical_repair", "repair") } },
      { id: OTHER, state: { stop: stop("technical_repair", "repair") } },
    ]);
    const changed = factsFor(repo, 7, { issue: { title: TITLE, body: "Different task.", labels: ["factory-ready"], state: "open" } });
    changed.set(factKey(repo, 8), { configError: "repo yaml is invalid" });
    const preview = recoverPreview(factoryHome, {}, changed, NOW);
    expect(preview.find((r) => r.issue === 7)?.action).toBe("cannot");
    expect(preview.find((r) => r.issue === 7)?.reason).toMatch(/issue text changed/);
    expect(preview.find((r) => r.issue === 8)?.reason).toMatch(/config does not load/);
    const applied = await recoverApply(factoryHome, { issues: [7, 8] }, { facts: changed, nowMs: NOW });
    expect(applied.released).toEqual([]);
    expect(loadAllQueues(factoryHome)[0]?.entries.every((e) => e.status === "parked")).toBe(true);
  });

  it("a factory fix is not permission to resume a decision, a missing checkpoint, or an unselected ticket", async () => {
    const { repo, factoryHome } = await home(
      [entry(7), entry(8, { run_id: OTHER }), entry(9, { run_id: "20261114-120002-cccccc" })],
      [
        { id: RUN, state: { stop: stop("technical_repair", "repair"), repair: { gate_attempts: 1 } } },
        { id: OTHER, state: { stop: stop("explicit_decision", "decide") } },
        { id: "20261114-120002-cccccc", state: { stop: stop("technical_repair", "repair") }, checkpoint: false },
      ],
    );
    const facts = factsFor(repo, 7);
    facts.set(factKey(repo, 8), facts.get(factKey(repo, 7))!);
    facts.set(factKey(repo, 9), facts.get(factKey(repo, 7))!);
    await expect(recoverApply(factoryHome, {}, { facts, nowMs: NOW })).rejects.toThrow(/explicit selection/);
    const applied = await recoverApply(factoryHome, { cause: "technical_repair" }, { facts, nowMs: NOW });
    expect(applied.released.map((r) => r.issue)).toEqual([7]);
    expect(applied.waiting.map((r) => r.issue)).toEqual([9]);
    expect(applied.waiting[0]?.reason).toMatch(/checkpoint missing/);
    expect(loadAllQueues(factoryHome)[0]?.entries.find((e) => e.issue === 8)?.status).toBe("parked");
    const again = await recoverApply(factoryHome, { issues: [7] }, { facts, nowMs: NOW });
    expect(again.released).toEqual([]);
    expect(again.unchanged[0]?.reason).toMatch(/already pending/);
    expect(loadAllQueues(factoryHome)[0]?.entries.filter((e) => e.status === "pending")).toHaveLength(1);
  });

  it("an exhausted budget stays spent until an explicit grant, which does not reset it", async () => {
    const { repo, factoryHome } = await home([entry(7)], [{
      id: RUN,
      state: { stop: stop("budget_exhausted", "decide"), repair: { gate_attempts: 3 }, continuation_attempts: 2 },
      result: { stop: stop("budget_exhausted", "decide") },
    }]);
    const facts = factsFor(repo, 7);
    const refused = await recoverApply(factoryHome, { issues: [7] }, { facts, nowMs: NOW });
    expect(refused.released).toEqual([]);
    expect(refused.waiting[0]).toMatchObject({ action: "decision", exhausted: true });
    expect(stateOf(factoryHome).repair).toMatchObject({ gate_attempts: 3 });
    const granted = await recoverApply(factoryHome, { issues: [7] }, { facts, grant: true, nowMs: NOW });
    expect(granted.released[0]?.grant).toMatchObject({ gate_attempts: 3, continuation_attempts: 2 });
    const saved = stateOf(factoryHome);
    expect(saved.repair).toMatchObject({ gate_attempts: 3, gate_extra: 1 });
    expect(saved.continuation_attempts).toBe(2);
    expect(saved.continuation_extra).toBe(1);
    expect(saved.stop).toEqual({ cause: "technical_repair", action: "repair" });
    const audit = readFileSync(join(factoryHome, "runs", RUN, "grants.jsonl"), "utf8").trim().split("\n");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!)).toMatchObject({ previous_cause: "budget_exhausted", gate_attempts: 3 });
    await recoverApply(factoryHome, { issues: [7] }, { facts, grant: true, nowMs: NOW });
    expect(readFileSync(join(factoryHome, "runs", RUN, "grants.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a human pause, a blocker and a closed PR are not resumed, and a sibling entry is kept", async () => {
    const { repo, factoryHome } = await home(
      [
        entry(7),
        entry(8, { run_id: OTHER, blocked_by: [3] }),
        entry(9, { run_id: "20261114-120002-cccccc", status: "pending" }),
      ],
      [
        { id: RUN, state: { stop: stop("human_approval", "approve"), pr: "https://github.test/pr/9" } },
        { id: OTHER, state: { stop: stop("technical_repair", "repair") } },
      ],
    );
    requestPause(factoryHome, { runId: RUN, repo, issue: 7 }, "operator pause");
    const facts = factsFor(repo, 7, { pr: { state: "closed", conflicting: false } });
    facts.set(factKey(repo, 8), { issue: { title: TITLE, body: BODY, labels: ["factory-ready"], state: "open" } });
    const paused = recoverPreview(factoryHome, { issues: [7] }, facts, NOW);
    expect(paused[0]?.action).toBe("decision");
    expect(paused[0]?.reason).toMatch(/paused/);
    rmSync(join(factoryHome, "queue", "pause"), { recursive: true, force: true });
    const applied = await recoverApply(factoryHome, { issues: [7, 8] }, { facts, nowMs: NOW });
    expect(applied.released).toEqual([]);
    expect(applied.waiting.find((r) => r.issue === 7)?.action).toBe("cannot");
    expect(applied.waiting.find((r) => r.issue === 7)?.reason).toMatch(/closed/);
    expect(applied.waiting.find((r) => r.issue === 8)?.action).toBe("wait_blocker");
    expect(loadAllQueues(factoryHome)[0]?.entries.find((e) => e.issue === 9)?.status).toBe("pending");
    rmSync(factoryHome, { recursive: true, force: true });
  });

  it("a grant of one extra attempt is the only way past a spent gate budget", () => {
    expect(gateLimit(undefined)).toBe(3);
    expect(gateLimit(0)).toBe(3);
    expect(gateLimit(2)).toBe(3);
    expect(gateLimit(1)).toBe(4);
    expect(stopCauseForBudget({ gateAttempts: 3, gateExtra: 1 })).toBe("technical_repair");
    expect(stopCauseForBudget({ gateAttempts: 3 })).toBe("budget_exhausted");
    expect(stopCauseForBudget({ gateAttempts: 4, gateExtra: 0 })).toBe("budget_exhausted");
  });
});
