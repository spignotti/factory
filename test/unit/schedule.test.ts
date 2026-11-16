import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concurrencyCheck } from "../../src/commands/doctor.js";
import { EventLog } from "../../src/events.js";
import { claimResources, releaseResourceClaims } from "../../src/pipeline/lock.js";
import type { RunDeps } from "../../src/pipeline/context.js";
import { takeRepoLock } from "../../src/pipeline/run.js";
import {
  admissionBlock,
  closesFooter,
  cycleReasons,
  FAIR_WAIT_MS,
  fulfilledIssues,
  mutualBundle,
  priorityRank,
  rankPending,
  updateNeedsDecision,
} from "../../src/queue/admit.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import type { Plan } from "../../src/schemas/plan.js";
import { renderPrBody } from "../../src/steps/finalize.js";
import type { RunContext } from "../../src/pipeline/context.js";
import { createFixtureRepo } from "../helpers/repo.js";

describe("admission and schedule", () => {
  it("honors canonical priority labels and retains legacy spellings", () => {
    expect(priorityRank(["prio:high"])).toBe(2);
    expect(priorityRank(["prio:low"])).toBe(0);
    expect(priorityRank(["priority:high"])).toBe(2);
    expect(priorityRank([])).toBe(1);
  });
  const ready = { title: "Fix the gate", body: "Make it fail first.", labels: ["factory-ready"], state: "open" as const };

  it("refuses blocked labels and an empty task, and accepts a ready issue", () => {
    expect(admissionBlock(ready)).toBeUndefined();
    expect(admissionBlock({ ...ready, state: "closed" })).toBe("is closed");
    expect(admissionBlock({ ...ready, labels: [] })).toBe("lacks the factory-ready label");
    expect(admissionBlock({ ...ready, labels: ["factory-ready", "needs-plan"] })).toBe("carries needs-plan");
    expect(admissionBlock({ ...ready, labels: ["factory-ready", "needs-decision"] })).toBe("carries needs-decision");
    expect(admissionBlock({ ...ready, labels: ["factory-ready", "factory-proposal"] })).toBe("carries factory-proposal");
    expect(admissionBlock({ ...ready, title: "  " })).toBe("task is not sufficient");
    expect(admissionBlock({ ...ready, body: "" })).toBe("task is not sufficient");
  });

  it("lets a normal ticket waiting a day start ahead of a newer high-priority one", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    const ranked = rankPending(
      [
        { issue: 2, addedAt: new Date(now - 60 * 60_000).toISOString(), index: 1, priority: 2 },
        { issue: 1, addedAt: new Date(now - FAIR_WAIT_MS - 60_000).toISOString(), index: 0, priority: 1 },
      ],
      now,
    );
    expect(ranked.map((row) => row.issue)).toEqual([1, 2]);
    expect(ranked[0]?.choice).toContain("fair wait");
    expect(ranked[0]?.choice).toContain("priority normal");
    expect(ranked[1]?.choice).toContain("priority high");
  });

  it("keeps queue order when priority and age match", () => {
    const at = "2026-11-12T12:00:00.000Z";
    expect(rankPending(
      [
        { issue: 2, addedAt: at, index: 1, priority: 1 },
        { issue: 1, addedAt: at, index: 0, priority: 1 },
      ],
      Date.parse(at),
    ).map((row) => row.issue)).toEqual([1, 2]);
  });

  it("names an after-cycle once", () => {
    const reasons = cycleReasons([
      { issue: 1, after: 2, status: "pending" },
      { issue: 2, after: 1, status: "pending" },
      { issue: 3, after: 1, status: "pending" },
    ]);
    expect(reasons.get(1)).toBe("dependency cycle: #1 -> #2 -> #1");
    expect(reasons.get(2)).toBe("dependency cycle: #1 -> #2 -> #1");
    expect(reasons.has(3)).toBe(false);
  });

  it("bundles only mutual factory-bundle markers", () => {
    const issues = [
      { number: 1, body: "factory-bundle: #2\nfactory-bundle: #4" },
      { number: 2, body: "factory-bundle: #1" },
      { number: 4, body: "no marker back" },
    ];
    expect(mutualBundle(issues, 1)).toEqual([2]);
    expect(mutualBundle(issues, 4)).toEqual([]);
  });

  it("closes only evidenced fulfills lines", () => {
    const plan = { acceptance: [{ id: "a", text: "fulfills #2" }, { id: "b", text: "fulfills #3" }] };
    expect(fulfilledIssues(plan, new Set(["a"]))).toEqual([2]);
    expect(closesFooter(1, "done", [2])).toBe("\nCloses #1\nCloses #2\n");
    expect(closesFooter(1, "needs_human", [2])).toBe("");
    expect(updateNeedsDecision("merge conflict in src/a.js")).toBe(true);
    expect(updateNeedsDecision("network down")).toBe(false);
  });

  it("puts a resource on the doctor line only when one is named", () => {
    expect(concurrencyCheck(parseRepoConfig("")).detail).toBe("max_runs 2; exclusive_paths (none)");
    expect(concurrencyCheck(parseRepoConfig('concurrency: { resources: ["db"] }\n')).detail).toBe("max_runs 2; exclusive_paths (none); resources db");
    expect(concurrencyCheck(parseRepoConfig("concurrency: { max_runs: 1 }\n")).detail).toBe("max_runs 1");
  });
});

describe("resource claims", () => {
  it("a second run waits, and releasing the same run does not drop the first claim", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-resource-"));
    const first = claimResources(home, ["db"], "run-a");
    expect(first.ok).toBe(true);
    const second = claimResources(home, ["db"], "run-b");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.held).toMatchObject({ name: "db", runId: "run-a" });
    const again = claimResources(home, ["db"], "run-a");
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
    expect(claimResources(home, ["db"], "run-b").ok).toBe(false);
    if (first.ok) first.release();
    const after = claimResources(home, ["db"], "run-b");
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });

  it("takeRepoLock uses the same resource claim as the queue", async () => {
    const repo = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2, resources: ["db"] };
    });
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-lock-"));
    const events = new EventLog(join(factoryHome, "log"), "run-a");
    const deps = { factoryHome } as RunDeps;
    claimResources(factoryHome, ["db"], "run-a");
    const blocked = await takeRepoLock(deps, repo, "run-b", events, false, 2);
    expect(blocked.release).toBeUndefined();
    expect(blocked.reason).toContain("resource db");
    expect(blocked.reason).toContain("run-a");
    const same = await takeRepoLock(deps, repo, "run-a", events, false, 2);
    expect(same.release).toBeTypeOf("function");
    same.release?.();
    const still = await takeRepoLock(deps, repo, "run-b", events, false, 2);
    expect(still.reason).toContain("resource db");
    releaseResourceClaims(factoryHome, ["db"], "run-a");
    const free = await takeRepoLock(deps, repo, "run-b", events, false, 2);
    expect(free.release).toBeTypeOf("function");
    free.release?.();
    const manual = await takeRepoLock(deps, repo, "run-c", events, false, 2);
    manual.release?.();
    const next = await takeRepoLock(deps, repo, "run-d", events, false, 2);
    expect(next.release).toBeTypeOf("function");
    next.release?.();
  });
});

describe("pull request closes", () => {
  const plan: Plan = {
    version: 1,
    type: "feature",
    goal: "Ship the pair",
    context: "",
    packages: [{ id: "P1", title: "pair", description: "", files: [], depends_on: [], changes_flows: [] }],
    acceptance: [
      { id: "a2", package: "P1", text: "fulfills #2", verify: "test", kind: "behavior", risk: false },
      { id: "a3", package: "P1", text: "fulfills #3", verify: "review", kind: "behavior", risk: false },
      { id: "a4", package: "P1", text: "fulfills #4", verify: "test", kind: "behavior", risk: false },
      { id: "a5", package: "P1", text: "fulfills #5", verify: "test", kind: "behavior", risk: false },
    ],
    out_of_scope: [],
    resolves_findings: [],
    protected_changes: [],
  };
  function body(opts: { bundle?: number[]; accepted: { acceptance_id: string; kind: "test" | "check"; ref: string }[] }): string {
    const home = mkdtempSync(join(tmpdir(), "factory-pr-"));
    const events = new EventLog(join(home, "run"), "run");
    const ctx = {
      plan,
      handoffs: [{
        package: "P1",
        done: [],
        decisions: [],
        deviations_from_plan: [],
        skipped: [],
        uncertain: [],
        evidence: [
          { acceptance_id: "a2", kind: "test", ref: "test/pair.test.ts" },
          // Invented: the evidence gate did not accept it.
          { acceptance_id: "a4", kind: "test", ref: "test/does-not-exist.test.ts::nope" },
          { acceptance_id: "a5", kind: "test", ref: "test/other.test.ts" },
        ],
        responses: [],
      }],
      repo: parseRepoConfig(""),
      events,
      task: { ref: "#1", issue: 1, title: "Ship", text: "Ship it", labels: [], ...(opts.bundle ? { bundle: opts.bundle } : {}) },
    } as unknown as RunContext;
    return renderPrBody(ctx, {
      summary: "Shipped",
      input: {
        result: "done",
        reason: "",
        rounds: 0,
        findings: [],
        packages: new Map([["P1", "done"]]),
        failures: {},
        noPr: false,
        startedAt: Date.now(),
      },
      out: { result: "done", reason: "", risk: { risk: "low", reasons: [] }, mergePolicy: "human_review" },
      gates: { n: 1, tier: "full", green: true, changed_files: [], checks: [], scope_report: [], accepted_evidence: opts.accepted },
      changed: [],
    });
  }

  it("closes the primary issue and only evidenced bundle partners", () => {
    const text = body({
      bundle: [2, 3, 4],
      accepted: [{ acceptance_id: "a2", kind: "test", ref: "test/pair.test.ts" }, { acceptance_id: "a5", kind: "test", ref: "test/other.test.ts" }],
    });
    expect(text).toContain("Closes #1");
    expect(text).toContain("Closes #2");
    expect(text).toContain("Closes #3");
    expect(text).not.toContain("Closes #4");
    expect(text).toContain("| [x] | a2 |");
  });

  it("an invented evidence reference is neither a checked box nor a close", () => {
    const text = body({ bundle: [2, 3, 4], accepted: [{ acceptance_id: "a2", kind: "test", ref: "test/pair.test.ts" }] });
    expect(text).toContain("| [ ] | a4 |");
    expect(text).not.toContain("does-not-exist");
    expect(text).not.toContain("Closes #4");
    expect(text).toContain("Unverified criteria: a4, a5");
  });

  it("fulfills #N closes only an issue that is the run's bundle partner", () => {
    const accepted = [{ acceptance_id: "a2", kind: "test" as const, ref: "test/pair.test.ts" }, { acceptance_id: "a5", kind: "test" as const, ref: "test/other.test.ts" }];
    const partner = body({ bundle: [2], accepted });
    expect(partner).toContain("Closes #2");
    expect(partner).not.toMatch(/Closes #[35]/);
    const alone = body({ accepted });
    expect(alone).toContain("Closes #1");
    expect(alone).not.toMatch(/Closes #[2-5]/);
  });
});
