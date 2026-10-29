import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect, noxSessions } from "../../src/adopt/detect.js";
import { draftChecks, draftRepoYaml, SLOW_CHECK_SECONDS, testStrategySection, withTestStrategy } from "../../src/adopt/draft.js";
import { classifyLegacy, keepMatcher, lineCovered } from "../../src/adopt/legacy.js";
import { measureChecks } from "../../src/adopt/measure.js";
import { trimAgentsMd } from "../../src/adopt/agents-md.js";
import { settingsHints } from "../../src/commands/adopt.js";
import { gitIn } from "../helpers/repo.js";
import { legacyNodeRepo, makeRepo } from "../helpers/adopt-repo.js";

const files = (dir: string) => gitIn(dir, "ls-files").split("\n").filter(Boolean);

describe("adopt detect", () => {
  it("node: package manager, scripts as checks, tests, UI, DB, workflows, special jobs", () => {
    const dir = legacyNodeRepo();
    const d = detect(dir, files(dir));
    expect(d.stacks).toEqual(["node"]);
    expect(d.package_manager).toBe("pnpm");
    expect(d.setup).toBe("pnpm install --frozen-lockfile");
    expect(d.candidates.map((c) => [c.name, c.run, c.kind])).toEqual([
      ["typecheck", "pnpm run typecheck", "typecheck"],
      ["lint", "pnpm run lint", "lint"],
      ["test", "pnpm run test", "test"],
      ["e2e", "pnpm run test:e2e", "e2e"],
      ["build", "pnpm run build", "build"],
    ]);
    expect(d.tests.run).toBe("pnpm exec vitest run {files}");
    expect(d.tests.globs).toEqual(["**/*.test.*", "**/*.spec.*"]);
    expect(d.ui.present).toBe(true);
    expect(d.db.reasons.join()).toContain("pg");
    expect(d.workflows.map((w) => w.file)).toEqual([".github/workflows/ci.yml", ".github/workflows/claude.yml", ".github/workflows/deploy.yml", ".github/workflows/release.yml", ".github/workflows/security.yml"]);
    expect(d.special_jobs).toEqual([{ workflow: ".github/workflows/security.yml", job: "gitleaks", tool: "gitleaks" }]);
  });

  it("python with uv and nox: sessions become checks; defaults parsed", () => {
    const nox = `import nox\nnox.options.sessions = ["lint", "tests"]\n\n@nox.session(python="3.12")\ndef lint(session):\n    pass\n\n@nox.session(name="types")\ndef typecheck(session):\n    pass\n\n@nox.session\n@nox.parametrize("x", [1])\ndef tests(session, x):\n    pass\n`;
    const dir = makeRepo({ "pyproject.toml": "[project]\nname='a'\ndependencies=['sqlalchemy']\n", "uv.lock": "", "noxfile.py": nox, "tests/test_a.py": "def test_a(): pass\n" });
    const d = detect(dir, files(dir));
    expect(noxSessions(nox)).toEqual({ sessions: ["lint", "types", "tests"], defaults: ["lint", "tests"] });
    expect(d.stacks).toEqual(["python"]);
    expect(d.setup).toBe("uv sync --locked");
    expect(d.candidates.map((c) => c.run)).toEqual(["uv run --locked nox -s lint", "uv run --locked nox -s types", "uv run --locked nox -s tests"]);
    expect(d.candidates.map((c) => c.kind)).toEqual(["lint", "typecheck", "test"]);
    expect(d.tests).toEqual({ globs: ["tests/**", "**/test_*.py"], run: "uv run --locked pytest {files}" });
    expect(d.db.present).toBe(true);
  });

  it("python without nox: ruff, mypy and pytest from pyproject", () => {
    const dir = makeRepo({ "pyproject.toml": "[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n", "poetry.lock": "" });
    const d = detect(dir, files(dir));
    expect(d.candidates.map((c) => c.run)).toEqual(["poetry run ruff check .", "poetry run ruff format --check .", "poetry run mypy .", "poetry run pytest"]);
  });
});

describe("adopt legacy", () => {
  const checks = [{ run: "pnpm run typecheck" }, { run: "pnpm run lint" }, { run: "pnpm run test" }, { run: "uv run --locked nox -s tests" }, { run: "uv run --locked ruff check ." }];

  it("lineCovered: setup and drafted checks cover a line; anything else does not", () => {
    expect(lineCovered("pnpm install --frozen-lockfile", checks, "")).toBe(true);
    expect(lineCovered("pnpm lint && pnpm test", checks, "")).toBe(true);
    expect(lineCovered("npm run typecheck", checks, "")).toBe(true);
    expect(lineCovered("uv run nox -s tests", checks, "")).toBe(true);
    expect(lineCovered("uv run nox -s docs", checks, "")).toBe(false);
    expect(lineCovered("ruff check src", checks, "")).toBe(true);
    expect(lineCovered("pnpm lint\n./scripts/smoke.sh", checks, "")).toBe(false);
  });

  it("removes known coding configs and covered CI, proposes the uncertain, never touches non-PR workflows", () => {
    const dir = legacyNodeRepo();
    const d = detect(dir, files(dir));
    const r = classifyLegacy({ files: files(dir), workflows: d.workflows, checks: d.candidates, setup: d.setup, agentsMd: undefined, keep: [] });
    expect(r.removed.map((i) => i.path).sort()).toEqual(
      [
        ".claude/agents/reviewer.md",
        ".claude/settings.json",
        ".cursor/BUGBOT.md",
        ".cursor/config/bugbot.yaml",
        ".github/workflows/ci.yml",
        ".github/workflows/claude.yml",
        "CLAUDE.md",
        "opencode.json",
      ].sort(),
    );
    // .grok/ holds a skills folder: operator tooling (e.g. a /maintain ops command), so nothing in it is deleted.
    expect(r.proposed.map((i) => i.path).sort()).toEqual([".cursor/environment.json", ".github/workflows/security.yml", ".grok/commands/maintain.md", ".grok/config.toml", ".grok/skills/server-ops/SKILL.md", ".opencode/skills/vm/scripts/run.sh"]);
    expect(r.proposed.find((i) => i.path === ".grok/commands/maintain.md")!.reason).toMatch(/operator tooling/);
    expect(r.proposed.find((i) => i.path.endsWith("security.yml"))!.reason).toContain("gitleaks");
    expect(r.kept).toEqual([]);
  });

  it("--keep spares globs, exact paths and directories", () => {
    const dir = legacyNodeRepo();
    const d = detect(dir, files(dir));
    const r = classifyLegacy({ files: files(dir), workflows: d.workflows, checks: d.candidates, setup: d.setup, keep: ["CLAUDE.md", ".claude/", ".github/workflows/claude.yml"] });
    expect(r.kept.map((i) => i.path).sort()).toEqual([".claude/agents/reviewer.md", ".claude/settings.json", ".github/workflows/claude.yml", "CLAUDE.md"]);
    expect(r.removed.map((i) => i.path)).not.toContain("CLAUDE.md");
    expect(keepMatcher([".grok/**"])(".grok/a/b")).toBe(true);
    expect(keepMatcher(["docs"])("docsx/a")).toBe(false);
  });

  it("an uncovered PR workflow is only proposed, with the line no check covers", () => {
    const wf = `on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test\n      - run: ./scripts/smoke.sh\n`;
    const dir = makeRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), ".github/workflows/t.yml": wf });
    const d = detect(dir, files(dir));
    const r = classifyLegacy({ files: files(dir), workflows: d.workflows, checks: d.candidates, setup: d.setup, keep: [] });
    expect(r.removed).toEqual([]);
    expect(r.proposed[0]!.reason).toContain("./scripts/smoke.sh");
  });

  it("AGENTS.md: workflow and tool sections are proposed, not edited", () => {
    expect(trimAgentsMd("# A\n\n## Rules\n- small\n\n## Workflow\nRun the opencode runner.\n\n## Grok\nx\n").proposed.map((p) => p.title)).toEqual(["Workflow", "Grok"]);
  });
});

describe("adopt draft", () => {
  it("tiers: secrets → manual, failed → manual, services → full, e2e/build → full, slow → full", () => {
    const wf = `on: pull_request\njobs:\n  db:\n    runs-on: ubuntu-latest\n    services:\n      postgres:\n        image: postgres\n    steps:\n      - run: pnpm test\n  cloud:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run deploy-check\n        env:\n          KEY: \${{ secrets.KEY }}\n`;
    const pkg = { scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest", e2e: "playwright test", "deploy-check": "x" } };
    const dir = makeRepo({ "package.json": JSON.stringify(pkg), "package-lock.json": "{}", ".github/workflows/ci.yml": wf });
    const d = detect(dir, files(dir));
    d.candidates.push({ name: "deploy", run: "npm run deploy-check", kind: "other", source: "test" });
    const m = {
      setup: { ok: true, seconds: 3, detail: "" },
      checks: [
        { name: "typecheck", ok: true, seconds: SLOW_CHECK_SECONDS + 1, detail: "" },
        { name: "lint", ok: false, seconds: 2, detail: "boom" },
      ],
    };
    const tiers = Object.fromEntries(draftChecks(d, m).map((c) => [c.name, c.tier]));
    expect(tiers).toEqual({ typecheck: "full", lint: "manual", test: "full", e2e: "full", deploy: "manual" });
  });

  it("repo.yaml is valid, commented and has the defaults adopt promises", () => {
    const dir = legacyNodeRepo();
    const d = detect(dir, files(dir));
    const checks = draftChecks(d, null);
    const { text, config } = draftRepoYaml({ detection: d, checks, baseBranch: "main", date: "2026-10-29" });
    expect(text).toMatch(/^# Drafted by `factory adopt` on 2026-10-29/);
    expect(text).toContain("# full: e2e check; not measured\n  - name: e2e");
    expect(config.checks.map((c) => c.tier)).toEqual(["fast", "fast", "fast", "full", "full"]);
    expect(config.human_only_paths).toEqual([".factory/**", ".github/workflows/**"]);
    expect(config.sensitive_paths).toEqual(["**/migrations/**"]);
    expect(config.merge.auto_merge_max_risk).toBe("none");
    expect(config.tests.run).toBe("pnpm exec vitest run {files}");
  });

  it("AGENTS.md test strategy: appended once, created when missing", () => {
    const dir = legacyNodeRepo();
    const d = detect(dir, files(dir));
    const section = testStrategySection(d, draftChecks(d, null));
    expect(section).toContain("## Test strategy");
    expect(section).toContain("E2E: `pnpm run test:e2e`");
    expect(withTestStrategy("# A\n", section)).toBe(`# A\n\n${section}`);
    expect(withTestStrategy("# A\n\n## Test Strategy\nx\n", section)).toBeUndefined();
    expect(withTestStrategy(undefined, section)).toBe(`# AGENTS.md\n\n${section}`);
  });

  it("settings are only hints, Pro caveat for private repos", () => {
    expect(settingsHints({ private: true, auto_merge_allowed: false, branch_protected: false, required_checks: [] }, "main").join("\n")).toMatch(/factory \/ done.*GitHub Pro[\s\S]*Allow auto-merge/);
    expect(settingsHints({ private: false, auto_merge_allowed: true, branch_protected: true, required_checks: ["factory / done"] }, "main")).toEqual([]);
  });
});

describe("adopt measure", () => {
  it("runs setup and each check once with durations; a failed setup skips the checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-measure-"));
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const ok = await measureChecks(dir, "touch setup-ran", [{ name: "a", run: "test -f setup-ran" }, { name: "b", run: "echo nope; exit 3" }], { factoryHome: home });
    expect(ok.setup!.ok).toBe(true);
    expect(ok.checks.map((c) => [c.name, c.ok])).toEqual([["a", true], ["b", false]]);
    expect(ok.checks[1]!.detail).toContain("nope");
    expect(typeof ok.checks[0]!.seconds).toBe("number");
    const bad = await measureChecks(dir, "exit 1", [{ name: "a", run: "true" }], { factoryHome: home });
    expect(bad.checks).toEqual([{ name: "a", ok: null, seconds: null, detail: "setup failed" }]);
  });
});
