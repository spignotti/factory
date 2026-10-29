import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCiStub } from "../../src/ci.js";
import { newestTag } from "../../src/gh.js";
import { applyCompaction, validateCompaction } from "../../src/harden/compact.js";
import { computeMetrics } from "../../src/harden/metrics.js";
import { ciAudit, factoryPrNumbers, findingSignals, hasSignals, reverts, type Signals, staleGuides } from "../../src/harden/signals.js";
import type { MemoryFile } from "../../src/memory.js";
import { listRuns } from "../../src/runs.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { ciRun, entry, seedRun } from "../helpers/harden.js";
import { commitFile, gitIn } from "../helpers/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";

const mem = (entries: MemoryFile["entries"]): MemoryFile => ({ version: 1, repo: "r", entries });
const repo = parseRepoConfig("checks:\n  - { name: lint, run: x, tier: fast }\n  - { name: e2e, run: y, tier: full }\n  - { name: unit, run: z, tier: fast, paths: [src/**] }\n");

describe("harden signals", () => {
  it("findings: open and (seen twice or checkable), plus flaky; most frequent first", () => {
    const s = findingSignals(
      mem([entry("a", { count: 3 }), entry("b", { checkable: "lint" }), entry("c"), entry("flaky:unit", { checkable: "test" }), entry("d", { count: 5, status: "proposed" })]),
    );
    expect(s.map((f) => [f.key, f.flaky])).toEqual([["a", false], ["b", false], ["flaky:unit", true]]);
  });

  it("CI audit: failure and flaky rates, durations, never failed, slow without paths, stub behind", () => {
    const runs = [
      ciRun("s1", "2026-10-20", [["check (lint)", "failure", 30], ["check (e2e)", "success", 200], ["done", "failure", 5]]),
      ciRun("s1", "2026-10-20", [["check (lint)", "success", 30], ["check (e2e)", "success", 220], ["done", "success", 5]]),
      ...Array.from({ length: 4 }, (_, i) => ciRun(`t${i}`, "2026-10-21", [["check (e2e)", "success", 180], ["check (unit)", "success", 300]])),
      ciRun("t9", "2026-10-22", [["check (unit)", "skipped", 0]]),
    ];
    const a = ciAudit(runs, repo, renderCiStub("v0.1.0"), "v0.2.0");
    const lint = a.checks.find((c) => c.name === "lint")!;
    expect(lint).toMatchObject({ runs: 2, failures: 1, failure_rate: 0.5, flaky: 1, flaky_rate: 1, median_s: 30 });
    expect(a.checks.find((c) => c.name === "e2e")).toMatchObject({ runs: 6, failures: 0, median_s: 180, p90_s: 220 });
    expect(a.never_failed).toEqual(["e2e"]);
    expect(a.slow_without_paths).toEqual(["e2e"]);
    expect(a.stub).toEqual({ pinned: "v0.1.0", latest: "v0.2.0", behind: true });
    expect(a.runs).toBe(7);
    // 2 + 2 + 4*(180+300) seconds = 2*240 + 1920 + 10 → minutes per week over 30 days
    expect(a.minutes_per_week).toBe(Math.round(((30 + 200 + 5 + 30 + 220 + 5 + 4 * 480) / 60 / (30 / 7)) * 10) / 10);
    expect(a.flaky_rate).toBeGreaterThan(0);
    expect(ciAudit([], repo, undefined, null).stub).toEqual({ pinned: null, latest: null, behind: false });
  });

  it("stale guides: paths changed ≥ 10 commits since the guide; a missing guide is stale", async () => {
    const dir = makeRepo({ "verify/web.md": "guide\n", "src/a.ts": "0\n" });
    for (let i = 1; i <= 10; i++) commitFile(dir, "src/a.ts", `${i}\n`, `c${i}`);
    const cfg = parseRepoConfig(
      "verify:\n  areas:\n    - { name: web, paths: [src/**], guide: verify/web.md }\n    - { name: api, paths: [api/**], guide: verify/api.md }\n    - { name: quiet, paths: [docs/**], guide: verify/web.md }\n",
    );
    const s = await staleGuides(dir, cfg, "HEAD");
    expect(s.map((g) => [g.area, g.commits])).toEqual([["web", 10], ["api", 0]]);
    expect(s[1]!.reason).toContain("missing");
  });

  it("reverts: only reverts of factory PRs inside the window", async () => {
    const dir = makeRepo({ "a.txt": "a\n" });
    commitFile(dir, "a.txt", "b\n", 'Revert "feat: x (#12)"');
    commitFile(dir, "a.txt", "c\n", 'Revert "feat: y (#13)"');
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    seedRun(home, dir, new Date(), { pr: "https://github.com/o/r/pull/12" });
    const prs = factoryPrNumbers(listRuns(home));
    const r = await reverts(dir, "HEAD", "2000-01-01", prs);
    expect(r.map((x) => x.pr)).toEqual(["https://github.com/o/r/pull/12"]);
    expect(gitIn(dir, "log", "--oneline").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("newest tag compares versions numerically", () => {
    expect(newestTag(["v0.9.0", "v0.10.0", "latest", "v0.2.1"])).toBe("v0.10.0");
    expect(newestTag(["x"])).toBeNull();
  });
});

describe("harden compaction", () => {
  it("validates keys and merges counts, runs and dates in code", () => {
    const m = mem([entry("a", { count: 2, runs: ["r1"], first_seen: "2026-10-05" }), entry("b", { count: 3, runs: ["r2"], first_seen: "2026-10-01", checkable: "lint", check_sketch: "rule" }), entry("c", { status: "proposed" })]);
    expect(validateCompaction(m, { merge: [{ keep: "a", drop: ["c"] }] })).toEqual(["c is not an open memory entry"]);
    expect(validateCompaction(m, { merge: [{ keep: "a", drop: ["a"] }] })).toEqual(["a appears twice"]);
    expect(applyCompaction(m, { merge: [{ keep: "a", drop: ["b"] }] })).toBe(1);
    expect(m.entries.map((e) => e.key)).toEqual(["a", "c"]);
    expect(m.entries[0]).toMatchObject({ count: 5, runs: ["r1", "r2"], first_seen: "2026-10-01", checkable: "lint", check_sketch: "rule" });
  });
});

describe("harden metrics", () => {
  it("determinism ratio, open findings, CI and run metrics, revert rate", () => {
    const signals: Signals = {
      findings: [],
      checklist: ["no secrets in logs"],
      ci: ciAudit([ciRun("s", "2026-10-20", [["check (lint)", "success", 60]])], repo, undefined, null),
      runs: { runs: 4, by_result: {}, done_rate: 0.75, rounds: { median: 2, p90: 3 }, gate_failures: {}, flaky_checks: {}, reasons: [], lane_escalations: 0 },
      evaluator: [],
      stale_guides: [],
      reverts: [{ sha: "x", subject: "Revert", pr: "p" }],
    };
    const m = computeMetrics({ ts: "t", repoId: "r", repo, mem: mem([entry("a", { checkable: "test" }), entry("b"), entry("flaky:x", { checkable: "test" })]), signals, factoryPrs: 4 });
    expect(m).toMatchObject({ determinism_ratio: 0.6, deterministic_checks: 3, llm_verified_items: 2, open_findings: 3, done_rate: 0.75, median_rounds: 2, revert_rate: 0.25, flaky_rate: 0 });
    expect(m.ci_minutes_per_week).toBeCloseTo(0.2, 1);
    expect(hasSignals(signals)).toBe(true);
    expect(hasSignals({ ...signals, checklist: [], reverts: [] })).toBe(false);
  });
});
