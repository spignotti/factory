import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CI_MAX_PAGES, ciRunListArgs, foldRunListPages, paginateRunList, parseRunList, parseRunView, resolveRunWorkflow } from "../../src/ci-history.js";
import { assembleRuns, ciSignals, ciWorth, HIGH_CI_MINUTES_PER_WEEK, readCiWorkflows } from "../../src/improve/ci-signals.js";
import { collectTestSignals, durationCommand, localSignalTimeoutMs, parseCoverageReport, parsePytestDurations, parseReporterDurations, runnerInvocation, uncoveredCritical } from "../../src/improve/test-signals.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { entry } from "../helpers/harden.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { gitIn } from "../helpers/repo.js";
import type { MemoryFile } from "../../src/memory.js";

const FIX = join(import.meta.dirname, "../fixtures/improve-ci");
const SINCE = "2026-09-29T12:00:00.000Z";
const page = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8")) as unknown;
const views = () => JSON.parse(readFileSync(join(FIX, "run-views.json"), "utf8")) as Record<string, unknown>;

describe("ci signals from recorded gh pages", () => {
  const pages = [page("run-list-page-1.json"), page("run-list-page-2.json")];

  it("pages the window and drops a run from before it", async () => {
    expect(parseRunList(pages[0])).toHaveLength(8);
    expect(parseRunView(views()["101"])).toEqual([
      { name: "select", conclusion: "success", seconds: 90, steps: [] },
      { name: "check (lint)", conclusion: "skipped", seconds: null, steps: [] },
      { name: "done", conclusion: "success", seconds: 4, steps: [] },
    ]);
    const folded = foldRunListPages(pages, 8, 30);
    expect(folded.truncated).toBe(false);
    expect(folded.rows).toHaveLength(15);
    expect(foldRunListPages(pages, 8, 1)).toMatchObject({ truncated: true, rows: expect.any(Array) });
    expect(foldRunListPages(pages, 8, 1).rows).toHaveLength(8);

    const fetched: number[] = [];
    const paged = await paginateRunList(async (n) => {
      fetched.push(n);
      return pages[n - 1] ?? [];
    }, { perPage: 8, maxPages: 30 });
    expect(fetched).toEqual([1, 2]);
    expect(paged.truncated).toBe(false);
    expect(ciRunListArgs("2026-09-29", 2, 100)[3]).toContain("per_page=100&page=2");
    expect(ciRunListArgs("2026-09-29", 2, 100)[3]).toContain("created=%3E%3D2026-09-29");
    expect(ciRunListArgs("2026-09-29", 2, 100)[5]).toContain("path: .path");
    expect(ciRunListArgs("2026-09-29", 2, 100)[5]).not.toContain(".name");
    expect(CI_MAX_PAGES).toBe(10);

    const runs = assembleRuns(paged.rows, views(), SINCE);
    expect(runs.map((r) => r.id)).not.toContain(999);
    expect(runs).toHaveLength(14);
  });

  it("computes minutes, never-failed, no-paths, report-only and an empty stub", () => {
    const runs = assembleRuns(foldRunListPages(pages, 8, 30).rows, views(), SINCE);
    const signal = ciSignals({ runs, truncated: false, workflows: readCiWorkflows(join(FIX, "repo")), baseBranch: "main" });
    // 5*(90+4) + 5*180 + 2*40 + 30 + 200 = 1680s over 30 days. The pre-window 10000s run is excluded.
    expect(signal.minutes_per_week).toBe(6.5);
    expect(signal.runs).toBe(14);
    expect(signal.never_failed).toEqual([
      { workflow: "factory", name: "done", runs: 5 },
      { workflow: "factory", name: "select", runs: 5 },
      { workflow: "Lint and test", name: "build", runs: 5 },
    ]);
    expect(signal.jobs.find((j) => j.name === "build")).toMatchObject({ p50_s: 180, p90_s: 180, failure_rate: 0, minutes_per_week: 3.5 });
    expect(signal.slow_without_paths).toEqual([{ workflow: "Lint and test", file: ".github/workflows/ci.yml", name: "build", p50_s: 180 }]);
    expect(signal.truncation).toBeNull();
    expect(signal.report_only).toEqual([{
      file: ".github/workflows/report.yml",
      job: "audit",
      minutes_per_week: 0.3,
      steps: [
        { name: "pnpm test", reasons: ["continue-on-error"], seconds: null },
        { name: "example/reporter@v1", reasons: ["exit-code: 0"], seconds: null },
      ],
    }]);
    expect(signal.empty_stub).toEqual({ select_p50_s: 90, select_runs: 5, check_skipped: 5, check_ran: 0 });
    expect(signal.duplicates).toEqual([{ command: "pnpm test", workflows: [".github/workflows/ci.yml", ".github/workflows/report.yml"] }]);
    expect(signal.push_to_main).toEqual([{ workflow: "Nightly", file: ".github/workflows/nightly.yml", runs: 1, minutes_per_week: 0.1 }]);
    expect(ciWorth(signal)).toBe(true);
    expect(ciWorth(ciSignals({ runs: [], truncated: false, workflows: [], baseBranch: "main" }))).toBe(false);
  });

  it("identifies a workflow by file path, not by the run name", () => {
    const row = parseRunList([{
      databaseId: 1,
      headSha: "abc",
      name: "Fix the flaky login",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      conclusion: "success",
      createdAt: "2026-10-20T00:00:00Z",
    }])[0]!;
    expect(row).toMatchObject({ workflow: ".github/workflows/ci.yml", path: ".github/workflows/ci.yml" });
    expect(resolveRunWorkflow(row, new Map([[".github/workflows/ci.yml", "CI"]]))).toEqual({ path: ".github/workflows/ci.yml", workflow: "CI" });
    expect(parseRunList([{ databaseId: 2, headSha: "abc", workflowName: "CI", name: "PR title", createdAt: "2026-10-20T00:00:00Z" }])[0]).toMatchObject({ workflow: "CI", path: null });

    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      sha: `s${i}`,
      workflow: `PR title ${i}`,
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-10-20T00:00:00Z",
      jobs: [{ name: "build", conclusion: "success", seconds: 180 }],
    }));
    const workflows = [{ file: ".github/workflows/ci.yml", name: "CI", path_filtered: true, jobs: [] }];
    const signal = ciSignals({ runs, truncated: false, workflows, baseBranch: "main" });
    expect(signal.never_failed).toEqual([{ workflow: "CI", name: "build", runs: 5 }]);
    expect(signal.slow_without_paths).toEqual([]);
  });

  it("reports a report-only step, and full job minutes only when every step is report-only", () => {
    const workflows = [{
      file: ".github/workflows/ci.yml",
      name: "CI",
      path_filtered: true,
      jobs: [{
        id: "test",
        name: "test",
        runs: ["pnpm test"],
        steps: [
          { name: "pnpm test", reasons: [], run: "pnpm test", uses: null },
          { name: "Upload coverage", reasons: ["continue-on-error"], run: null, uses: "codecov/codecov-action@v4" },
        ],
      }],
    }];
    const runs = [{
      id: 1,
      sha: "s",
      workflow: "CI",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-10-20T00:00:00Z",
      jobs: [{
        name: "test",
        conclusion: "success",
        seconds: 480,
        steps: [
          { name: "Run pnpm test", conclusion: "success", seconds: 470 },
          { name: "Upload coverage", conclusion: "success", seconds: 10 },
        ],
      }],
    }];
    const mixed = ciSignals({ runs, truncated: false, workflows, baseBranch: "main" });
    expect(mixed.report_only).toEqual([{
      file: ".github/workflows/ci.yml",
      job: "test",
      minutes_per_week: null,
      steps: [{ name: "Upload coverage", reasons: ["continue-on-error"], seconds: 10 }],
    }]);

    const only = structuredClone(workflows);
    only[0]!.jobs[0]!.steps[0]!.reasons = ["continue-on-error"];
    const all = ciSignals({ runs, truncated: false, workflows: only, baseBranch: "main" });
    expect(all.report_only[0]).toMatchObject({ minutes_per_week: mixed.jobs.find((j) => j.name === "test")!.minutes_per_week });
    expect(all.report_only[0]!.minutes_per_week).toBeGreaterThan(0);
  });

  it("stops at 10 pages and keeps earlier pages when the next page is HTTP 422", async () => {
    const page = (n: number, perPage: number) => Array.from({ length: perPage }, (_, i) => ({
      databaseId: (n - 1) * perPage + i + 1,
      headSha: "abc",
      path: ".github/workflows/ci.yml",
      event: "push",
      conclusion: "success",
      createdAt: "2026-10-20T00:00:00Z",
      headBranch: "main",
    }));
    const fetched: number[] = [];
    const capped = await paginateRunList(async (n, perPage) => {
      fetched.push(n);
      return page(n, perPage);
    });
    expect(fetched).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toHaveLength(1000);

    const partial = await paginateRunList(async (n, perPage) => {
      if (n === 3) throw new Error("gh api failed: HTTP 422: Invalid request\nhttps://api.github.com/repos/o/r/actions/runs?page=11");
      return page(n, perPage);
    });
    expect(partial.truncated).toBe(true);
    expect(partial.rows).toHaveLength(200);
    await expect(paginateRunList(async () => { throw new Error("gh api failed: HTTP 422"); })).rejects.toThrow(/422/);
  });

  it("computes truncated per-week figures over the days actually covered", () => {
    const now = new Date("2026-10-20T00:00:00.000Z");
    const signal = ciSignals({
      runs: [{
        id: 1,
        sha: "s",
        workflow: "CI",
        event: "push",
        conclusion: "success",
        created_at: "2026-10-18T00:00:00.000Z",
        jobs: [{ name: "build", conclusion: "success", seconds: 3600 }],
      }],
      truncated: true,
      workflows: [],
      baseBranch: "main",
      windowDays: 30,
      now,
    });
    expect(signal.window_days).toBe(2);
    expect(signal.minutes_per_week).toBe(210);
    expect(signal.truncation).toMatch(/2 days actually covered/);
    expect(signal.truncation).toMatch(/30-day window/);
  });

  it("treats high minutes alone as a signal", () => {
    const seconds = Math.ceil(HIGH_CI_MINUTES_PER_WEEK * 60 * (30 / 7)) + 60;
    const signal = ciSignals({
      runs: [{ id: 1, sha: "s", workflow: "CI", event: "pull_request", conclusion: "failure", created_at: "2026-10-20T00:00:00Z", head_branch: "feature", jobs: [{ name: "build", conclusion: "failure", seconds }] }],
      truncated: false,
      workflows: [{ file: ".github/workflows/ci.yml", name: "CI", path_filtered: true, jobs: [] }],
      baseBranch: "main",
    });
    expect(signal.never_failed).toEqual([]);
    expect(signal.slow_without_paths).toEqual([]);
    expect(signal.minutes_per_week).toBeGreaterThanOrEqual(HIGH_CI_MINUTES_PER_WEEK);
    expect(ciWorth(signal)).toBe(true);
  });
});

describe("tests signals", () => {
  it("validates optional tests.coverage", () => {
    expect(parseRepoConfig("checks: []\n").tests.coverage).toBeUndefined();
    expect(parseRepoConfig('tests: { coverage: "uv run coverage json -o coverage.json" }\n').tests.coverage).toBe("uv run coverage json -o coverage.json");
    expect(() => parseRepoConfig("tests: { coverage: '   ' }\n")).toThrow();
    expect(parseRepoConfig("improve:\n  aspects: [ci, tests]\n").improve?.thinking).toMatchObject({ ci: "high", tests: "medium" });
    expect(parseRepoConfig("improve:\n  aspects: [ci]\n  focus:\n    ci: cut minutes\n").improve?.focus.ci).toBe("cut minutes");
  });

  it("reads pytest and vitest durations, and uncovered sensitive paths first", () => {
    expect(durationCommand("uv run pytest {files}")).toEqual({ kind: "pytest", command: "uv run pytest --durations=25" });
    expect(durationCommand("pnpm exec vitest run")).toEqual({ kind: "vitest", command: "pnpm exec vitest run --reporter=json" });
    expect(durationCommand("vitest")).toEqual({ kind: "vitest", command: "vitest --run --reporter=json" });
    expect(localSignalTimeoutMs(10)).toBe(5 * 60_000);
    expect(localSignalTimeoutMs(2)).toBe(2 * 60_000);
    expect(parsePytestDurations("slowest 25 durations\n2.50s call tests/test_auth.py::test_slow\n0.01s call tests/test_auth.py::test_fast\n====")).toEqual([
      { name: "tests/test_auth.py::test_slow", seconds: 2.5 },
    ]);
    expect(parseReporterDurations(JSON.stringify({ testResults: [{ assertionResults: [{ fullName: "auth > slow", duration: 2500 }, { fullName: "auth > fast", duration: 10 }] }] }))).toEqual([
      { name: "auth > slow", seconds: 2.5 },
    ]);
    const reports = parseCoverageReport(JSON.stringify({ files: { "src/auth.py": { summary: { missing_lines: 4 } }, "src/ok.py": { summary: { missing_lines: 0 } } } }), "coverage.json");
    expect(uncoveredCritical("/repo", reports, ["src/auth.py"])).toEqual([{ path: "src/auth.py", sensitive: true, missed: 4 }]);
  });

  it("collects flaky memory, never-failed test jobs and a coverage report", async () => {
    const dir = join(tmpdir(), `improve-tests-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const repo = parseRepoConfig('tests: { coverage: "write-coverage" }\nsensitive_paths: ["src/auth.py"]\n');
    const mem: MemoryFile = { version: 1, repo: "r", entries: [entry("flaky:unit", { count: 3 }), entry("other", { count: 4 })] };
    const runs = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      sha: `s${i}`,
      workflow: "CI",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-10-20T00:00:00Z",
      jobs: [{ name: "unit", conclusion: "success", seconds: 10 }],
    }));
    const signal = await collectTestSignals({
      repoDir: dir,
      repo,
      mem,
      runs,
      isolate: async (_repoDir, _repo, fn) => {
        const wt = mkdtempSync(join(tmpdir(), "improve-tests-wt-"));
        try {
          await fn(wt);
        } finally {
          rmSync(wt, { recursive: true, force: true });
        }
      },
      exec: async (command, cwd) => {
        expect(command).toBe("write-coverage");
        expect(cwd).not.toBe(dir);
        writeFileSync(join(cwd, "coverage.json"), JSON.stringify({ files: { "src/auth.py": { summary: { missing_lines: 2 } }, "src/other.py": { summary: { missing_lines: 9 } } } }));
        return { stdout: "", stderr: "" };
      },
    });
    expect(signal.flaky).toEqual([{ key: "flaky:unit", text: "finding flaky:unit", count: 3 }]);
    expect(signal.never_failed).toEqual([{ workflow: "CI", name: "unit", runs: 5 }]);
    expect(signal.coverage?.uncovered).toEqual([
      { path: "src/auth.py", sensitive: true, missed: 2 },
      { path: "src/other.py", sensitive: false, missed: 9 },
    ]);
    expect(signal.coverage?.error).toBeNull();
    expect(existsSync(join(dir, "coverage.json"))).toBe(false);
  });

  it("keeps durations when the runner exits non-zero, and caps the command timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "improve-tests-fail-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const repo = parseRepoConfig("limits: { command_timeout_minutes: 10 }\n");
    expect(runnerInvocation(dir, repo)).toEqual({ kind: "vitest", command: "pnpm test -- --run --reporter=json" });
    const seen: number[] = [];
    const signal = await collectTestSignals({
      repoDir: dir,
      repo,
      mem: { version: 1, repo: "r", entries: [] },
      runs: [],
      isolate: async (_repoDir, _repo, fn) => fn(dir),
      exec: async (_command, _cwd, timeoutMs) => {
        seen.push(timeoutMs);
        throw Object.assign(new Error("Command failed: exit 1"), {
          stdout: JSON.stringify({ testResults: [{ assertionResults: [{ fullName: "auth > slow", duration: 2500 }] }] }),
          stderr: "FAIL auth",
        });
      },
    });
    expect(seen).toEqual([5 * 60_000]);
    expect(signal.slowest).toEqual([{ name: "auth > slow", seconds: 2.5 }]);
    expect(signal.duration_error).toBeNull();
  });

  it("runs coverage in a temporary base worktree with CI=1 and removes it", async () => {
    const dir = makeRepo({ "README.md": "hi\n" });
    writeFileSync(join(dir, "DIRTY"), "x");
    const coverage = `node -e 'if (process.env.CI !== "1") process.exit(2); require("fs").writeFileSync("coverage.json", JSON.stringify({files:{"src/a.py":{summary:{missing_lines:3}}}}))'`;
    const repo = parseRepoConfig(`tests: { coverage: ${JSON.stringify(coverage)} }\nsensitive_paths: ["src/a.py"]\n`);
    const signal = await collectTestSignals({
      repoDir: dir,
      repo,
      mem: { version: 1, repo: "r", entries: [] },
      runs: [],
    });
    expect(signal.coverage?.error).toBeNull();
    expect(signal.coverage?.uncovered).toEqual([{ path: "src/a.py", sensitive: true, missed: 3 }]);
    expect(existsSync(join(dir, "coverage.json"))).toBe(false);
    expect(existsSync(join(dir, "DIRTY"))).toBe(true);
    expect(gitIn(dir, "worktree", "list").trim().split("\n")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
