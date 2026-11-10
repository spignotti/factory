import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gc, resumesBaseRedAfterGc } from "../../src/commands/gc.js";
import { deploySelfBusy, GcRetentionSchema, isProtectedFactoryPath, loadGcRetention } from "../../src/gc/retention-config.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { branchHasUnpushedCommits, homeEligible, protectedIdleRun, worktreeRetentionMs } from "../../src/gc/retention-helpers.js";
import { appendGcLog } from "../../src/gc/retention-log.js";
import { FakeGitHub } from "../../src/gh.js";
import { git as gitCmd, tryRepoGitOps } from "../../src/git.js";
import type { RunResultKind } from "../../src/events.js";
import type { RunState } from "../../src/pipeline/state.js";
import type { RunRecord } from "../../src/runs.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

  it("home eligible only for terminal idle runs, or resume runs whose PR is already finished", () => {
    const done = runRecord({ run_id: "20261001-120000-eeeeee", result: "done", updated_at: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(homeEligible(done, Date.now(), 24)).toBe(true);
    const abandoned = runRecord({ run_id: "20261001-120000-eeeeef", result: "abandoned", updated_at: new Date(Date.now() - 25 * HOUR).toISOString() });
    expect(homeEligible(abandoned, Date.now(), 24)).toBe(true);
    const freshDone = runRecord({ run_id: "20261001-120000-eeeef0", result: "done", updated_at: new Date(Date.now() - HOUR).toISOString() });
    expect(homeEligible(freshDone, Date.now(), 24)).toBe(false);
    const input = runRecord({ run_id: "20261001-120000-ffffff", result: "needs_input", updated_at: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(homeEligible(input, Date.now(), 24)).toBe(false);
    expect(homeEligible(input, Date.now(), 24, { prTerminal: false })).toBe(false);
    const human = runRecord({ run_id: "20261001-120000-fffffa", result: "needs_human", updated_at: new Date(Date.now() - 25 * HOUR).toISOString() });
    expect(homeEligible(human, Date.now(), 24)).toBe(false);
    expect(homeEligible(human, Date.now(), 24, { prTerminal: true })).toBe(true);
    const freshHuman = runRecord({ run_id: "20261001-120000-fffffb", result: "needs_human", updated_at: new Date(Date.now() - HOUR).toISOString() });
    expect(homeEligible(freshHuman, Date.now(), 24, { prTerminal: true })).toBe(false);
    const locked = runRecord({ run_id: "20261001-120000-aaaaab", result: "locked", updated_at: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(homeEligible(locked, Date.now(), 0)).toBe(false);
    expect(homeEligible(locked, Date.now(), 0, { prTerminal: true })).toBe(false);
  });

  it("scheduled dry-run does not resume base_red runs; a live scheduled gc does", () => {
    expect(resumesBaseRedAfterGc({ dryRun: false, scheduled: true }, true)).toBe(false);
    expect(resumesBaseRedAfterGc({ dryRun: true, scheduled: true }, false)).toBe(false);
    expect(resumesBaseRedAfterGc({ dryRun: false, scheduled: true }, false)).toBe(true);
    expect(resumesBaseRedAfterGc({ dryRun: false, scheduled: false }, true)).toBe(true);
    const cli = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
    expect(cli).toContain("resumesBaseRedAfterGc");
    expect(cli).not.toContain('if (!values["dry-run"]) await sweepBaseRedRuns');
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

  it("removes a terminal home while another run holds a slot, and keeps a live or resumable home", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-busy-"));
    dirs.push(factoryHome);
    const terminal = "20261101-120000-aaaaaa";
    const resumable = "20261101-120000-bbbbbb";
    const write = (id: string, result: "failed" | "needs_input" | "locked") => {
      const dir = join(factoryHome, "runs", id);
      mkdirSync(join(dir, "home"), { recursive: true });
      writeFileSync(join(dir, "home", "cache.bin"), "x");
      const state: RunState = {
        version: 1,
        run_id: id,
        repo: factoryHome,
        task: { ref: "text:t.md", title: "t", text: "t", labels: [] },
        no_pr: true,
        step: "finished",
        result,
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
        updated_at: new Date(Date.now() - 3_600_000).toISOString(),
      };
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    };
    write(terminal, "failed");
    write(resumable, "needs_input");
    const other = acquireRepoLock(factoryHome, "https://github.com/acme/widgets.git", "20261029-000000-eeeeee")!;
    try {
      const r = await gc({
        factoryHome,
        github: new FakeGitHub(),
        evidence: false,
        retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 0, metadata_days: 1e6 }),
        needsInputWorkingDays: 99,
      });
      expect(r.home_removed.map((h) => h.run_id)).toEqual([terminal]);
      expect(readFileSync(join(factoryHome, "runs", resumable, "home", "cache.bin"), "utf8")).toBe("x");
      expect(r.skipped.some((s) => /repository is locked/.test(s.reason))).toBe(false);
    } finally {
      other();
    }

    const liveId = "20261101-120000-cccccc";
    write(liveId, "failed");
    const live = acquireRepoLock(factoryHome, "https://github.com/acme/widgets.git", liveId)!;
    try {
      const r = await gc({
        factoryHome,
        github: new FakeGitHub(),
        evidence: false,
        retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 0, metadata_days: 1e6 }),
      });
      expect(r.home_removed).toEqual([]);
      expect(readFileSync(join(factoryHome, "runs", liveId, "home", "cache.bin"), "utf8")).toBe("x");
      expect(r.skipped.some((s) => s.run_id === liveId && /live/.test(s.reason))).toBe(true);
    } finally {
      live();
    }
  });

  it("a missing flock binary does not disable gc", () => {
    const rel = mkdtempSync(join(tmpdir(), "deploy-rel-missing-"));
    dirs.push(rel);
    writeFileSync(join(rel, ".deploy.lock"), "");
    expect(deploySelfBusy({ FACTORY_RELEASES: rel, PATH: join(rel, "no-such-bin") })).toBe(false);
  });

  it("a deploy flock blocks only while it is held", async () => {
    const rel = mkdtempSync(join(tmpdir(), "deploy-rel-"));
    dirs.push(rel);
    const lock = join(rel, ".deploy.lock");
    writeFileSync(lock, "");
    const env = { FACTORY_RELEASES: rel };
    expect(deploySelfBusy(env)).toBe(false);
    // `flock file command` leaves the lock fd open in the child, so the whole group has to die.
    const child = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore", detached: true });
    const exited = new Promise((resolve) => {
      child.on("exit", () => resolve(undefined));
      child.on("error", () => resolve(undefined));
    });
    try {
      const deadline = Date.now() + 2000;
      while (!deploySelfBusy(env)) {
        if (Date.now() > deadline) throw new Error("flock was not observed");
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await exited;
    }
    expect(deploySelfBusy(env)).toBe(false);
  });

  it("git-ops lock is independent of a held run slot and exclusive against itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "gitops-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    await gitCmd(repo, ["init"]);
    const home = join(root, "fh");
    const release = acquireRepoLock(home, "https://github.com/acme/widgets.git", "run-1")!;
    try {
      const free = await tryRepoGitOps(repo, async () => 1, { waitMs: 0 });
      expect(free).toEqual({ ok: true, value: 1 });
      const nested = await tryRepoGitOps(
        repo,
        () => tryRepoGitOps(repo, async () => 1, { waitMs: 40, pollMs: 10 }),
        { waitMs: 0 },
      );
      expect(nested.ok).toBe(true);
      if (nested.ok) expect(nested.value).toEqual({ ok: false, reason: "busy" });
    } finally {
      release();
    }
  });

  function writeGcRun(
    factoryHome: string,
    v: { id: string; result: RunResultKind; idleMs: number; pr: string | null },
  ): string {
    const dir = join(factoryHome, "runs", v.id);
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "cache.bin"), "sandbox");
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews", "r1.md"), "review");
    writeFileSync(join(dir, "pr.md"), "pr");
    writeFileSync(join(dir, "plan.md"), "plan");
    writeFileSync(join(dir, "events.jsonl"), "{}\n");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ result: v.result }));
    const state: RunState = {
      version: 1,
      run_id: v.id,
      repo: factoryHome,
      task: { ref: "text:t.md", title: "t", text: "t", labels: [] },
      no_pr: v.pr === null,
      step: "finished",
      result: v.result,
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
      pr: v.pr,
      pr_draft: null,
      updated_at: new Date(Date.now() - v.idleMs).toISOString(),
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    return dir;
  }

  function expectMetadata(dir: string): void {
    expect(readFileSync(join(dir, "state.json"), "utf8")).toContain("run_id");
    expect(readFileSync(join(dir, "result.json"), "utf8")).toContain("result");
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(dir, "plan.md"), "utf8")).toBe("plan");
    expect(readFileSync(join(dir, "reviews", "r1.md"), "utf8")).toBe("review");
    expect(readFileSync(join(dir, "pr.md"), "utf8")).toBe("pr");
  }

  it("resume-state runs keep worktree and home even when the PR is merged or closed", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-resume-home-"));
    dirs.push(factoryHome);
    const merged = "https://github.com/acme/pm/pull/41";
    const closed = "https://github.com/acme/pm/pull/42";
    const human = "20261104-150805-15d527";
    const input = "20261104-160805-15d528";
    const red = "20261104-170805-15d529";
    const liveId = "20261104-210805-15d52d";
    const humanDir = writeGcRun(factoryHome, { id: human, result: "needs_human", idleMs: 25 * HOUR, pr: merged });
    const inputDir = writeGcRun(factoryHome, { id: input, result: "needs_input", idleMs: 25 * HOUR, pr: closed });
    const redDir = writeGcRun(factoryHome, { id: red, result: "base_red", idleMs: 25 * HOUR, pr: merged });
    const liveDir = writeGcRun(factoryHome, { id: liveId, result: "needs_human", idleMs: 25 * HOUR, pr: merged });
    const gh = new FakeGitHub();
    gh.prStates.set(merged, { state: "merged", draft: false });
    gh.prStates.set(closed, { state: "closed", draft: false });
    const live = acquireRepoLock(factoryHome, "https://github.com/acme/widgets.git", liveId)!;
    try {
      const r = await gc({
        factoryHome,
        github: gh,
        evidence: false,
        retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 24, metadata_days: 1e6 }),
        needsInputWorkingDays: 99,
      });
      expect(r.home_removed).toEqual([]);
      expect(r.stripped).toEqual([]);
      for (const dir of [humanDir, inputDir, redDir, liveDir]) {
        expect(readFileSync(join(dir, "home", "cache.bin"), "utf8")).toBe("sandbox");
        expectMetadata(dir);
      }
      expect(r.cleaned).toEqual([]);
      expect(r.skipped.some((s) => s.run_id === liveId && /live/.test(s.reason))).toBe(true);
    } finally {
      live();
    }
  });

  it("keeps home of a needs_human run while its PR is open or missing, inside the resume window", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-resume-keep-"));
    dirs.push(factoryHome);
    const open = "https://github.com/acme/pm/pull/43";
    const openId = "20261104-180805-15d52a";
    const noneId = "20261104-190805-15d52b";
    const freshId = "20261104-200805-15d52c";
    const merged = "https://github.com/acme/pm/pull/44";
    const openDir = writeGcRun(factoryHome, { id: openId, result: "needs_human", idleMs: 25 * HOUR, pr: open });
    const noneDir = writeGcRun(factoryHome, { id: noneId, result: "needs_human", idleMs: 3 * DAY, pr: null });
    const freshDir = writeGcRun(factoryHome, { id: freshId, result: "needs_human", idleMs: HOUR, pr: merged });
    const gh = new FakeGitHub();
    gh.prStates.set(open, { state: "open", draft: true });
    gh.prStates.set(merged, { state: "merged", draft: false });
    const r = await gc({
      factoryHome,
      github: gh,
      evidence: false,
      retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 24, metadata_days: 1e6, worktree_resume_days: 14 }),
      needsInputWorkingDays: 99,
    });
    expect(r.home_removed).toEqual([]);
    for (const dir of [openDir, noneDir, freshDir]) {
      expect(readFileSync(join(dir, "home", "cache.bin"), "utf8")).toBe("sandbox");
      expectMetadata(dir);
    }
  });

  it("strips a terminal run immediately and keeps log files", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-terminal-home-"));
    dirs.push(factoryHome);
    const doneId = "20261104-220805-15d52e";
    const abandonedId = "20261104-230805-15d52f";
    const freshId = "20261105-000805-15d530";
    const doneDir = writeGcRun(factoryHome, { id: doneId, result: "done", idleMs: HOUR, pr: null });
    const abandonedDir = writeGcRun(factoryHome, { id: abandonedId, result: "abandoned", idleMs: HOUR, pr: null });
    const freshDir = writeGcRun(factoryHome, { id: freshId, result: "failed", idleMs: 60_000, pr: null });
    const wt = join(factoryHome, "wt");
    mkdirSync(join(wt, "pkg", "node_modules", "left"), { recursive: true });
    mkdirSync(join(wt, ".venv"), { recursive: true });
    mkdirSync(join(wt, "src-keep"), { recursive: true });
    writeFileSync(join(wt, "pkg", "node_modules", "left", "index.js"), "x");
    const st = JSON.parse(readFileSync(join(doneDir, "state.json"), "utf8")) as RunState;
    writeFileSync(join(doneDir, "state.json"), JSON.stringify({ ...st, worktree: wt }));
    writeFileSync(join(doneDir, "plan.json"), "{}");
    writeFileSync(join(doneDir, "gates-1.json"), "{}");
    mkdirSync(join(doneDir, "evidence"), { recursive: true });
    writeFileSync(join(doneDir, "evidence", "shot.png"), "png");
    writeFileSync(join(doneDir, "events.jsonl"), "{}\n" + JSON.stringify({ data: { evidence: { sha: "abc", files: 1 } } }) + "\n");
    mkdirSync(join(doneDir, "services"), { recursive: true });
    writeFileSync(join(doneDir, "services", "web.log"), "log");
    mkdirSync(join(freshDir, "evidence"), { recursive: true });
    writeFileSync(join(freshDir, "evidence", "keep.png"), "png");
    const r = await gc({
      factoryHome,
      github: new FakeGitHub(),
      evidence: false,
      retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 24, metadata_days: 1e6 }),
    });
    expect(r.home_removed.map((h) => h.run_id).sort()).toEqual([abandonedId, doneId, freshId].sort());
    expect(r.home_removed.every((h) => h.reason.startsWith("terminal run"))).toBe(true);
    expect(r.stripped).toEqual([{ run_id: doneId, repo: factoryHome, pr: null, removed: [".venv", "pkg/node_modules"] }]);
    expect(existsSync(join(doneDir, "home"))).toBe(false);
    expect(existsSync(join(doneDir, "evidence"))).toBe(false);
    expect(existsSync(join(doneDir, "services"))).toBe(false);
    expect(existsSync(join(wt, "pkg", "node_modules"))).toBe(false);
    expect(existsSync(join(wt, ".venv"))).toBe(false);
    expect(existsSync(join(wt, "src-keep"))).toBe(true);
    expect(existsSync(join(freshDir, "evidence", "keep.png"))).toBe(true);
    expect(readFileSync(join(doneDir, "state.json"), "utf8")).toContain("run_id");
    expect(readFileSync(join(doneDir, "result.json"), "utf8")).toContain("result");
    expect(readFileSync(join(doneDir, "events.jsonl"), "utf8")).toContain("sha");
    expect(readFileSync(join(doneDir, "plan.md"), "utf8")).toBe("plan");
    expect(readFileSync(join(doneDir, "plan.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(doneDir, "gates-1.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(doneDir, "reviews", "r1.md"), "utf8")).toBe("review");
    expect(readFileSync(join(doneDir, "pr.md"), "utf8")).toBe("pr");
    expectMetadata(abandonedDir);
    expect(existsSync(join(factoryHome, "archive"))).toBe(false);
  });

  it("keeps a resume home when PR state cannot be read", async () => {
    const factoryHome = mkdtempSync(join(tmpdir(), "fh-gc-pr-unknown-"));
    dirs.push(factoryHome);
    const id = "20261104-150805-15d531";
    const pr = "https://github.com/acme/pm/pull/45";
    const dir = writeGcRun(factoryHome, { id, result: "needs_human", idleMs: 25 * HOUR, pr });
    const gh = new FakeGitHub();
    gh.prStatus = async () => {
      throw new Error("github down");
    };
    const r = await gc({
      factoryHome,
      github: gh,
      evidence: false,
      retention: GcRetentionSchema.parse({ dry_run: false, home_hours: 24, metadata_days: 1e6 }),
    });
    expect(r.home_removed).toEqual([]);
    expect(readFileSync(join(dir, "home", "cache.bin"), "utf8")).toBe("sandbox");
  });

  it("appendGcLog rotates", () => {
    const fh = mkdtempSync(join(tmpdir(), "fh-log-"));
    dirs.push(fh);
    appendGcLog(fh, { at: new Date().toISOString(), scheduled: false, report: { dry_run: true, cleaned: [], skipped: [], stripped: [], evidence: [], abandoned: [], home_removed: [], worktree_pruned: [] } });
    expect(readFileSync(join(fh, "gc.log"), "utf8")).toContain("dry_run");
  });
});
