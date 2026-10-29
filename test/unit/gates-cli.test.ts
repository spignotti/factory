import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { createFixtureRepo, gitIn } from "../helpers/repo.js";

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const code = await main(args, { out: (s) => void (out += s), err: (s) => void (err += s) });
  return { code, out, err };
}

describe("factory gates CLI on the fixture repo", () => {
  // Port slots of services live under $FACTORY_HOME; never the real one.
  const prevHome = process.env.FACTORY_HOME;
  beforeEach(() => void (process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "gates-home-"))));
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = prevHome;
  });

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

  it("--run starts the check's services (unsandboxed, own port slot) and stops them afterwards", async () => {
    const serve = `node -e "require('http').createServer((q,r)=>r.end('hello')).listen(Number(process.argv[1]),'0.0.0.0')" {port:web}`;
    const fetchIt = `node -e "fetch(process.env.WEB_URL).then(r=>r.text()).then(t=>process.exit(t==='hello'?0:1),()=>process.exit(2))"`;
    const repo = createFixtureRepo((c) => {
      c.services = [{ name: "web", start: serve, env: { WEB_URL: "http://127.0.0.1:{port:web}/" }, ready_timeout_s: 20 }];
      (c.checks as unknown[]).push({ name: "web", run: fetchIt, tier: "full", services: ["web"] });
    });
    const r = await cli(["gates", "--run", "web", "--repo", repo, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ green: true, checks: [{ name: "web", status: "pass" }] });
    expect(readdirSync(join(process.env.FACTORY_HOME!, "ports"))).toEqual([]);
  }, 30_000);

  it("--run with a service that does not start: exit 1 with env_missing", async () => {
    const repo = createFixtureRepo((c) => {
      c.services = [{ name: "db", start: "exit 4" }];
      (c.checks as unknown[]).push({ name: "db-test", run: "true", tier: "full", services: ["db"] });
    });
    const r = await cli(["gates", "--run", "db-test", "--repo", repo, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ green: false, checks: [] });
    expect(r.err).toMatch(/env_missing: service db exited with code 4/);
  });

  it("rejects unknown checks and missing mode", async () => {
    const repo = createFixtureRepo();
    expect((await cli(["gates", "--run", "nope", "--repo", repo])).code).toBe(2);
    expect((await cli(["gates", "--repo", repo])).code).toBe(2);
  });
});

describe("factory resume CLI", () => {
  it("needs exactly one run id and lists resume in the usage", async () => {
    const r = await cli(["resume"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("factory resume <run-id>");
  });
});
