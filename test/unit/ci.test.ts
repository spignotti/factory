import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_STUB_PATH, CI_TEMPLATE, ciStubCheck, otherPrWorkflows, renderCiStub, sha256 } from "../../src/ci.js";
import { defaultRef, main } from "../../src/cli.js";
import { ciChecks } from "../../src/commands/doctor.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { createFixtureRepo } from "../helpers/repo.js";

const write = (repo: string, path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

describe("CI stub", () => {
  it("template: every PR, select → check matrix → done; done is red when selection failed", () => {
    const wf = parse(renderCiStub("v1.2.3")) as { on: Record<string, unknown>; jobs: Record<string, { needs?: string[]; if?: string; steps: { run?: string; env?: Record<string, string> }[] }>; env: Record<string, string> };
    expect(Object.keys(wf.on)).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(wf.on.pull_request).toBeNull(); // no branch filter: every PR
    expect(Object.keys(wf.jobs)).toEqual(["select", "check", "done"]);
    expect(wf.env.FACTORY).toBe("npx -y github:spignotti/factory#v1.2.3");
    const done = wf.jobs.done!;
    expect(done.needs).toEqual(["select", "check"]);
    expect(done.if).toBe("always()");
    expect(done.steps[0]!.run).toContain('test "$SELECT" = success');
    // untrusted values reach the shell through env, never interpolated into the script
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) expect(step.run ?? "").not.toContain("${{");
    expect(renderCiStub("main")).not.toContain("@FACTORY_REF@");
  });

  it("template: the check job installs the toolchains select resolved (pnpm, node, python, uv) before the check", () => {
    const wf = parse(renderCiStub("v1.2.3")) as { jobs: Record<string, { outputs?: Record<string, string>; steps: { uses?: string; if?: string; run?: string; with?: Record<string, string> }[] }> };
    expect(wf.jobs.select!.outputs!.toolchains).toBe("${{ steps.s.outputs.toolchains }}");
    expect(wf.jobs.select!.steps.at(-1)!.run).toContain("$FACTORY gates --toolchains --json");
    const steps = wf.jobs.check!.steps;
    const tc = (k: string) => `fromJson(needs.select.outputs.toolchains).${k}`;
    expect(steps.map((s) => s.uses ?? "run")).toEqual(["actions/checkout@v4", "pnpm/action-setup@v4", "actions/setup-node@v4", "actions/setup-python@v5", "astral-sh/setup-uv@v6", "run"]);
    expect(steps[1]).toMatchObject({ if: tc("pnpm"), with: { version: `\${{ ${tc("pnpm_version")} }}` } });
    expect(steps[2]).toMatchObject({ with: { "node-version": `\${{ ${tc("node")} }}` } });
    expect(steps[3]).toMatchObject({ if: `${tc("python")} != ''`, with: { "python-version": `\${{ ${tc("python")} }}` } });
    expect(steps[4]).toMatchObject({ if: tc("uv"), with: { version: `\${{ ${tc("uv_version")} }}` } });
    expect(steps[5]!.run).toBe('$FACTORY gates --run "$CHECK"');
    // the required status is the job name GitHub Actions reports
    expect(Object.keys(wf.jobs)).toContain("done");
    expect(renderCiStub("v1.2.3")).not.toContain("factory / done");
  });

  it("refs are validated", () => {
    for (const bad of ["", "v1; rm -rf /", "a b", "../x", "-x"]) expect(() => renderCiStub(bad)).toThrow(/invalid factory ref/);
  });

  it("hash check: equal → ok; edited → fail with both hashes; missing → warn; several refs → fail", () => {
    const repo = createFixtureRepo();
    expect(ciStubCheck(repo)).toMatchObject({ status: "warn", detail: expect.stringMatching(/missing/) });
    write(repo, CI_STUB_PATH, renderCiStub("v0.2.0"));
    expect(ciStubCheck(repo)).toEqual({ status: "ok", detail: `equals the template for v0.2.0 (sha256 ${sha256(renderCiStub("v0.2.0")).slice(0, 12)})` });
    write(repo, CI_STUB_PATH, renderCiStub("v0.2.0").replace("fail-fast: false", "fail-fast: true"));
    expect(ciStubCheck(repo)).toMatchObject({ status: "fail", detail: expect.stringMatching(/differs from the template for v0\.2\.0 .*expected/) });
    write(repo, CI_STUB_PATH, renderCiStub("v0.2.0") + "# github:spignotti/factory#v0.1.0\n");
    expect(ciStubCheck(repo)).toMatchObject({ status: "fail", detail: expect.stringMatching(/several factory refs/) });
  });

  it("hash check: a stub of an older template under a different pin points at bumping the pin, not at re-rendering the old ref", () => {
    const repo = createFixtureRepo();
    write(repo, CI_STUB_PATH, renderCiStub("v0.2.0").replace("fail-fast: false", "fail-fast: true"));
    expect(ciStubCheck(repo, undefined, "v0.3.0")).toMatchObject({ status: "fail", detail: expect.stringMatching(/pins v0\.2\.0, this factory is v0\.3\.0.*factory ci-stub --ref v0\.3\.0/) });
    write(repo, CI_STUB_PATH, renderCiStub("v0.3.0"));
    expect(ciStubCheck(repo, undefined, "v0.3.0")).toMatchObject({ status: "ok" });
  });

  it("doctor hints at other workflows on pull requests and a non-main base branch", () => {
    const repo = createFixtureRepo();
    write(repo, CI_STUB_PATH, renderCiStub("v0.2.0"));
    write(repo, ".github/workflows/lint.yml", "on: [pull_request]\njobs: {}\n");
    write(repo, ".github/workflows/nightly.yml", "on: { schedule: [{ cron: '0 0 * * *' }] }\njobs: {}\n");
    expect(otherPrWorkflows(repo)).toEqual(["lint.yml"]);
    const checks = ciChecks(repo, parseRepoConfig("base_branch: develop"));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["ci stub", "ok"], ["ci toolchains", "ok"], ["ci stub", "warn"], ["other workflows", "info"]]);
  });

  it("factory ci-stub --ref prints the rendered stub", async () => {
    let out = "";
    expect(await main(["ci-stub", "--ref", "v0.3.0"], { out: (s) => void (out += s), err: () => {} })).toBe(0);
    expect(out).toBe(readFileSync(CI_TEMPLATE, "utf8").replaceAll("@FACTORY_REF@", "v0.3.0"));
    let pinned = "";
    expect(await main(["ci-stub"], { out: (s) => void (pinned += s), err: () => {} })).toBe(0);
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(pinned).toBe(renderCiStub(`v${version}`)); // default pin: this factory's release tag
    expect(defaultRef()).toBe("v0.3.0");
  });
});

describe("factory --version", () => {
  it("prints the package version (and the checkout's commit)", async () => {
    let out = "";
    expect(await main(["--version"], { out: (s) => void (out += s), err: () => {} })).toBe(0);
    expect(out).toMatch(/^factory \d+\.\d+\.\d+( \([0-9a-f]{7,}\))?\n$/);
  });
});
