import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gc } from "../../src/commands/gc.js";
import { GcRetentionSchema, isProtectedFactoryPath, loadGcRetention } from "../../src/gc/retention-config.js";
import {
  branchHasUnpushedCommits,
  homeEligible,
  metadataRetentionMs,
  protectedIdleRun,
  protectedMetadataRunIds,
  worktreeRetentionMs,
} from "../../src/gc/retention-helpers.js";
import { appendGcLog } from "../../src/gc/retention-log.js";
import { FakeGitHub } from "../../src/gh.js";
import { git as gitCmd } from "../../src/git.js";
import type { RunResultKind } from "../../src/events.js";
import type { RunState } from "../../src/pipeline/state.js";
import type { RunRecord } from "../../src/runs.js";

const DAY = 86_400_000;

function runRecord(v: { run_id: string; result: RunResultKind; updated_at: string; repo?: string }): RunRecord {
  const started = new Date("2026-10-01T12:00:00.000Z");
  const state: RunState = {
    version: 1,
    run_id: v.run_id,
    repo: v.repo ?? "/tmp/repo",
    task: { ref: "text:t.md", title: "t", text: "t", labels: [] },
    no_pr: false,
    step: "finished",
    result: v.result,
    reason: "",
    branch: "factory/x",
    worktree: "/tmp/wt",
    base_sha: null,
    packages: {},
    failures: {},
    handoffs: [],
    rounds: 0,
    findings: [],
    gate_count: 0,
    pr: null,
    pr_draft: null,
    updated_at: v.updated_at,
  };
  return { run_id: v.run_id, dir: `/fh/runs/${v.run_id}`, started_at: started, state };
}

describe("gc retention helpers", () => {
  it("protects needs_input within 14 idle days", () => {
    const run = runRecord({ run_id: "20261001-120000-aaaaaa", result: "needs_input", updated_at: new Date(Date.now() - 3 * DAY).toISOString() });
    expect(protectedIdleRun(run, Date.now(), 14)).toBe(true);
    expect(protectedIdleRun(run, Date.now(), 14)).toBe(true);
    const old = runRecord({ run_id: "20261001-120000-bbbbbb", result: "needs_input", updated_at: new Date(Date.now() - 15 * DAY).toISOString() });
    expect(protectedIdleRun(old, Date.now(), 14)).toBe(false);
  });

  it("uses 7 vs 14 day worktree retention by result", () => {
    const cfg = GcRetentionSchema.parse({});
    const failed = runRecord({ run_id: "20261001-120000-cccccc", result: "failed", updated_at: new Date().toISOString() });
    const input = runRecord({ run_id: "20261001-120000-dddddd", result: "needs_input", updated_at: new Date().toISOString() });
    expect(worktreeRetentionMs(failed, cfg)).toBe(7 * DAY);
    expect(worktreeRetentionMs(input, cfg)).toBe(14 * DAY);
  });

  it("home eligible only for terminal idle runs", () => {
    const done = runRecord({ run_id: "20261001-120000-eeeeee", result: "done", updated_at: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(homeEligible(done, Date.now(), 24)).toBe(true);
    const input = runRecord({ run_id: "20261001-120000-ffffff", result: "needs_input", updated_at: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(homeEligible(input, Date.now(), 24)).toBe(false);
  });

  it("keeps the newest 20 runs per repo for metadata", () => {
    const runs = Array.from({ length: 25 }, (_, i) =>
      runRecord({
        run_id: `202610${String(i + 1).padStart(2, "0")}-120000-${String(i).padStart(6, "0")}`,
        result: "done",
        updated_at: new Date(Date.UTC(2026, 9, i + 1)).toISOString(),
        repo: "/r/tp",
      }),
    );
    const protectedIds = protectedMetadataRunIds(runs, 20);
    expect(protectedIds.size).toBe(20);
  });

  it("metadata retention uses 180 days for failed runs", () => {
    const cfg = GcRetentionSchema.parse({});
    const failed = runRecord({ run_id: "20261001-120000-111111", result: "failed", updated_at: new Date().toISOString() });
    expect(metadataRetentionMs(failed, cfg)).toBe(180 * DAY);
  });

  it("protected factory paths", () => {
    const home = "/home/user/.factory";
    expect(isProtectedFactoryPath(home, join(home, "keys/x"))).toBe(true);
    expect(isProtectedFactoryPath(home, join(home, "archive/keys/x"))).toBe(true);
    expect(isProtectedFactoryPath(home, join(home, "runs/x/home"))).toBe(false);
  });
});

describe("gc retention integration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("dry-run removes nothing and still writes gc.log", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-"));
    dirs.push(factoryHome);
    mkdirSync(join(factoryHome, "runs", "20261101-120000-aaaaaa", "home"), { recursive: true });
    writeFileSync(join(factoryHome, "runs", "20261101-120000-aaaaaa", "home", "cache.bin"), "x".repeat(100));
    const state: RunState = {
      version: 1,
      run_id: "20261101-120000-aaaaaa",
      repo: factoryHome,
      task: { ref: "text:t.md", title: "t", text: "t", labels: [] },
      no_pr: true,
      step: "finished",
      result: "failed",
      reason: "",
      branch: null,
      worktree: null,
      base_sha: null,
      packages: {},
      failures: {},
      handoffs: [],
      rounds: 0,
      findings: [],
      gate_count: 0,
      pr: null,
      pr_draft: null,
      updated_at: new Date(Date.now() - 3 * DAY).toISOString(),
    };
    writeFileSync(join(factoryHome, "runs", "20261101-120000-aaaaaa", "state.json"), JSON.stringify(state));
    const r = await gc({
      factoryHome,
      github: new FakeGitHub(),
      dryRun: true,
      evidence: false,
      retention: GcRetentionSchema.parse({ home_hours: 0 }),
    });
    expect(r.home_removed.length).toBe(1);
    expect(readFileSync(join(factoryHome, "runs", "20261101-120000-aaaaaa", "home", "cache.bin"), "utf8").length).toBe(100);
    expect(r.log_path).toBe(join(factoryHome, "gc.log"));
    expect(readFileSync(r.log_path!, "utf8")).toContain('"dry_run":true');
  });

  it("skips worktree cleanup when branch has unpushed commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "gc-unpushed-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await gitCmd(repo, ["init"]);
    await gitCmd(repo, ["config", "user.email", "t@t.com"]);
    await gitCmd(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f"), "a");
    await gitCmd(repo, ["add", "f"]);
    await gitCmd(repo, ["commit", "-m", "c"]);
    const head = (await gitCmd(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const unpushed = await branchHasUnpushedCommits(repo, head);
    expect(unpushed.unpushed).toBe(true);
  });

  it("scheduled mode respects profile dry_run default", () => {
    const fh = mkdtempSync(join(tmpdir(), "fh-prof-"));
    dirs.push(fh);
    writeFileSync(join(fh, "profile.yaml"), "gc:\n  retention:\n    dry_run: true\n");
    const cfg = loadGcRetention(fh);
    expect(cfg.dry_run).toBe(true);
  });

  it("appendGcLog rotates", () => {
    const fh = mkdtempSync(join(tmpdir(), "fh-log-"));
    dirs.push(fh);
    appendGcLog(fh, { at: new Date().toISOString(), scheduled: false, report: { dry_run: true, cleaned: [], skipped: [], stripped: [], evidence: [], abandoned: [], home_removed: [], metadata_moved: [], archive_purged: [], worktree_pruned: [] } });
    expect(readFileSync(join(fh, "gc.log"), "utf8")).toContain("dry_run");
  });
});
