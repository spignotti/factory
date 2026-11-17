import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { approveCommand, isPrRef } from "../../src/commands/approve.js";
import { FakeGitHub, type PrStatus } from "../../src/gh.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const URL = "https://github.test/acme/widgets/pull/7";

function setup(status: Partial<PrStatus> = {}) {
  const github = new FakeGitHub();
  github.prStates.set(URL, { state: "open", draft: false, headSha: HEAD, headBranch: "dependabot/npm_and_yarn/zod-4", repo: "acme/widgets", ...status });
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
  const run = (sha: string, json = false) => approveCommand({ repo: "/repo", pr: URL, sha, json }, { github }, io);
  return { github, out, err, run };
}

describe("factory approve", () => {
  it("approves a matching open ready head and records the full SHA", async () => {
    const { github, out, run } = setup();
    expect(await run(HEAD)).toBe(0);
    expect(github.approvedShas).toEqual([HEAD]);
    expect(out.join("")).toBe(`approved ${URL} at ${HEAD}\n`);
  });

  it("accepts a prefix of at least the given SHA and approves the full head", async () => {
    const { github, run } = setup();
    expect(await run("0123456")).toBe(0);
    expect(await run("0123456789ABCDEF")).toBe(0);
    expect(github.approvedShas).toEqual([HEAD, HEAD]);
  });

  it("prints JSON", async () => {
    const { out, run } = setup();
    expect(await run(HEAD, true)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, pr: URL, sha: HEAD });
  });

  it("refuses a head that moved since the review", async () => {
    const { github, err, run } = setup();
    expect(await run("fedcba9")).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(err.join("")).toMatch(/not approved: .*is 0123456789abcdef.*not fedcba9/);
  });

  it.each(["closed", "merged"] as const)("refuses a %s PR", async (state) => {
    const { github, err, run } = setup({ state });
    expect(await run(HEAD)).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(err.join("")).toContain(`is ${state}, not open`);
  });

  it("refuses a draft", async () => {
    const { github, err, run } = setup({ draft: true });
    expect(await run(HEAD)).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(err.join("")).toContain("draft");
  });

  it("refuses a factory branch and points at the pipeline", async () => {
    const { github, err, run } = setup({ headBranch: "factory/12-add-thing" });
    expect(await run(HEAD)).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(err.join("")).toMatch(/factory resume.*factory queue batch/);
  });

  it("refuses a PR of another repository than --repo, so the status never lands on the wrong one", async () => {
    const { github, err, run } = setup({ repo: "upstream/widgets" });
    expect(await run(HEAD)).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(err.join("")).toContain("upstream/widgets");
    expect(err.join("")).toContain("acme/widgets");
  });

  it("compares the repository case-insensitively and refuses an unreadable one", async () => {
    expect(await setup({ repo: "Acme/Widgets" }).run(HEAD)).toBe(0);
    const { github, run } = setup({ repo: undefined });
    expect(await run(HEAD)).toBe(1);
    expect(github.approvedShas).toEqual([]);
  });

  it("refuses when the head cannot be read, and reports refusals as JSON", async () => {
    const { github, out, run } = setup({ headSha: undefined });
    expect(await run(HEAD, true)).toBe(1);
    expect(github.approvedShas).toEqual([]);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, pr: URL });
  });
});

describe("isPrRef", () => {
  it("takes a number or a pull request URL, not a branch name", () => {
    for (const ok of ["7", "123", "https://github.com/acme/widgets/pull/7", "https://github.com/acme/widgets/pull/7/files"]) expect(isPrRef(ok), ok).toBe(true);
    for (const bad of ["main", "feature/x", "#7", "7abc", "https://github.com/acme/widgets/issues/7", "https://github.com/acme/widgets", ""]) expect(isPrRef(bad), bad).toBe(false);
  });
});

describe("factory approve CLI", () => {
  it("needs --repo, --pr and a hex --sha of at least 7 characters", async () => {
    for (const args of [["--pr", "1", "--sha", "abcdef1"], ["--repo", ".", "--sha", "abcdef1"], ["--repo", ".", "--pr", "1"], ["--repo", ".", "--pr", "1", "--sha", "abc12"], ["--repo", ".", "--pr", "1", "--sha", "xyz1234"], ["--repo", ".", "--pr", "feature/x", "--sha", "abcdef1"]]) {
      const err: string[] = [];
      expect(await main(["approve", ...args], { out: () => {}, err: (s) => void err.push(s) })).toBe(2);
      expect(err.join("")).toContain("factory approve");
    }
  });
});
