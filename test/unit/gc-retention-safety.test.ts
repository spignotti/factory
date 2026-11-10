import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(dir, "events.jsonl"), "{}\n");
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), dryRun: false, scheduled: true, evidence: false, retention: retention({ dry_run: true }) });
    expect(r.dry_run).toBe(true);
    expect(r.home_removed.length).toBe(1);
    expect(existsSync(join(dir, "home", "c"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(fh, "archive"))).toBe(false);
  });

  it("does not archive a terminal run; the run directory and its logs stay", async () => {
    const fh = home();
    const dir = writeRun(fh, { result: "done", idleDays: 5 });
    mkdirSync(join(dir, "worktree"));
    writeFileSync(join(dir, "worktree", "big"), "y");
    writeFileSync(join(dir, "plan.json"), "{}");
    const r = await gc({ factoryHome: fh, github: new FakeGitHub(), evidence: false, retention: retention({ home_hours: 1e9 }) });
    expect(r.home_removed).toEqual([]);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(dir, "plan.json"))).toBe(true);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(fh, "archive"))).toBe(false);
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
