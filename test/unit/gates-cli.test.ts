import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { createFixtureRepo, gitIn } from "../helpers/repo.js";

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const code = await main(args, { out: (s) => void (out += s), err: (s) => void (err += s) });
  return { code, out, err };
}

describe("factory gates CLI on the fixture repo", () => {
  it("selects checks for a diff as JSON", async () => {
    const repo = createFixtureRepo();
    gitIn(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "src/math.js"), "export const sum = (a, b) => a + b;\n");
    gitIn(repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "x");

    const fast = await cli(["gates", "--select", "--repo", repo, "--base", "main", "--json"]);
    expect(fast.code).toBe(0);
    expect(JSON.parse(fast.out)).toEqual(["syntax", "unit"]);

    const full = await cli(["gates", "--select", "--tier", "full", "--repo", repo, "--base", "main", "--json"]);
    expect(JSON.parse(full.out)).toEqual(["syntax", "unit", "suite"]);

    const manual = await cli(["gates", "--select", "--tier", "manual", "--repo", repo, "--base", "main", "--json"]);
    expect(JSON.parse(manual.out)).toEqual(["cloud"]);
  });

  it("defaults the base to the repo's base branch and sees working-tree changes", async () => {
    const repo = createFixtureRepo();
    writeFileSync(join(repo, "docs.md"), "x");
    const r = await cli(["gates", "--select", "--repo", repo, "--json"]);
    expect(JSON.parse(r.out)).toEqual(["syntax"]);
  });

  it("runs a check with --json and reports failures", async () => {
    const repo = createFixtureRepo();
    const ok = await cli(["gates", "--run", "unit", "--repo", repo, "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ green: true, checks: [{ name: "unit", status: "pass" }] });

    const bad = await cli(["gates", "--run", "cloud", "--repo", repo, "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ green: false, checks: [{ name: "cloud", status: "fail" }] });
  });

  it("runs all selected checks", async () => {
    const repo = createFixtureRepo();
    writeFileSync(join(repo, "src/math.js"), "export const sum = (a, b) => a + b;\n");
    const r = await cli(["gates", "--run", "selected", "--repo", repo, "--json"]);
    expect(JSON.parse(r.out).checks.map((c: { name: string }) => c.name)).toEqual(["syntax", "unit"]);
  });

  it("rejects unknown checks and missing mode", async () => {
    const repo = createFixtureRepo();
    expect((await cli(["gates", "--run", "nope", "--repo", repo])).code).toBe(2);
    expect((await cli(["gates", "--repo", repo])).code).toBe(2);
  });
});
