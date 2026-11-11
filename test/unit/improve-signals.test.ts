import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciRunListArgs, foldRunListPages, paginateRunList, parseRunList, parseRunView } from "../../src/ci-history.js";
import { assembleRuns, ciSignals, ciWorth, HIGH_CI_MINUTES_PER_WEEK, readCiWorkflows } from "../../src/improve/ci-signals.js";
import { collectTestSignals, durationCommand, parseCoverageReport, parsePytestDurations, parseReporterDurations, uncoveredCritical } from "../../src/improve/test-signals.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { entry } from "../helpers/harden.js";
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
      { name: "select", conclusion: "success", seconds: 90 },
      { name: "check (lint)", conclusion: "skipped", seconds: null },
      { name: "done", conclusion: "success", seconds: 4 },
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
    expect(signal.report_only).toEqual([{ file: ".github/workflows/report.yml", job: "audit", reasons: ["continue-on-error", "exit-code: 0"], minutes_per_week: 0.3 }]);
    expect(signal.empty_stub).toEqual({ select_p50_s: 90, select_runs: 5, check_skipped: 5, check_ran: 0 });
    expect(signal.duplicates).toEqual([{ command: "pnpm test", workflows: [".github/workflows/ci.yml", ".github/workflows/report.yml"] }]);
    expect(signal.push_to_main).toEqual([{ workflow: "Nightly", file: ".github/workflows/nightly.yml", runs: 1, minutes_per_week: 0.1 }]);
    expect(ciWorth(signal)).toBe(true);
    expect(ciWorth(ciSignals({ runs: [], truncated: false, workflows: [], baseBranch: "main" }))).toBe(false);
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
      exec: async (command) => {
        expect(command).toBe("write-coverage");
        writeFileSync(join(dir, "coverage.json"), JSON.stringify({ files: { "src/auth.py": { summary: { missing_lines: 2 } }, "src/other.py": { summary: { missing_lines: 9 } } } }));
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
  });
});
