import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedSuppressions, configChange, configGuard, configGuardInputs } from "../../src/gates/config-guard.js";
import type { Plan } from "../../src/schemas/plan.js";
import { gitIn } from "../helpers/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";

const plan = (files: string[], description = ""): Plan =>
  ({
    version: 1,
    type: "feature",
    goal: "g",
    context: "",
    packages: [{ id: "P1", title: "t", description, files, depends_on: [], changes_flows: [] }],
    acceptance: [{ id: "A1", package: "P1", text: "works", verify: "test", kind: "behavior", risk: false }],
    out_of_scope: [],
  }) as unknown as Plan;

describe("config guard: what counts", () => {
  it("whole-file tool configs: any change; absent → present counts", () => {
    for (const f of ["ruff.toml", "pkg/.eslintrc.json", "eslint.config.js", "biome.json", ".prettierrc", "pyrightconfig.json", "mypy.ini"]) expect(configChange(f, "a", "b")).toBeDefined();
    expect(configChange("eslint.config.js", undefined, "x")).toBeDefined();
    expect(configChange("ruff.toml", "same", "same")).toBeUndefined();
  });

  it("pyproject: only [tool.ruff|pyright|mypy|coverage|pytest] sections", () => {
    const base = '[project]\nname = "a"\n\n[tool.ruff.lint]\nselect = ["E"]\n';
    expect(configChange("pyproject.toml", base, base.replace('name = "a"', 'name = "b"'))).toBeUndefined();
    expect(configChange("pyproject.toml", base, base.replace('["E"]', '["E", "F"]'))).toMatch(/\[tool\.\*\]/);
    expect(configChange("pyproject.toml", base, `${base}\n[tool.mypy]\nignore_errors = true\n`)).toBeDefined();
    expect(configChange("pyproject.toml", base, `${base}\n[tool.coverage.report]\nfail_under = 50\n`)).toBeDefined();
  });

  it("tsconfig: only strictness flags; test runners: only coverage thresholds", () => {
    const ts = '{ "compilerOptions": { "strict": true, "outDir": "dist" } }';
    expect(configChange("tsconfig.json", ts, ts.replace("dist", "build"))).toBeUndefined();
    expect(configChange("tsconfig.build.json", ts, ts.replace('"strict": true', '"strict": false'))).toBe("tsconfig strictness flags changed");
    expect(configChange("tsconfig.json", ts, ts.replace("}", ', "skipLibCheck": true }'))).toBeDefined();
    const vt = "export default { test: { coverage: { thresholds: { lines: 90 } } } };";
    expect(configChange("vitest.config.ts", vt, vt.replace("90", "60"))).toBe("coverage thresholds changed");
    expect(configChange("vitest.config.ts", vt, `${vt}\n// note`)).toBeUndefined();
    expect(configChange("package.json", '{"jest":{"coverageThreshold":{"global":{"lines":80}}}}', '{"jest":{"coverageThreshold":{"global":{"lines":10}}}}')).toBeDefined();
    expect(configChange("package.json", '{"version":"1"}', '{"version":"2"}')).toBeUndefined();
    expect(configChange("src/app.ts", "a", "b")).toBeUndefined();
  });

  it("suppressions on added lines only", () => {
    const diff = [
      "--- a/src/a.py",
      "+++ b/src/a.py",
      "-x = 1  # noqa: E501",
      "+import os  # noqa: F401",
      "+y: int = f()  # type: ignore[assignment]",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "+// eslint-disable-next-line no-console",
      "+// @ts-expect-error untyped lib",
      "+// biome-ignore lint: x",
      " const ok = 1; // @ts-ignore (context line)",
      '+const msg = "never use eslint-disable here";',
      "--- a/README.md",
      "+++ b/README.md",
      "+Do not add `# noqa` or `// @ts-ignore`.",
    ].join("\n");
    expect(addedSuppressions(diff).map((s) => [s.file, s.marker])).toEqual([
      ["src/a.py", "noqa"],
      ["src/a.py", "type: ignore"],
      ["src/b.ts", "eslint-disable"],
      ["src/b.ts", "@ts-expect-error"],
      ["src/b.ts", "biome-ignore"],
    ]);
  });
});

describe("config guard: scope", () => {
  const changes = [{ file: "ruff.toml", why: "linter/formatter/type-checker config changed" }];
  const sup = [{ file: "src/a.py", marker: "noqa", line: "import os  # noqa: F401" }];

  it("fails (as a bug) when the plan does not put the config or the suppression in scope", () => {
    const r = configGuard({ plan: plan(["src/a.py"]), packages: ["P1"], configChanges: changes, suppressions: sup });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("(bug)");
    expect(r.detail).toContain("ruff.toml: linter/formatter/type-checker config changed (not in the plan's files)");
    expect(r.detail).toContain("src/a.py: adds `noqa`");
  });

  it("passes when the package lists the config file and names the suppression", () => {
    expect(configGuard({ plan: plan(["ruff.toml", "src/a.py"], "Enable rule F401 in ruff.toml; the re-export needs a noqa"), packages: ["P1"], configChanges: changes, suppressions: sup }).ok).toBe(true);
    expect(configGuard({ plan: plan(["src/a.py"]), packages: ["P1"], configChanges: [], suppressions: [] }).ok).toBe(true);
  });

  it("collects both from a worktree against the base (new files included once staged)", async () => {
    const dir = makeRepo({ "pyproject.toml": '[project]\nname = "a"\n', "src/a.py": "x = 1\n" });
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "a"\n\n[tool.ruff]\nline-length = 200\n');
    writeFileSync(join(dir, "src/b.py"), "import os  # noqa\n");
    gitIn(dir, "add", "-A");
    const got = await configGuardInputs(dir, base, ["pyproject.toml", "src/b.py"]);
    expect(got.configChanges).toEqual([{ file: "pyproject.toml", why: "[tool.*] lint/type/test config in pyproject.toml changed" }]);
    expect(got.suppressions).toEqual([{ file: "src/b.py", marker: "noqa", line: "import os  # noqa" }]);
  });
});
