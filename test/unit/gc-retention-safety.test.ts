import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gc } from "../../src/commands/gc.js";
import { GcRetentionSchema, loadGcRetention } from "../../src/gc/retention-config.js";
import { FakeGitHub } from "../../src/gh.js";
import type { RunResultKind } from "../../src/events.js";
import type { RunState } from "../../src/pipeline/state.js";

const DAY = 86_400_000;
const RUN = "20260101-120000-bbbbbb";

function writeRun(fh: string, v: { result: RunResultKind; idleDays: number; worktree?: string | null }): string {
  const dir = join(fh, "runs", RUN);
  mkdirSync(dir, { recursive: true });
  const state: RunState = {
    version: 1,
    run_id: RUN,
    repo: fh,
    task: { ref: "text:t.md", title: "t", text: "t", labels: [] },
    no_pr: true,
    step: "finished",
    result: v.result,
    reason: "",
    branch: null,
    worktree: v.worktree ?? null,
    base_sha: null,
    packages: {},
    failures: {},
    handoffs: [],
    rounds: 0,
    findings: [],
    gate_count: 0,
    pr: null,
    pr_draft: null,
    updated_at: new Date(Date.now() - v.idleDays * DAY).toISOString(),
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "events.jsonl"), "{}\n");
  return dir;
}

const retention = (over: Record<string, unknown> = {}) =>
  GcRetentionSchema.parse({ dry_run: false, home_hours: 0, metadata_days: 1, metadata_min_per_repo: 0, ...over });

describe("gc retention safety", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), "fh-safe-"));
    dirs.push(d);
    return d;
  };

  it("user profile gc.retention overrides are honoured next to other profile keys", () => {
    const fh = home();
    writeFileSync(join(fh, "profile.yaml"), "env: {}\ngc:\n  retention:\n    dry_run: false\n    metadata_days: 30\n");
    const cfg = loadGcRetention(fh);
    expect(cfg.dry_run).toBe(false);
    expect(cfg.metadata_days).toBe(30);
    expect(cfg.metadata_min_per_repo).toBe(20);
  });

  it("an invalid gc block fails closed", () => {
    const fh = home();
    writeFileSync(join(fh, "profile.yaml"), "gc:\n  retention:\n    dry_run: maybe\n");
    expect(() => loadGcRetention(fh)).toThrow();
  });

  it("--scheduled stays dry-run per profile even when the CLI passes dryRun=false", async () => {
    const fh = home();
    const dir = writeRun(fh, { result: "done", idleDays: 5 });
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "home", "c"), "x");
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), dryRun: false, scheduled: true, evidence: false, retention: retention({ dry_run: true }) });
    expect(r.dry_run).toBe(true);
    expect(r.metadata_moved.length).toBe(1);
    expect(existsSync(join(dir, "home", "c"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("tarballs metadata without home/ and worktree/, then removes the run dir", async () => {
    const fh = home();
    const dir = writeRun(fh, { result: "done", idleDays: 5 });
    mkdirSync(join(dir, "worktree"));
    writeFileSync(join(dir, "worktree", "big"), "y");
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), evidence: false, retention: retention({ home_hours: 1e9 }) });
    const tarball = join(fh, "archive", "runs", `${RUN}.tar.gz`);
    expect(r.metadata_moved.map((m) => m.tarball)).toEqual([tarball]);
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listing).toContain(`${RUN}/state.json`);
    expect(listing).not.toContain("worktree");
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the run dir when the tarball cannot be written", async () => {
    const fh = home();
    const dir = writeRun(fh, { result: "done", idleDays: 5 });
    writeFileSync(join(fh, "archive"), "not a dir");
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), evidence: false, retention: retention() });
    expect(r.metadata_moved).toEqual([]);
    expect(r.skipped.some((s) => s.reason.startsWith("tarball failed"))).toBe(true);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toContain(RUN);
  });

  it("skips metadata while the recorded worktree still exists", async () => {
    const fh = home();
    const wt = join(fh, "wt");
    mkdirSync(wt);
    const dir = writeRun(fh, { result: "done", idleDays: 5, worktree: wt });
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), evidence: false, retention: retention() });
    expect(r.metadata_moved).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("never follows a symlinked home/ out of $FACTORY_HOME", async () => {
    const fh = home();
    const outside = home();
    writeFileSync(join(outside, "keep"), "z");
    const dir = writeRun(fh, { result: "done", idleDays: 5 });
    symlinkSync(outside, join(dir, "home"));
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), evidence: false, retention: retention({ metadata_days: 1e6 }) });
    expect(r.home_removed).toEqual([]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("z");
  });
});
