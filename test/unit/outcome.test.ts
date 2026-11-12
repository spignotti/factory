import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/commands/stats.js";
import { ResultSchema, type RunResult } from "../../src/events.js";
import {
  addOutcome,
  buildOutcome,
  buildProvenance,
  configFingerprint,
  deliveryForDone,
  emptyOutcomeCounts,
  nextAttempt,
  promptRevision,
  readOutcome,
  readQueueDelivery,
  writeRecoveryNote,
} from "../../src/pipeline/outcome.js";
import { applyOutcome } from "../../src/queue/worker.js";
import { loadQueueByKey, parseQueue, saveQueue, type QueueEntry, type QueueFile } from "../../src/queue/store.js";
import type { RunRecord } from "../../src/runs.js";

const SECRET = "super-secret-token-value";

function stored(over: Partial<RunResult> & Pick<RunResult, "run_id">): RunResult {
  return {
    repo: "/r",
    task: "t",
    type: "feature",
    lane: "standard",
    result: "done",
    risk: "low",
    merge_policy: "auto",
    pr: "https://pr/1",
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

function record(result: RunResult): RunRecord {
  return { run_id: result.run_id, dir: "/missing-run-dir", started_at: new Date("2026-10-28T12:00:00Z"), result };
}

describe("outcome storage", () => {
  it("stores a done coding run as unmerged, with the counters kept apart", () => {
    expect(buildOutcome({ ticket: 12, attempts: 1, pr: "https://pr/9", result: "done" })).toEqual({
      ticket: 12,
      attempts: 1,
      delivered_pr: "https://pr/9",
      merged: "no",
      ended_without_merge: true,
      open_decision: false,
    });
    expect(buildOutcome({ ticket: null, attempts: 2, pr: null, result: "needs_human" })).toMatchObject({
      ticket: null,
      merged: "no",
      ended_without_merge: true,
      open_decision: true,
    });
    expect(buildOutcome({ ticket: 3, attempts: 1, pr: null, result: "locked" })).toMatchObject({
      merged: "no",
      ended_without_merge: false,
      open_decision: false,
    });
    expect(buildOutcome({ ticket: null, attempts: null, pr: null, result: "needs_input" }).open_decision).toBe(true);
  });

  it("V24: a legacy result is unknown and is not backfilled from done or pr", () => {
    const legacy = stored({ run_id: "20261028-120000-aaaaaa" });
    expect(ResultSchema.parse(legacy).outcome).toBeUndefined();
    const read = readOutcome(legacy);
    expect(read).toEqual({
      ticket: "unknown",
      attempts: "unknown",
      delivered_pr: "unknown",
      merged: "unknown",
      ended_without_merge: "unknown",
      open_decision: "unknown",
    });
    expect(read.delivered_pr).not.toBe(legacy.pr);

    const counts = emptyOutcomeCounts();
    addOutcome(counts, read);
    addOutcome(counts, readOutcome({ outcome: buildOutcome({ ticket: null, attempts: 1, pr: "https://pr/9", result: "done" }) }));
    expect(counts).toMatchObject({
      tickets: 0,
      tickets_unknown: 1,
      attempts: 1,
      attempts_unknown: 1,
      delivered_prs: 1,
      delivered_prs_unknown: 1,
      confirmed_merges: 0,
      merges_unknown: 1,
      ended_without_merge: 1,
      open_decisions: 0,
    });

    const confirmed = stored({
      run_id: "20261028-120000-bbbbbb",
      outcome: { ...buildOutcome({ ticket: 12, attempts: 2, pr: "https://pr/9", result: "done" }), merged: "confirmed" },
    });
    const period = aggregate([record(legacy), record(confirmed)], new Date("2026-10-28T00:00:00Z"), new Date("2026-10-29T00:00:00Z"));
    expect(period.auto_merged).toBe(1);
    expect(period.outcomes.confirmed_merges).toBe(1);
    expect(period.outcomes.merges_unknown).toBe(1);
    expect(period.outcomes.delivered_prs).toBe(1);
    expect(aggregate([], new Date(0), new Date(1)).outcomes).toEqual(emptyOutcomeCounts());
  });

  it("V24: a legacy queue done row is unknown, and a new done row is not a confirmed merge", () => {
    const legacy = parseQueue(
      JSON.stringify({
        version: 1,
        repo: "/repo",
        repo_key: "k",
        entries: [{ issue: 4, status: "done", pr: "https://pr/old", added_at: "2026-01-01T00:00:00Z" }],
      }),
      "queue.json",
    );
    expect(readQueueDelivery(legacy.entries[0]!)).toEqual({ merged: "unknown", pr: null, attempts: null });

    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const entry: QueueEntry = {
      issue: 5,
      status: "done",
      pr: "https://pr/new",
      added_at: "2026-01-01T00:00:00Z",
      delivery: deliveryForDone(stored({ run_id: "20261028-120000-cccccc", pr: "https://pr/new", outcome: buildOutcome({ ticket: 5, attempts: 1, pr: "https://pr/new", result: "done" }) })),
    };
    saveQueue(home, { version: 1, repo: "/repo", repo_key: "k", entries: [entry] });
    expect(readQueueDelivery(loadQueueByKey(home, "k")!.entries[0]!)).toEqual({ merged: "no", pr: "https://pr/new", attempts: 1 });

    const running: QueueEntry = { issue: 6, status: "running", added_at: "2026-01-01T00:00:00Z" };
    const queue = { version: 1, repo: "/repo", repo_key: "k", entries: [running] } as QueueFile;
    expect(applyOutcome(queue, running, stored({ run_id: "20261028-120000-dddddd", result: "done", pr: "https://pr/6", outcome: { ...buildOutcome({ ticket: 6, attempts: 3, pr: "https://pr/6", result: "done" }), merged: "confirmed" } }))).toBe("done");
    expect(running.delivery).toEqual({ merged: "no", pr: "https://pr/6", attempts: 3 });
  });

  it("does not invent an attempt count, and does not serialize a secret", () => {
    expect(nextAttempt(undefined)).toBeNull();
    expect(nextAttempt(1)).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), "factory-run-"));
    writeRecoveryNote(dir, { previous_result: "needs_human", attempts: null, branch: `factory/${SECRET}`, checkpoint: "implement" }, [SECRET]);
    const text = readFileSync(join(dir, "recovery.json"), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("A coding result is not a confirmed merge.");
    expect(JSON.parse(text)).toMatchObject({ attempts: null, plan_kept: true, checkpoint: "implement", previous_result: "needs_human" });

    const fingerprint = configFingerprint({ token: SECRET, checks: [{ name: "x", run: `echo ${SECRET}` }] }, [SECRET]);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain(SECRET);
    expect(configFingerprint({ token: SECRET }, [SECRET])).toBe(configFingerprint({ token: "another-secret-value-999" }, ["another-secret-value-999"]));
    expect(configFingerprint({ a: 1 }, [])).not.toBe(configFingerprint({ a: 2 }, []));

    const provenance = buildProvenance({
      model: "opencode-go/deepseek-v4-pro",
      effort: "high",
      repo: { token: SECRET },
      secrets: [SECRET],
      base: "a".repeat(40),
      head: null,
      checks: [{ name: "syntax", run: `node --check ${SECRET}` }],
    });
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("node --check");
    expect(provenance.checks[0]).toEqual({ name: "syntax", version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(provenance.factory_version).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
    expect(provenance.factory_commit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(provenance.prompt_revision).toBe(promptRevision());
    expect(provenance.prompt_revision).toMatch(/^[0-9a-f]{16}$/);
    expect(serialized).not.toContain("You implement the given package");
  });
});
