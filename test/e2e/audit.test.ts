import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import { audit, auditCommand, auditUserPrompt } from "../../src/commands/audit.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { statsCommand, statsReport } from "../../src/commands/stats.js";
import { loadLayers, resolveProfile } from "../../src/config.js";
import { main } from "../../src/cli.js";
import { FakeGitHub } from "../../src/gh.js";
import { canonicalRepoId, loadMemory } from "../../src/memory.js";
import { runFactory } from "../../src/pipeline/run.js";
import { asData } from "../../src/prompts.js";
import { listProposals, proposalsDir } from "../../src/proposals.js";
import { validatePlan } from "../../src/schemas/plan.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { AuditReportSchema } from "../../src/schemas/proposal.js";
import { loadRepoConfig } from "../../src/schemas/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { ciRun, entry, PLAN, seedMemory } from "../helpers/harden.js";
import { createFixtureRepo, FIXTURES, gitIn } from "../helpers/repo.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const AUDIT = `audit:
  types: [security, performance, refactor, simplify]
  max_proposals: 5
  thinking: { security: high, performance: high, refactor: medium, simplify: medium }
`;
const REPO_YAML = `checks:
  - { name: lint, run: "true", tier: fast }
human_only_paths: [".factory/**", ".github/workflows/**"]
${AUDIT}`;

function setup(yaml = REPO_YAML, files: Record<string, string> = {}) {
  const repo = makeRepo({ ".factory/repo.yaml": yaml, "README.md": "A sample app.\n", "src/a.ts": "export const n = 1;\n", ...files });
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  return { repo, factoryHome, repoId: canonicalRepoId("", repo) };
}

function deps(ctx: { factoryHome: string }, runner: FakeRunner, gh = new FakeGitHub(), profile = loadProfile(join(FIXTURES, "profile.yaml"))) {
  return { runner, github: gh, profile, factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() };
}

const item = (goal: string, resolves: string[] = [], plan = PLAN(goal, resolves)) => ({ rationale: `Evidence at src/a.ts:1 for ${goal}.`, plan });
const selection = (...items: ReturnType<typeof item>[]) => ({ proposals: items });

describe("factory audit", () => {
  it("writes one ticket and at most max_proposals plan files that validate", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const runner = new FakeRunner([{ role: "audit_security", output: selection(item("Close the auth gap", ["a"]), item("Drop the unused token path")) }]);
    const report = await audit({ repo: ctx.repo, type: "security" }, deps(ctx, runner));
    expect(report.error).toBeNull();
    expect(runner.remaining()).toEqual({});
    expect(runner.calls).toHaveLength(1);
    const ticket = report.ticket!;
    expect(ticket).toMatchObject({ id: "2026-10-29-audit-security", kind: "audit" });
    expect(ticket.proposals.length).toBeLessThanOrEqual(5);
    expect(ticket.proposals.map((p) => p.type)).toEqual(["security", "security"]);
    const repo = loadRepoConfig(ctx.repo);
    const plans = readdirSync(proposalsDir(ctx.factoryHome, ctx.repoId)).filter((f) => f.endsWith(".plan.json"));
    expect(plans).toHaveLength(ticket.proposals.length);
    for (const p of ticket.proposals) {
      const v = validatePlan(JSON.parse(readFileSync(p.plan_path, "utf8")), { repo });
      expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
      expect(p.plan_path).toBe(join(proposalsDir(ctx.factoryHome, ctx.repoId), `${ticket.id}.${p.rank}.plan.json`));
    }
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries.map((e) => [e.key, e.status, e.ref])).toEqual([["a", "proposed", `${ticket.id}.1`]]);
    expect(AuditReportSchema.safeParse(report).success).toBe(true);
  });

  it("refuses a type that is not enabled, with no model call", async () => {
    const ctx = setup("checks:\n  - { name: lint, run: \"true\", tier: fast }\n");
    const runner = new FakeRunner([{ role: "audit_security", output: selection(item("should not run")) }]);
    const out: string[] = [];
    const code = await auditCommand({ repo: ctx.repo, type: "security", json: false }, deps(ctx, runner), { out: (s) => out.push(s), err: (s) => out.push(s) });
    expect(code).not.toBe(0);
    expect(out.join("")).toMatch(/not enabled/);
    expect(out.join("")).toMatch(/audit\.types/);
    expect(runner.calls).toHaveLength(0);
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(0);

    const only = setup(REPO_YAML.replace("performance, ", ""));
    const runner2 = new FakeRunner([]);
    const out2: string[] = [];
    const code2 = await auditCommand({ repo: only.repo, type: "performance", json: true }, deps(only, runner2), { out: (s) => out2.push(s), err: (s) => out2.push(s) });
    expect(code2).toBe(1);
    expect(AuditReportSchema.parse(JSON.parse(out2.join("\n"))).error).toMatch(/not enabled/);
    expect(runner2.calls).toHaveLength(0);

    const err: string[] = [];
    expect(await main(["audit", "--repo", ctx.repo, "--type", "nope"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("")).toMatch(/factory audit/);
  });

  it("uses audit.thinking and the role chain from the profile layers", async () => {
    const ctx = setup(`checks:\n  - { name: lint, run: "true", tier: fast }\nmodels:\n  audit_simplify: [{ model: openai/from-repo, thinking: xhigh }]\n${AUDIT}`);
    writeFileSync(join(ctx.factoryHome, "profile.yaml"), "roles:\n  audit_security: [{ model: openai/from-user, thinking: low }]\n  audit_refactor: [{ model: openai/refactor-user, thinking: low }]\n");
    const profile = resolveProfile(loadLayers({ factoryHome: ctx.factoryHome }));
    const answer = selection(item("one change"));
    const steps: FakeStep[] = [
      { role: "audit_security", output: answer },
      { role: "audit_performance", output: answer },
      { role: "audit_refactor", output: answer },
      { role: "audit_simplify", output: answer },
    ];
    const runner = new FakeRunner(steps);
    for (const type of ["security", "performance", "refactor", "simplify"] as const) {
      await audit({ repo: ctx.repo, type }, deps(ctx, runner, new FakeGitHub(), profile));
    }
    expect(runner.calls.map((c) => [c.role, c.model, c.thinking])).toEqual([
      ["audit_security", "openai/from-user", "high"],
      ["audit_performance", "openai/gpt-6.1-sol", "high"],
      ["audit_refactor", "openai/refactor-user", "medium"],
      ["audit_simplify", "openai/from-repo", "medium"],
    ]);
    expect(runner.calls.every((c) => c.tools === "read_only")).toBe(true);
    expect(runner.calls[0]!.system).toContain("There is no checklist");
    expect(runner.calls[2]!.system).toContain("There is no checklist");
  });

  it("injects audit.focus only into that type's prompt; without it the prompt is unchanged", async () => {
    const note = "Privacy and GDPR: personal data in logs, fixtures, exports and retention.";
    const checks = `checks:\n  - { name: lint, run: "true", tier: fast }\n`;
    const base = `${checks}audit:\n  types: [security, performance]\n  max_proposals: 5\n`;
    const plain = setup(base);
    const focused = setup(`${base}  focus:\n    security: ${JSON.stringify(note)}\n    performance:\n      - slow queries\n`);
    const answer = selection(item("one change"));
    const plainRunner = new FakeRunner([
      { role: "audit_security", output: answer },
      { role: "audit_performance", output: answer },
    ]);
    const focusedRunner = new FakeRunner([
      { role: "audit_security", output: answer },
      { role: "audit_performance", output: answer },
    ]);
    for (const type of ["security", "performance"] as const) {
      await audit({ repo: plain.repo, type }, deps(plain, plainRunner));
      await audit({ repo: focused.repo, type }, deps(focused, focusedRunner));
    }
    const [secPlain, perfPlain] = plainRunner.calls;
    const [secFocus, perfFocus] = focusedRunner.calls;
    const checksCfg = loadRepoConfig(plain.repo).checks;
    const noFocus = { findings: [] as unknown[], metrics: null };
    // No focus: the runner prompt is the historical three-part prompt (signals, checks, selection).
    expect(secPlain!.prompt).toBe(auditUserPrompt({ signals: noFocus, checks: checksCfg, max: 5, type: "security" }));
    expect(secPlain!.prompt.split("\n\n")).toHaveLength(3);
    expect(perfPlain!.prompt.split("\n\n")).toHaveLength(3);
    expect(secPlain!.prompt).not.toContain("<focus>");
    expect(perfPlain!.prompt).not.toContain("<focus>");
    expect(secPlain!.system).toBe(secFocus!.system);
    expect(perfPlain!.system).toBe(perfFocus!.system);
    expect(secPlain!.system).not.toContain(note);
    expect(perfPlain!.system).not.toContain("slow queries");
    const insert = (plainPrompt: string, focus: string) => {
      const tail = plainPrompt.split("\n\n").at(-1)!;
      return plainPrompt.replace(`\n\n${tail}`, `\n\n${asData("focus", focus)}\n\n${tail}`);
    };
    expect(secFocus!.prompt).toBe(insert(secPlain!.prompt, note));
    expect(secFocus!.prompt).toContain(note);
    expect(secFocus!.prompt).not.toContain("slow queries");
    expect(perfFocus!.prompt).toBe(insert(perfPlain!.prompt, "- slow queries"));
    expect(perfFocus!.prompt).toContain("- slow queries");
    expect(perfFocus!.prompt).not.toContain(note);
  });

  it("does not change the repo or open a pull request", async () => {
    const ctx = setup();
    const head = gitIn(ctx.repo, "rev-parse", "HEAD");
    const branches = gitIn(ctx.repo, "branch");
    const gh = new FakeGitHub();
    const runner = new FakeRunner([{ role: "audit_security", output: selection(item("note a gap")) }]);
    await audit({ repo: ctx.repo, type: "security" }, deps(ctx, runner, gh));
    expect(gitIn(ctx.repo, "status", "--porcelain")).toBe("");
    expect(gitIn(ctx.repo, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(ctx.repo, "branch")).toBe(branches);
    expect(gh.prs).toEqual([]);
    expect(gh.pushes).toEqual([]);
    expect(runner.calls[0]!.tools).toBe("read_only");
    expect(runner.calls[0]!.cwd).toBe(ctx.repo);
  });

  it("factory run --plan starts a run; a merged PR resolves the proposal", async () => {
    const repo = createFixtureRepo((cfg) => {
      cfg.audit = {
        types: ["security", "performance", "refactor", "simplify"],
        max_proposals: 5,
        thinking: { security: "high", performance: "high", refactor: "medium", simplify: "medium" },
      };
    });
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
    const repoId = canonicalRepoId("", repo);
    const gh = new FakeGitHub();
    const runner = new FakeRunner([{ role: "audit_security", output: selection(item("Record the audit fix")) }]);
    const report = await audit({ repo, type: "security" }, deps({ factoryHome }, runner, gh));
    const planPath = report.ticket!.proposals[0]!.plan_path;
    expect(gh.prs).toEqual([]);

    const script = FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", "clean.json"), "utf8"))).steps;
    const runGh = new FakeGitHub();
    const result = await runFactory(
      { repo, planFile: planPath },
      { runner: new FakeRunner(script), github: runGh, profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome, parentEnv: process.env },
    );
    expect(result.result).toBe("done");
    expect(result.pr).toBeTruthy();
    expect(runGh.prs).toHaveLength(1);

    runGh.prStates.set(result.pr!, { state: "merged", draft: false });
    const again = new FakeRunner([{ role: "audit_security", output: selection(item("A later audit")) }]);
    const second = await audit({ repo, type: "security" }, { ...deps({ factoryHome }, again, runGh), now: () => Date.parse("2026-11-03T12:00:00Z") });
    expect(second.lifecycle).toEqual([expect.objectContaining({ id: report.ticket!.proposals[0]!.id, status: "resolved", pr: result.pr })]);
    const saved = listProposals(factoryHome, repoId).find((t) => t.id === report.ticket!.id)!.proposals[0]!;
    expect(saved.status).toBe("resolved");
    expect(saved.resolution).toMatchObject({ status: "resolved", reason: "factory PR merged", pr: result.pr });
  });

  it("drops invalid and overlapping proposals and lists them", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 1 }), entry("b", { count: 1 })]);
    const protectedPlan = PLAN("edit factory config", []);
    protectedPlan.packages[0]!.files = [".factory/repo.yaml"];
    const answer = selection(item("Keep A", ["a"]), item("Keep A again", ["a"]), item("undeclared config", [], protectedPlan), item("Keep B", ["b"]));
    const runner = new FakeRunner([
      { role: "audit_security", output: answer },
      { role: "audit_security", output: answer },
    ]);
    const out: string[] = [];
    const code = await auditCommand({ repo: ctx.repo, type: "security", json: false, max: 3 }, deps(ctx, runner), { out: (s) => out.push(s), err: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(runner.calls[0]!.prompt).toContain("Up to 3 security proposals");
    const text = out.join("");
    expect(text).toMatch(/at most 3 allowed/);
    expect(text).toMatch(/already resolved by an earlier proposal/);
    expect(text).toMatch(/protected_changes/);
    expect(text).toContain("rejected:");
    const tickets = listProposals(ctx.factoryHome, ctx.repoId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.proposals.map((p) => p.plan.goal)).toEqual(["Keep A"]);

    const bad = new FakeRunner([
      { role: "audit_security", output: { rationale: "x" } },
      { role: "audit_security", output: selection({ rationale: "", plan: PLAN("x", ["missing"]) }) },
    ]);
    const badOut: string[] = [];
    const badCode = await auditCommand({ repo: ctx.repo, type: "security", json: true }, deps(ctx, bad), { out: (s) => badOut.push(s), err: (s) => badOut.push(s) });
    expect(badCode).toBe(1);
    const parsed = AuditReportSchema.parse(JSON.parse(badOut.join("\n")));
    expect(parsed.ticket).toBeNull();
    expect(parsed.error).toMatch(/invalid after retry/);
  });

  it("passes the performance CI audit and lists open tickets from status and stats", async () => {
    const ctx = setup();
    const gh = new FakeGitHub();
    gh.runs.push(ciRun("s1", "2026-10-20T00:00:00Z", [["check (lint)", "failure", 30]]));
    const runner = new FakeRunner([
      { role: "audit_security", output: selection(item("security note")) },
      { role: "audit_performance", output: selection(item("speed up lint")) },
    ]);
    const d = deps(ctx, runner, gh);
    await audit({ repo: ctx.repo, type: "security" }, d);
    expect(gh.ciQueries).toHaveLength(0);
    const perf = await audit({ repo: ctx.repo, type: "performance" }, d);
    expect(gh.ciQueries).toHaveLength(1);
    expect(runner.calls[1]!.prompt).toContain("failure_rate");
    expect(perf.signals.ci).toMatchObject({ runs: 1 });

    const status = await statusReport({ factoryHome: ctx.factoryHome, github: gh, now: () => NOW.getTime() });
    expect(status.audit_tickets.map((t) => t.id).sort()).toEqual([
      "2026-10-29-audit-performance.1",
      "2026-10-29-audit-security.1",
    ]);
    expect(renderStatus(status)).toContain("open audit tickets (2)");
    expect(renderStatus(status)).toContain("[security]");
    const stats = statsReport({ factoryHome: ctx.factoryHome, repo: ctx.repo, now: () => NOW.getTime() });
    expect(stats.audit_tickets.map((t) => t.type).sort()).toEqual(["performance", "security"]);
    const elsewhere = statsReport({ factoryHome: ctx.factoryHome, repo: makeRepo({ ".factory/repo.yaml": "checks: []\n" }), now: () => NOW.getTime() });
    expect(elsewhere.audit_tickets).toEqual([]);
    const lines: string[] = [];
    statsCommand({ factoryHome: ctx.factoryHome, repo: ctx.repo, json: false }, { out: (s) => lines.push(s), err: () => {} });
    expect(lines.join("")).toContain("open audit tickets:");
    expect(lines.join("")).toContain("speed up lint");
  });
});
