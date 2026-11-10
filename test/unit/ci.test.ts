import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_STUB_PATH, CI_TEMPLATE, ciStubCheck, ciStubMode, otherPrWorkflows, renderCiStub, renderCiStubFor, sha256 } from "../../src/ci.js";
import { DRAFT_HOLD_JOB } from "../../src/pipeline/ci-status.js";
import { defaultRef, main } from "../../src/cli.js";
import { settingsHints } from "../../src/commands/adopt.js";
import { ciChecks, githubChecks } from "../../src/commands/doctor.js";
import { FakeGitHub } from "../../src/gh.js";
import { loadRepoConfig } from "../../src/schemas/repo.js";
import { createFixtureRepo } from "../helpers/repo.js";

const write = (repo: string, path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

/** Status functions GitHub allows only in a job or step `if`. Anywhere else the workflow file is invalid. */
const STATUS_FN = /\b(?:always|cancelled|failure|success)\s*\(/;

function statusCallsOutsideIf(node: unknown, key: string | null, found: string[]): void {
  if (typeof node === "string") {
    if (key !== "if" && STATUS_FN.test(node)) found.push(node.trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) statusCallsOutsideIf(item, key, found);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) statusCallsOutsideIf(v, k, found);
  }
}

describe("CI stub", () => {
  it("template: every PR, select → check matrix → done; done is red when selection failed", () => {
    const wf = parse(renderCiStub("v1.2.3")) as { on: Record<string, unknown>; concurrency: Record<string, unknown>; jobs: Record<string, { needs?: string[]; if?: string; steps: { run?: string; env?: Record<string, string> }[] }>; env: Record<string, string> };
    // no run on pushes to the base branch; tags and manual runs do; no branch filter: every PR
    expect(Object.keys(wf.on)).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(wf.on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"] });
    expect(wf.on.push).toEqual({ tags: ["v*"] });
    // a newer event of the same kind cancels a run; draft and ready runs do not cancel each other
    expect(wf.concurrency.group).toContain("converted_to_draft");
    expect(wf.concurrency.group).toContain("'draft'");
    expect(wf.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(Object.keys(wf.jobs)).toEqual(["select", "check", "done"]);
    expect(wf.jobs.select!.if).toContain("github.event.pull_request.draft == false");
    expect(wf.jobs.check!.if).toContain("github.event.pull_request.draft == false");
    expect(wf.jobs.check!.if).toContain("needs.select.outputs.checks != '[]'");
    expect(wf.jobs.done!.if).toBe("always()");
    expect(wf.env.FACTORY).toBe("npx --yes --package npm@11.21.1 -- npm exec --yes --package github:spignotti/factory#v1.2.3 -- factory");
    const done = wf.jobs.done!;
    expect(done.needs).toEqual(["select", "check"]);
    expect(done.if).toBe("always()");
    expect(done.steps.map((s) => s.run).join("\n")).toContain('test "$SELECT" = success');
    // untrusted values reach the shell through env, never interpolated into the script
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) expect(step.run ?? "").not.toContain("${{");
    expect(renderCiStub("main")).not.toContain("@FACTORY_REF@");
    const text = renderCiStub("v1.2.3");
    expect(text).not.toContain("github.actor");
    expect(text).not.toContain("github.event.pull_request.labels");
    expect(text).not.toContain("github.head_ref");
    expect(text).toContain("contents: read");
    expect(text).not.toContain("pull-requests:");
  });

  it("done fails closed on a draft or a cancelled run and is not a skipped success", () => {
    const wf = parse(renderCiStub("v1.2.3")) as { jobs: Record<string, { if?: string; steps: { if?: string; run?: string }[] }> };
    const done = wf.jobs.done!;
    expect(done.if).toBe("always()");
    const cancel = done.steps.find((s) => s.if === "cancelled()");
    const gate = done.steps.find((s) => s.run?.includes('test "$SELECT"'));
    expect(cancel?.run).toContain("exit 1");
    expect(gate?.if).toBeUndefined();
    const run = (script: string, env: Record<string, string>) => {
      try {
        execFileSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };
    expect(run(cancel!.run!, {})).toBe(1);
    // A skipped select/check on a draft must not make `done` pass. Cancellation is the step `if`, not this script.
    expect(run(gate!.run!, { DRAFT: "true", SELECT: "skipped", CHECK: "skipped" })).toBe(1);
    expect(run(gate!.run!, { DRAFT: "false", SELECT: "success", CHECK: "success" })).toBe(0);
    expect(run(gate!.run!, { DRAFT: "false", SELECT: "success", CHECK: "skipped" })).toBe(0);
    expect(run(gate!.run!, { DRAFT: "false", SELECT: "failure", CHECK: "skipped" })).toBe(1);
    expect(run(gate!.run!, { DRAFT: "false", SELECT: "success", CHECK: "failure" })).toBe(1);
    expect(run(gate!.run!, { DRAFT: "false", SELECT: "skipped", CHECK: "skipped" })).toBe(1);
  });

  it("git pin is installed by npm 11.21.1, not by Node 22's npm 10.9.9 npx", () => {
    const sha = "dbc340170bf0ed2bc19c542f718f1e8f81821eab";
    const factory = renderCiStub(sha).match(/^ {2}FACTORY: "(.*)"$/m)?.[1];
    expect(factory).toBe(`npx --yes --package npm@11.21.1 -- npm exec --yes --package github:spignotti/factory#${sha} -- factory`);
    // npm 10.9.9 libnpmexec does not pass Arborist; a direct `npx github:` pack throws.
    expect(factory?.startsWith("npx --yes github:")).toBe(false);
    expect(factory?.startsWith("npx -y github:")).toBe(false);
  });

  it("status functions stay in if conditions; env cancelled() is rejected", () => {
    const rendered = renderCiStub("v1.2.3");
    const ok: string[] = [];
    statusCallsOutsideIf(parse(rendered), null, ok);
    expect(ok).toEqual([]);
    const illegal = rendered.replace(
      "DRAFT: ${{ github.event_name == 'pull_request' && github.event.pull_request.draft && 'true' || 'false' }}",
      "DRAFT: ${{ github.event_name == 'pull_request' && github.event.pull_request.draft && 'true' || 'false' }}\n          CANCELLED: ${{ cancelled() && 'true' || 'false' }}",
    );
    const bad: string[] = [];
    statusCallsOutsideIf(parse(illegal), null, bad);
    expect(bad.some((s) => s.includes("cancelled()"))).toBe(true);
  });

  it("template: the check job installs the toolchains select resolved (pnpm, node, python, uv) before the check", () => {
    const wf = parse(renderCiStub("v1.2.3")) as { jobs: Record<string, { outputs?: Record<string, string>; steps: { uses?: string; if?: string; run?: string; with?: Record<string, string> }[] }> };
    expect(wf.jobs.select!.outputs!.toolchains).toBe("${{ steps.s.outputs.toolchains }}");
    expect(wf.jobs.select!.steps.at(-1)!.run).toContain("$FACTORY gates --toolchains --json");
    // a tag or workflow_dispatch has an empty diff against the base; --all runs every check of the tier
    expect(wf.jobs.select!.steps.at(-1)!.run).toContain("$FACTORY gates --select --tier \"$TIER\" --all --json");
    expect(wf.jobs.select!.steps.at(-1)!.run).toContain('"$ALL" = true');
    const steps = wf.jobs.check!.steps;
    const tc = (k: string) => `fromJson(needs.select.outputs.toolchains).${k}`;
    expect(steps.map((s) => s.uses ?? "run")).toEqual(["actions/checkout@v4", "pnpm/action-setup@v6", "actions/setup-node@v4", "actions/setup-python@v5", "astral-sh/setup-uv@v6", "actions/cache@v4", "run"]);
    expect(steps[1]).toMatchObject({ if: tc("pnpm"), with: { version: `\${{ ${tc("pnpm_version")} }}` } });
    expect(steps[2]).toMatchObject({ with: { "node-version": `\${{ ${tc("node")} }}` } });
    expect(steps[3]).toMatchObject({ if: `${tc("python")} != ''`, with: { "python-version": `\${{ ${tc("python")} }}` } });
    expect(steps[4]).toMatchObject({ if: tc("uv"), with: { version: `\${{ ${tc("uv_version")} }}` } });
    // the npx install of the pinned factory is cached per ref, in select and in every check
    expect(steps[5]).toMatchObject({ with: { path: "~/.npm/_npx", key: "factory-npx-${{ runner.os }}-${{ env.FACTORY }}" } });
    expect(wf.jobs.select!.steps.some((s) => s.uses === "actions/cache@v4")).toBe(true);
    expect(steps[6]!.run).toBe('$FACTORY gates --run "$CHECK"');
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
    const cfg = loadRepoConfig(repo);
    cfg.base_branch = "develop";
    const checks = ciChecks(repo, cfg);
    expect(checks.map((c) => [c.name, c.status])).toEqual([["ci stub", "ok"], ["ci toolchains", "ok"], ["ci stub", "warn"], ["other workflows", "info"]]);
  });

  it("minimal stub: no npx; draft marker; fails on draft and cancelled, succeeds on ready", () => {
    expect(ciStubMode([{ tier: "full", local_only: true }, { tier: "manual", local_only: true }])).toBe("minimal");
    expect(ciStubMode([{ tier: "manual" }])).toBe("full");
    expect(ciStubMode([])).toBe("minimal");
    expect(ciStubMode([{ tier: "fast" }])).toBe("full");
    const text = renderCiStubFor("v1.2.3", "minimal");
    expect(text).not.toContain("@FACTORY_REF@");
    expect(text).not.toContain("npx");
    expect(text).not.toContain("select:");
    expect(text).not.toContain("check:");
    expect(text).toContain("github:spignotti/factory#v1.2.3");
    const wf = parse(text) as { jobs: Record<string, { needs?: string[]; if?: string; steps: { if?: string; run?: string }[] }>; concurrency: Record<string, unknown> };
    expect(Object.keys(wf.jobs)).toEqual([DRAFT_HOLD_JOB, "done"]);
    expect(wf.jobs[DRAFT_HOLD_JOB]!.if).toContain("github.event.pull_request.draft");
    expect(wf.jobs.done!.needs).toEqual([DRAFT_HOLD_JOB]);
    expect(wf.jobs.done!.if).toBe("always()");
    // draft and ready events cancel each other; a ready event must not leave the draft run running
    expect(wf.concurrency.group).toBe("factory-${{ github.ref }}");
    expect(wf.concurrency.group).not.toContain("'draft'");
    expect(wf.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    const outside: string[] = [];
    statusCallsOutsideIf(parse(text), null, outside);
    expect(outside).toEqual([]);
    const done = wf.jobs.done!;
    const cancel = done.steps.find((s) => s.if === "cancelled()");
    const gate = done.steps.find((s) => s.run?.includes('"$DRAFT"'));
    expect(cancel?.run).toContain("exit 1");
    const run = (script: string, env: Record<string, string>) => {
      try {
        execFileSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" });
        return 0;
      } catch (e) {
        return (e as { status?: number }).status ?? 1;
      }
    };
    expect(run(cancel!.run!, {})).toBe(1);
    expect(run(gate!.run!, { DRAFT: "true" })).toBe(1);
    expect(run(gate!.run!, { DRAFT: "false" })).toBe(0);
    // the full rendering is unchanged
    expect(Object.keys((parse(renderCiStub("v1.2.3")) as { jobs: Record<string, unknown> }).jobs)).toEqual(["select", "check", "done"]);
  });

  it("hash check: a repo with no CI check accepts the minimal stub and rejects the full one", () => {
    const repo = createFixtureRepo((c) => {
      for (const check of c.checks as { local_only?: boolean }[]) check.local_only = true;
    });
    const cfg = loadRepoConfig(repo);
    const minimal = renderCiStubFor("v0.2.0", "minimal");
    write(repo, CI_STUB_PATH, minimal);
    expect(ciStubCheck(repo, undefined, undefined, "minimal")).toEqual({ status: "ok", detail: `equals the template for v0.2.0 (sha256 ${sha256(minimal).slice(0, 12)})` });
    expect(ciChecks(repo, cfg)[0]).toMatchObject({ name: "ci stub", status: "ok" });
    write(repo, CI_STUB_PATH, renderCiStub(defaultRef()));
    expect(ciChecks(repo, cfg)[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/differs from the template/) });
    const withCi = createFixtureRepo();
    write(withCi, CI_STUB_PATH, renderCiStubFor(defaultRef(), "minimal"));
    expect(ciChecks(withCi, loadRepoConfig(withCi))[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/differs from the template/) });
    const manualCi = createFixtureRepo((c) => {
      for (const check of c.checks as { tier?: string; local_only?: boolean }[]) {
        if (check.tier !== "manual") check.local_only = true;
      }
    });
    write(manualCi, CI_STUB_PATH, renderCiStubFor(defaultRef(), "minimal"));
    expect(ciChecks(manualCi, loadRepoConfig(manualCi))[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/differs from the template/) });
  });

  it("doctor and adopt do not suggest requiring done when it gates nothing", async () => {
    const repo = createFixtureRepo((c) => {
      for (const check of c.checks as { local_only?: boolean }[]) check.local_only = true;
    });
    write(repo, ".github/workflows/lint.yml", "on:\n  pull_request:\njobs:\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n");
    write(repo, CI_STUB_PATH, renderCiStubFor("v0.2.0", "minimal"));
    const gh = new FakeGitHub();
    gh.settings = { private: false, auto_merge_allowed: true, branch_protected: true, required_checks: ["Lint"] };
    const checks = await githubChecks(gh, repo, loadRepoConfig(repo));
    expect(checks.map((c) => c.detail).join("\n")).not.toMatch(/require the status check "done"|not a required check yet/);
    expect(checks.find((c) => c.name === "required checks")).toMatchObject({ status: "ok", detail: expect.stringMatching(/\bLint\b/) });
    gh.settings = { private: false, auto_merge_allowed: true, branch_protected: true, required_checks: [] };
    const missing = (await githubChecks(gh, repo, loadRepoConfig(repo))).find((c) => c.name === "required checks");
    expect(missing).toMatchObject({ status: "warn", detail: expect.stringMatching(/Lint/) });
    expect(missing!.detail).not.toMatch(/\bdone\b/);
    const gated = (await githubChecks(gh, repo, loadRepoConfig(createFixtureRepo()))).find((c) => c.name === "required checks");
    expect(gated).toMatchObject({ status: "warn", detail: expect.stringMatching(/\bdone\b/) });
    expect(gated!.detail).toMatch(/Lint/);
    const hints = settingsHints({ private: false, auto_merge_allowed: true, branch_protected: false, required_checks: ["Lint"] }, "main", "minimal");
    expect(hints.join("\n")).not.toContain('status check "done"');
    expect(settingsHints({ private: false, auto_merge_allowed: true, branch_protected: true, required_checks: ["factory / done"] }, "main", "minimal")[0]).toMatch(/Remove the required status check "factory \/ done"/);
  });

  it("factory ci-stub --ref prints the rendered stub", async () => {
    let out = "";
    expect(await main(["ci-stub", "--ref", "v0.3.0"], { out: (s) => void (out += s), err: () => {} })).toBe(0);
    expect(out).toBe(readFileSync(CI_TEMPLATE, "utf8").replaceAll("@FACTORY_REF@", "v0.3.0"));
    const localOnly = createFixtureRepo((c) => {
      for (const check of c.checks as { local_only?: boolean }[]) check.local_only = true;
    });
    let minimal = "";
    expect(await main(["ci-stub", "--ref", "v0.3.0", "--repo", localOnly], { out: (s) => void (minimal += s), err: () => {} })).toBe(0);
    expect(minimal).toBe(renderCiStubFor("v0.3.0", "minimal"));
    let pinned = "";
    expect(await main(["ci-stub"], { out: (s) => void (pinned += s), err: () => {} })).toBe(0);
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(pinned).toBe(renderCiStub(`v${version}`)); // default pin: this factory's release tag
    expect(defaultRef()).toBe(`v${version}`); // follows package.json, so a release PR needs no test edit
  });
});

describe("factory --version", () => {
  it("prints the package version (and the checkout's commit)", async () => {
    let out = "";
    expect(await main(["--version"], { out: (s) => void (out += s), err: () => {} })).toBe(0);
    expect(out).toMatch(/^factory \d+\.\d+\.\d+( \([0-9a-f]{7,}\))?\n$/);
  });
});
