import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect } from "../../src/adopt/detect.js";
import { draftChecks, dropMutating } from "../../src/adopt/draft.js";
import { measureChecks } from "../../src/adopt/measure.js";
import { analyzeCommand, mutatingName, noxSessionBodies, readOnlyCommand } from "../../src/adopt/mutation.js";
import { gitIn } from "../helpers/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";

const files = (dir: string) => gitIn(dir, "ls-files").split("\n").filter(Boolean);
const argv = (s: string) => s.split(" ");

// The shape of tourenpilot's noxfile: format/fix rewrite files, test and test_unit are the same.
const NOX = `import nox

nox.options.sessions = ["lint", "typecheck", "test"]


@nox.session(venv_backend="none")
def lint(session: nox.Session) -> None:
    session.run("uv", "run", "ruff", "check", ".", external=True)


@nox.session(venv_backend="none")
def format(session: nox.Session) -> None:
    session.run("uv", "run", "ruff", "format", ".", external=True)


@nox.session(venv_backend="none")
def fix(session: nox.Session) -> None:
    session.run("uv", "run", "ruff", "check", "--fix", ".", external=True)
    session.run("uv", "run", "ruff", "format", ".", external=True)


@nox.session(venv_backend="none")
def test_unit(session: nox.Session) -> None:
    """Run unit tests."""
    session.run(
        "uv",
        "run",
        "pytest",
        "-m",
        "not integration",
        external=True,
    )


@nox.session(venv_backend="none")
def test_db(session: nox.Session) -> None:
    session.run("uv", "run", "pytest", "tests/integration", env={"REQUIRE_DB": "1"}, external=True)


@nox.session
def style(session):
    for tool in ["black", "isort"]:
        session.run(tool, ".")


@nox.session(venv_backend="none")
def test(session: nox.Session) -> None:
    """Run unit tests."""
    session.run("uv", "run", "pytest", "-m", "not integration", external=True)
`;

describe("adopt: mutating commands", () => {
  it("knows formatters and fixers and their check-only variants", () => {
    expect(analyzeCommand(argv("uv run ruff format ."))).toMatchObject({ mutates: true, check: argv("uv run ruff format --check .") });
    expect(analyzeCommand(argv("ruff format --check ."))).toEqual({ mutates: false });
    expect(analyzeCommand(argv("ruff check --fix ."))).toMatchObject({ mutates: true, check: argv("ruff check .") });
    expect(analyzeCommand(argv("poetry run black src"))).toMatchObject({ check: argv("poetry run black --check src") });
    expect(analyzeCommand(argv("isort ."))).toMatchObject({ check: argv("isort --check-only .") });
    expect(analyzeCommand(argv("prettier --write ."))).toMatchObject({ check: argv("prettier --check .") });
    expect(analyzeCommand(argv("eslint . --fix"))).toMatchObject({ check: argv("eslint .") });
    expect(analyzeCommand(argv("cargo fmt"))).toMatchObject({ check: argv("cargo fmt --check") });
    expect(analyzeCommand(argv("uv lock"))).toMatchObject({ mutates: true, check: null });
    expect(analyzeCommand(argv("pre-commit run --all-files"))).toMatchObject({ mutates: true, check: null });
    expect(analyzeCommand(argv("uv run pytest -q"))).toEqual({ mutates: false });
    expect(analyzeCommand(argv("pnpm exec vitest run"))).toEqual({ mutates: false });
  });

  it("rewrites a whole command line only when every mutating part has a variant", () => {
    expect(readOnlyCommand("tsc --noEmit")).toEqual({ run: "tsc --noEmit", changed: false, why: [] });
    expect(readOnlyCommand("eslint . --fix && prettier --write src")).toMatchObject({ run: "eslint . && prettier --check src", changed: true });
    expect(readOnlyCommand("ruff check --fix . && uv lock")).toBeNull();
  });

  it("fix-type names", () => {
    for (const n of ["fix", "autofix", "lint_fix", "lint:fix", "format-write", "lock", "update_deps", "release"]) expect(mutatingName(n)).toBe(true);
    for (const n of ["lint", "format", "test_unit", "typecheck", "prefix", "fixtures"]) expect(mutatingName(n)).toBe(false);
  });

  it("reads nox session bodies; opaque bodies (loops, helpers) are null", () => {
    const b = new Map(noxSessionBodies(NOX).map((x) => [x.name, x]));
    expect(b.get("format")).toEqual({ name: "format", commands: [argv("uv run ruff format .")], external: true });
    expect(b.get("test_unit")!.commands).toEqual([["uv", "run", "pytest", "-m", "not integration"]]);
    expect(b.get("test_db")!.commands).toEqual([["uv", "run", "pytest", "tests/integration"]]);
    expect(b.get("style")).toMatchObject({ commands: null, external: false });
  });
});

describe("adopt detect: no mutating checks, no duplicates", () => {
  it("nox: format → its --check variant, fix and opaque formatter sessions dropped, test deduped to test_unit", () => {
    const dir = makeRepo({ "pyproject.toml": "[project]\nname='a'\n", "uv.lock": "", "noxfile.py": NOX });
    const d = detect(dir, files(dir));
    expect(d.candidates.map((c) => [c.name, c.run])).toEqual([
      ["lint", "uv run --locked nox -s lint"],
      ["format", "uv run ruff format --check ."],
      ["test_unit", "uv run --locked nox -s test_unit"],
      ["test_db", "uv run --locked nox -s test_db"],
    ]);
    expect(d.skipped.map((s) => [s.name, s.reason])).toEqual([
      ["fix", "fix/maintenance session (changes files)"],
      ["style", "formatter session whose commands could not be read; add a --check variant by hand"],
      ["test", 'same command as "test_unit"'],
    ]);
  });

  it("node: a fixing lint script runs as its check-only variant; a script with no variant is skipped", () => {
    const pkg = { name: "a", scripts: { lint: "eslint . --fix", "format:check": "prettier --write . && uv lock", test: "vitest run" } };
    const dir = makeRepo({ "package.json": JSON.stringify(pkg), "pnpm-lock.yaml": "" });
    const d = detect(dir, files(dir));
    expect(d.candidates.map((c) => [c.name, c.run])).toEqual([
      ["lint", "pnpm exec eslint ."],
      ["test", "pnpm run test"],
    ]);
    expect(d.skipped).toEqual([{ name: "format", run: "pnpm run format:check", source: 'package.json script "format:check"', reason: "changes files and has no obvious check-only variant" }]);
  });

  it("identical commands under two names keep the more specific name", () => {
    const pkg = { name: "a", scripts: { test: "vitest run", "test:unit": "vitest run" } };
    const dir = makeRepo({ "package.json": JSON.stringify(pkg), "pnpm-lock.yaml": "" });
    // NODE_SCRIPTS maps both to the name "test": only the first is a candidate, so no duplicate.
    expect(detect(dir, files(dir)).candidates.map((c) => c.name)).toEqual(["test"]);
  });
});

describe("adopt measure: mutation", () => {
  it("a check that changes tracked files is reported, the files restored, and the check not drafted", async () => {
    const dir = makeRepo({ "a.txt": "a\n", "package.json": JSON.stringify({ name: "a", scripts: { lint: "node lint.js", test: "node t.js" } }), "pnpm-lock.yaml": "" });
    writeFileSync(join(dir, "setup-changed.txt"), "untracked\n");
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const m = await measureChecks(dir, "", [
      { name: "lint", run: "echo b >> a.txt" },
      { name: "test", run: "grep -qx a a.txt && echo out > new-untracked.txt" },
    ], { factoryHome: home });
    expect(m.checks.map((c) => [c.name, c.ok, c.mutated])).toEqual([["lint", true, ["a.txt"]], ["test", true, []]]);
    expect(gitIn(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
    const d = detect(dir, files(dir));
    dropMutating(d, m);
    expect(draftChecks(d, m).map((c) => c.name)).toEqual(["test"]);
    expect(d.skipped).toEqual([{ name: "lint", run: "pnpm run lint", source: 'package.json script "lint"', reason: "changed files when measured (a.txt)" }]);
  });

  it("outside a git worktree mutation is not measured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-measure-"));
    const m = await measureChecks(dir, "", [{ name: "a", run: "true" }], { factoryHome: mkdtempSync(join(tmpdir(), "fh-")) });
    expect(m.checks[0]!.mutated).toBeNull();
  });
});
