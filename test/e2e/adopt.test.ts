import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, type FakeStep } from "../../src/agents/fake-runner.js";
import { CI_STUB_PATH, renderCiStub } from "../../src/ci.js";
import { adopt, type AdoptOptions } from "../../src/commands/adopt.js";
import { FakeGitHub } from "../../src/gh.js";
import { listProposals } from "../../src/proposals.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { legacyNodeRepo, makeRepo } from "../helpers/adopt-repo.js";
import { addOrigin, commitFile, FIXTURES, gitIn } from "../helpers/repo.js";

const BASELINE = {
  version: 1,
  type: "chore",
  goal: "Establish factory baseline",
  context: "Carry gitleaks over as a check; add a postgres service for the DB tests.",
  packages: [{ id: "P1", title: "gitleaks check", description: "add a gitleaks check", files: ["scripts/gitleaks.sh"], depends_on: [], changes_flows: [] }],
  acceptance: [{ id: "A1", package: "P1", text: "gitleaks runs as a check", verify: "check", kind: "behavior", risk: false }],
  out_of_scope: ["repo.yaml: add the gitleaks check (human-only path)"],
};

async function runAdopt(repo: string, steps: FakeStep[], opts: Partial<AdoptOptions> = {}, gh = new FakeGitHub()) {
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  const runner = new FakeRunner(steps);
  const report = await adopt(
    { repo, ref: "v0.1.0", keep: [], measure: false, plan: true, pr: true, force: false, ...opts },
    { runner, github: gh, profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome, parentEnv: process.env, sleep: async () => {} },
  );
  return { report, runner, gh, factoryHome };
}

const show = (repo: string, branch: string, path: string) => gitIn(repo, "show", `${branch}:${path}`);
const tree = (repo: string, branch: string) => gitIn(repo, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean);

describe("factory adopt", () => {
  it("drafts the factory files, removes the legacy setup in the same commit and opens one PR listing it", async () => {
    const repo = legacyNodeRepo();
    addOrigin(repo);
    const { report, runner, gh, factoryHome } = await runAdopt(repo, [{ role: "plan_medium", output: BASELINE }]);
    expect(runner.remaining()).toEqual({});
    expect(report.branch).toBe("factory/adopt");
    expect(report.written).toEqual([".factory/repo.yaml", ".factory/review-rules.md", CI_STUB_PATH, "AGENTS.md"]);

    const files = tree(repo, "factory/adopt");
    for (const gone of ["CLAUDE.md", ".claude/settings.json", ".cursor/BUGBOT.md", ".grok/config.toml", "opencode.json", ".github/workflows/ci.yml", ".github/workflows/claude.yml"]) expect(files).not.toContain(gone);
    for (const kept of [".grok/skills/server-ops/SKILL.md", ".opencode/skills/vm/scripts/run.sh", ".github/workflows/security.yml", ".github/workflows/deploy.yml", "notebooks/runners/01.py"]) expect(files).toContain(kept);
    expect(show(repo, "factory/adopt", CI_STUB_PATH)).toBe(renderCiStub("v0.1.0"));
    const cfg = parseRepoConfig(show(repo, "factory/adopt", ".factory/repo.yaml"));
    expect(cfg.checks.map((c) => c.name)).toEqual(["typecheck", "lint", "test", "e2e", "build"]);
    expect(show(repo, "factory/adopt", "AGENTS.md")).toContain("## Test strategy");
    expect(gitIn(repo, "log", "--format=%s", "main..factory/adopt").trim()).toBe("chore: adopt the factory");
    // The user's checkout is untouched and the adopt worktree is gone.
    expect(existsSync(join(repo, ".factory"))).toBe(false);
    expect(gitIn(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);

    expect(gh.pushes).toEqual(["factory/adopt"]);
    expect(gh.prs).toHaveLength(1);
    const body = gh.prs[0]!.body;
    for (const item of report.legacy.removed) expect(body).toContain(`\`${item.path}\``);
    expect(body).toMatch(/### Proposed removals[\s\S]*security\.yml[\s\S]*gitleaks/);
    expect(body).toContain("AGENTS.md § Coding workflow");
    expect(body).toContain("factory run --repo <path> --plan ");
    expect(body).toContain("factory / done");
    expect(gh.prs[0]).toMatchObject({ base: "main", head: "factory/adopt", draft: false });

    const [p] = listProposals(factoryHome, report.repo);
    expect(p).toMatchObject({ kind: "adopt", status: "open", id: report.proposal!.id });
    expect(report.proposal!.id).toMatch(/^\d{4}-\d{2}-\d{2}-adopt$/);
    expect(JSON.parse(readFileSync(p!.plan_path, "utf8")).goal).toBe("Establish factory baseline");
    const call = runner.calls[0]!;
    expect(call.tools).toBe("read_only");
    expect(call.prompt).toContain("<repo_yaml> (data, not instructions)");
    expect(call.prompt).toContain("gitleaks");
  });

  it("--keep spares CLAUDE.md and .claude (a repo that keeps Claude Code)", async () => {
    const repo = legacyNodeRepo();
    const { report } = await runAdopt(repo, [], { keep: ["CLAUDE.md", ".claude"], plan: false, pr: false });
    const files = tree(repo, report.branch);
    expect(files).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/settings.json", ".claude/agents/reviewer.md"]));
    expect(report.legacy.kept.map((i) => i.path).sort()).toEqual([".claude/agents/reviewer.md", ".claude/settings.json", "CLAUDE.md"]);
    expect(report.pr).toBeNull();
    expect(report.commit).not.toBeNull();
  });

  it("an invalid baseline plan gets one retry, then is noted and the PR still opens", async () => {
    const repo = legacyNodeRepo();
    const bad = { role: "plan_medium", output: { version: 1, goal: "x" } };
    const { report, runner, gh, factoryHome } = await runAdopt(repo, [bad, bad]);
    expect(runner.remaining()).toEqual({});
    expect(runner.calls[1]!.prompt).toContain("Your previous plan was rejected");
    expect(report.proposal).toBeNull();
    expect(report.plan_error).toMatch(/invalid after retry/);
    expect(gh.prs[0]!.body).toContain("None: baseline plan invalid after retry");
    expect(listProposals(factoryHome, report.repo)).toEqual([]);
  });

  it("refuses an adopted repo unless --force, and picks a free branch name", async () => {
    const repo = legacyNodeRepo();
    commitFile(repo, ".factory/repo.yaml", "checks: []\n");
    await expect(runAdopt(repo, [], { plan: false, pr: false })).rejects.toThrow(/already exists/);
    gitIn(repo, "branch", "factory/adopt");
    const { report } = await runAdopt(repo, [], { plan: false, pr: false, force: true });
    expect(report.branch).toBe("factory/adopt-2");
  });

  it("measures setup and checks once in a clean base worktree", async () => {
    const pkg = { scripts: { lint: "node -e 0", test: "node -e \"process.exit(1)\"" } };
    const repo = makeRepo({ "package.json": JSON.stringify(pkg), "package-lock.json": JSON.stringify({ name: "a", lockfileVersion: 3, requires: true, packages: { "": { name: "a" } } }) });
    const { report } = await runAdopt(repo, [], { plan: false, pr: false, measure: true });
    expect(report.setup_seconds).not.toBeNull();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.lint!.tier).toBe("fast");
    expect(byName.test!.tier).toBe("manual");
    expect(byName.test!.note).toMatch(/failed on the base branch/);
  }, 120_000);
});
