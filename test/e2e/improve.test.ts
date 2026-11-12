import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, type FakeStep } from "../../src/agents/fake-runner.js";
import { main } from "../../src/cli.js";
import { auditAlias, hardenAlias, improve, improveCommand } from "../../src/commands/improve.js";
import { FakeGitHub, type GitHub } from "../../src/gh.js";
import { resolveProposals } from "../../src/harden/lifecycle.js";
import { canonicalRepoId, loadMemory } from "../../src/memory.js";
import { listProposals } from "../../src/proposals.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { ImproveReportSchema } from "../../src/schemas/proposal.js";
import { makeRepo } from "../helpers/adopt-repo.js";
import { ciRun, entry, PLAN, seedMemory, seedRun } from "../helpers/harden.js";
import { FIXTURES } from "../helpers/repo.js";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const CHECKS = "checks:\n  - { name: lint, run: \"true\", tier: fast }\n";
const IMPROVE = `${CHECKS}improve:
  aspects: [findings, security, performance, structure]
  max_proposals: 5
  thinking: { security: low }
  focus:
    security: "Privacy note for this repo only."
`;

function setup(yaml = IMPROVE) {
  const repo = makeRepo({ ".factory/repo.yaml": yaml, "README.md": "A sample app.\n", "src/a.ts": "export const n = 1;\n" });
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  return { repo, factoryHome, repoId: canonicalRepoId("", repo) };
}

function deps(ctx: { factoryHome: string }, steps: FakeStep[], gh = new FakeGitHub()) {
  return { deps: { runner: new FakeRunner(steps), github: gh, profile: loadProfile(join(FIXTURES, "profile.yaml")), factoryHome: ctx.factoryHome, parentEnv: process.env, now: () => NOW.getTime() }, gh };
}

const item = (goal: string, resolves: string[] = [], checklist: string[] = []) => ({ rationale: `Because ${goal}.`, checklist, plan: PLAN(goal, resolves) });
const selection = (...items: ReturnType<typeof item>[]) => ({ proposals: items });
const answer = selection(item("Close the auth gap"));

describe("factory improve", () => {
  it("runs configured aspects, and --aspect runs only that one", async () => {
    const ctx = setup();
    seedMemory(ctx.factoryHome, ctx.repoId, [
      entry("a", { count: 2 }),
      entry("sec", { reviewer: "security" }),
      entry("sim", { reviewer: "simplicity", count: 2 }),
    ]);
    const steps: FakeStep[] = [
      { role: "plan_medium", output: { merge: [] } },
      { role: "harden", output: selection(item("Lint rule for a", ["a"])) },
      { role: "audit_security", output: answer },
      { role: "audit_performance", output: answer },
      { role: "audit_refactor", output: answer },
    ];
    const gh = new FakeGitHub();
    gh.runs = Array.from({ length: 5 }, (_, i) => ciRun(`sha${i}`, "2026-10-20T00:00:00.000Z", [["check (syntax)", "success", 3]]));
    const all = deps(ctx, steps, gh);
    const report = await improve({ repo: ctx.repo }, all.deps);
    expect(report.error).toBeNull();
    expect(all.deps.runner.calls.map((c) => [c.role, c.thinking])).toEqual([
      ["plan_medium", "medium"],
      ["harden", "medium"],
      ["audit_security", "low"],
      ["audit_performance", "high"],
      ["audit_refactor", "medium"],
    ]);
    expect(all.deps.runner.calls[1]!.system).toContain("unmarked standards");
    expect(all.deps.runner.calls[2]!.prompt).toContain("Privacy note for this repo only.");
    expect(all.deps.runner.calls[2]!.prompt).toContain("At most 5 security proposals");
    expect(all.deps.runner.calls[3]!.prompt).not.toContain("Privacy note");
    expect(all.deps.runner.calls[4]!.system).toContain("dead paths");
    expect(all.deps.runner.calls.filter((c) => c.role !== "plan_medium").every((c) => c.tools === "read_only")).toBe(true);
    expect(ImproveReportSchema.safeParse(report).success).toBe(true);

    const flagged = deps(ctx, [{ role: "audit_security", output: answer }]);
    const only = await improve({ repo: ctx.repo, aspects: ["security"], max: 1 }, flagged.deps);
    expect(only.error).toBeNull();
    expect(flagged.deps.runner.calls.map((c) => c.role)).toEqual(["audit_security"]);
    expect(flagged.deps.runner.calls[0]!.prompt).toContain("At most 1 security proposals");
  });

  it("opens an issue with the plan block and labels, then updates it instead of duplicating", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    const first = deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh);
    const created = await improve({ repo: ctx.repo }, first.deps);
    expect(created.error).toBeNull();
    expect(created.results[0]!.issues).toEqual([{ proposal_id: "2026-10-29-improve-findings.1", number: 1, action: "created" }]);
    const issue = gh.issues.get(1)!;
    expect(issue.title).toBe("Lint rule for a");
    expect(issue.labels).toEqual(expect.arrayContaining(["factory-proposal", "improve:findings"]));
    expect(issue.labels).not.toContain("factory-ready");
    expect(gh.ensuredLabels.map((l) => l.name)).toEqual(expect.arrayContaining(["factory-proposal", "improve:findings"]));
    const block = /```factory-plan\n([\s\S]*?)```/.exec(issue.body);
    expect(JSON.parse(block?.[1] ?? "")).toMatchObject({ goal: "Lint rule for a", resolves_findings: ["a"] });
    expect(issue.body).toContain("Because Lint rule for a.");
    expect(issue.body).toContain("<!-- factory-proposal: findings:a -->");
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "proposed", ref: "2026-10-29-improve-findings.1" });

    const second = deps(ctx, [{ role: "harden", output: selection(item("Stronger lint for a", ["a"])) }], gh);
    const updated = await improve({ repo: ctx.repo }, second.deps);
    expect(updated.error).toBeNull();
    expect(updated.results[0]!.issues).toEqual([{ proposal_id: "2026-10-29-improve-findings.1", number: 1, action: "updated" }]);
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.title).toBe("Stronger lint for a");
    expect(JSON.parse(/```factory-plan\n([\s\S]*?)```/.exec(gh.issues.get(1)!.body)?.[1] ?? "").goal).toBe("Stronger lint for a");
    expect(gh.issueEdits).toHaveLength(1);
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(1);
    const kept = listProposals(ctx.factoryHome, ctx.repoId)[0]!.proposals[0]!;
    expect(kept).toMatchObject({ id: "2026-10-29-improve-findings.1", status: "open", issue: 1 });
    expect(kept.plan.goal).toBe("Stronger lint for a");
    expect(JSON.parse(readFileSync(kept.plan_path, "utf8")).goal).toBe("Stronger lint for a");
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "proposed", ref: "2026-10-29-improve-findings.1" });
  });

  it("drops a proposal whose issue was closed without a merged PR, and resolves one whose factory PR merged", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 }), entry("m", { count: 2 })]);
    const gh = new FakeGitHub();
    const opened = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(opened.results[0]!.issues[0]!.number).toBe(1);
    gh.issues.get(1)!.state = "closed";
    const dropped = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(dropped.lifecycle).toEqual([expect.objectContaining({ id: "2026-10-29-improve-findings.1", status: "dropped", reason: "issue closed without merged PR" })]);
    expect(gh.issues.get(1)!.state).toBe("closed");
    expect(gh.issueEdits.every((e) => e.number !== 1)).toBe(true);
    expect(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals).find((p) => p.id === "2026-10-29-improve-findings.1")!.status).toBe("dropped");

    const mergedHome = mkdtempSync(join(tmpdir(), "factory-home-"));
    const mergedCtx = { repo: ctx.repo, factoryHome: mergedHome, repoId: ctx.repoId };
    seedMemory(mergedHome, ctx.repoId, [entry("m", { count: 2 })]);
    const mgh = new FakeGitHub();
    const ticket = await improve({ repo: ctx.repo }, deps(mergedCtx, [{ role: "harden", output: selection(item("Keep the merged fix", ["m"])) }], mgh).deps);
    const proposal = ticket.results[0]!.ticket!.proposals[0]!;
    seedRun(mergedHome, ctx.repo, new Date("2026-10-29T13:00:00.000Z"), { pr: "https://github.com/o/r/pull/9", plan: PLAN("Keep the merged fix", ["m"]), taskRef: proposal.plan_path });
    mgh.prStates.set("https://github.com/o/r/pull/9", { state: "merged", draft: false });
    const resolved = await improve({ repo: ctx.repo }, deps(mergedCtx, [], mgh).deps);
    expect(resolved.lifecycle).toEqual([expect.objectContaining({ id: proposal.id, status: "resolved", reason: "factory PR merged", pr: "https://github.com/o/r/pull/9" })]);
    expect(resolved.results[0]!.ticket).toBeNull();
    expect(mgh.issues.size).toBe(1);
  });

  it("treats harden and audit as aliases, and old config blocks as a fallback with a warning", async () => {
    const ctx = setup(`${CHECKS}harden:\n  max_proposals: 2\naudit:\n  types: [refactor, simplify]
  max_proposals: 4\n  thinking: { simplify: high }\n  focus:\n    refactor: "boundaries"\n    simplify: "dead code"\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 }), entry("sim", { reviewer: "simplicity", count: 2 })]);
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => err.push(s) };
    const gh = new FakeGitHub();
    const code = await hardenAlias(
      { repo: ctx.repo, compact: false, json: false },
      deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps,
      io,
    );
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/harden` is deprecated/);
    expect(err.join("")).toMatch(/deprecat/);
    expect(gh.issues.get(1)!.labels).toContain("improve:findings");

    err.length = 0;
    const auditGh = new FakeGitHub();
    const auditCode = await auditAlias(
      { repo: ctx.repo, type: "simplify", json: true },
      deps(ctx, [{ role: "audit_refactor", output: answer }], auditGh).deps,
      io,
    );
    expect(auditCode).toBe(0);
    expect(err.join("")).toMatch(/audit` is deprecated/);
    expect(err.join("")).toMatch(/aspect structure/);
    expect(auditGh.issues.get(1)!.labels).toEqual(expect.arrayContaining(["factory-proposal", "improve:structure"]));

    const both = deps(ctx, [
      { role: "harden", output: selection(item("Lint rule for a", ["a"])) },
      { role: "audit_refactor", output: answer },
    ]);
    const out: string[] = [];
    const warn: string[] = [];
    const fallback = await improveCommand({ repo: ctx.repo, json: false }, both.deps, { out: (s) => out.push(s), err: (s) => warn.push(s) });
    expect(fallback).toBe(0);
    expect(both.deps.runner.calls.map((c) => c.role)).toEqual(["harden", "audit_refactor"]);
    expect(both.deps.runner.calls[1]!.prompt).toContain("boundaries");
    expect(both.deps.runner.calls[1]!.prompt).toContain("dead code");
    expect(both.deps.runner.calls[1]!.prompt).toContain("At most 4 structure proposals");
    expect(both.deps.runner.calls[1]!.thinking).toBe("high");
    expect(warn.join("")).toMatch(/harden: and audit: are deprecated/);
    expect(out.join("")).toMatch(/aspect findings/);
    expect(out.join("")).toMatch(/aspect structure/);
  });

  it("does not open an issue on --dry-run, and refuses an aspect that is not configured", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    const report = await improve({ repo: ctx.repo, dryRun: true }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(report.error).toBeNull();
    expect(report.dry_run).toBe(true);
    expect(report.results[0]!.issues).toEqual([]);
    expect(report.results[0]!.ticket?.proposals).toHaveLength(1);
    expect(gh.issues.size).toBe(0);
    expect(gh.ensuredLabels).toEqual([]);
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(1);

    const runner = new FakeRunner([{ role: "audit_security", output: answer }]);
    const out: string[] = [];
    const code = await improveCommand({ repo: ctx.repo, aspects: ["security"], json: false }, { ...deps(ctx, []).deps, runner }, { out: (s) => out.push(s), err: () => {} });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/not enabled/);
    expect(runner.calls).toHaveLength(0);

    const err: string[] = [];
    expect(await main(["improve", "--repo", ctx.repo, "--aspect", "nope"], { out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("")).toMatch(/factory improve/);
  });

  it("updates a relabelled issue by marker, and does not create when the open-issue list may be incomplete", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    const opened = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(opened.results[0]!.issues[0]).toMatchObject({ number: 1, action: "created" });
    gh.issues.get(1)!.labels = ["factory-ready"];

    const updated = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Stronger lint for a", ["a"])) }], gh).deps);
    expect(updated.error).toBeNull();
    expect(updated.results[0]!.issues).toEqual([{ proposal_id: "2026-10-29-improve-findings.1", number: 1, action: "updated" }]);
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.labels).toEqual(expect.arrayContaining(["factory-ready", "factory-proposal"]));
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "proposed", ref: "2026-10-29-improve-findings.1" });
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(1);
    expect(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals).find((p) => p.id === "2026-10-29-improve-findings.1")!.status).toBe("open");

    const fresh = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(fresh.factoryHome, fresh.repoId, [entry("a", { count: 2 })]);
    const partial = new FakeGitHub();
    partial.openIssuesComplete = false;
    const out: string[] = [];
    const code = await improveCommand(
      { repo: fresh.repo, json: false },
      deps(fresh, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], partial).deps,
      { out: (s) => out.push(s), err: () => {} },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("open issue list may be incomplete; not creating an issue for Lint rule for a");
    expect(out.join("")).toContain("Lint rule for a");
    expect(partial.issues.size).toBe(0);
    expect(loadMemory(fresh.factoryHome, fresh.repoId).entries[0]!.status).toBe("open");
  });

  it("keeps the first proposal when two share a key, and matches later runs by files not by goal text", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [security]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("sec", { reviewer: "security" })]);
    const gh = new FakeGitHub();
    const files = ["src/auth.ts", "src/log.ts"];
    const out: string[] = [];
    const code = await improveCommand(
      { repo: ctx.repo, aspects: ["security"], json: false },
      deps(ctx, [{ role: "audit_security", output: selection(withFiles("Stop logging tokens", files), withFiles("Do not log auth tokens", files)) }], gh).deps,
      { out: (s) => out.push(s), err: () => {} },
    );
    expect(code).toBe(0);
    expect(gh.issues.size).toBe(1);
    expect(gh.issueEdits).toHaveLength(0);
    expect(gh.issues.get(1)!.title).toBe("Stop logging tokens");
    expect(gh.issues.get(1)!.body).not.toContain("Do not log auth tokens");
    expect(out.join("")).toMatch(/rejected: dropped duplicate proposal key security:[0-9a-f]{64}: Do not log auth tokens/);
    expect(out.join("")).not.toMatch(/2\. Do not log auth tokens/);

    gh.issues.get(1)!.labels = ["factory-ready"];
    const updated = await improve(
      { repo: ctx.repo, aspects: ["security"] },
      deps(ctx, [{ role: "audit_security", output: selection(withFiles("Do not log auth tokens", ["src/log.ts", "src/auth.ts"])) }], gh).deps,
    );
    expect(updated.error).toBeNull();
    expect(updated.results[0]!.issues).toEqual([expect.objectContaining({ number: 1, action: "updated" })]);
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.title).toBe("Do not log auth tokens");

    const created = await improve(
      { repo: ctx.repo, aspects: ["security"] },
      deps(ctx, [{ role: "audit_security", output: selection(withFiles("Add rate limiting", ["src/rate.ts"])) }], gh).deps,
    );
    expect(created.results[0]!.issues).toEqual([expect.objectContaining({ number: 2, action: "created" })]);
    expect(gh.issues.size).toBe(2);
    expect(created.results[0]!.ticket!.proposals[0]!.key).not.toBe(updated.results[0]!.ticket!.proposals[0]!.key);
  });

  it("keeps a proposal when gh cannot read the issue, and dry-run makes no gh calls", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings, performance]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    const opened = await improve({ repo: ctx.repo, aspects: ["findings"] }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(opened.results[0]!.issues[0]!.number).toBe(1);

    gh.getIssueError = "gh issue view failed: API rate limit exceeded";
    const changes = await resolveProposals({
      factoryHome: ctx.factoryHome,
      repoId: ctx.repoId,
      repoDir: ctx.repo,
      runs: [],
      github: gh,
      now: new Date("2026-12-29T12:00:00.000Z"),
    });
    expect(changes).toEqual([]);
    expect(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals).find((p) => p.id === "2026-10-29-improve-findings.1")!.status).toBe("open");
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "proposed", ref: "2026-10-29-improve-findings.1" });

    gh.getIssueError = null;
    gh.issues.get(1)!.state = "closed";
    const calls: string[] = [];
    const github = new Proxy(gh, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as GitHub;
    const dryReport = await improve(
      { repo: ctx.repo, dryRun: true, aspects: ["findings", "performance"] },
      {
        ...deps(ctx, [
          { role: "harden", output: selection(item("Lint rule for a", ["a"])) },
          { role: "audit_performance", output: answer },
        ]).deps,
        github,
      },
    );
    expect(calls).toEqual([]);
    expect(dryReport.lifecycle).toEqual([]);
    expect(dryReport.error).toBeNull();
    expect(dryReport.results.map((r) => r.aspect)).toEqual(["findings", "performance"]);
    expect(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals).find((p) => p.id === "2026-10-29-improve-findings.1")!.status).toBe("open");
  });

  it("prints create and update failures, and exits non-zero", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    gh.createIssueError = "HTTP 502";
    const out: string[] = [];
    const code = await improveCommand(
      { repo: ctx.repo, json: false },
      deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps,
      { out: (s) => out.push(s), err: () => {} },
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("issue create failed: HTTP 502");
    expect(out.join("")).toContain("Lint rule for a");
    expect(gh.issues.size).toBe(0);
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]!.status).toBe("open");

    const gh2 = new FakeGitHub();
    const opened = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh2).deps);
    expect(opened.error).toBeNull();
    gh2.updateIssueError = "API rate limit exceeded";
    const out2: string[] = [];
    const code2 = await improveCommand(
      { repo: ctx.repo, json: false },
      deps(ctx, [{ role: "harden", output: selection(item("Stronger lint for a", ["a"])) }], gh2).deps,
      { out: (s) => out2.push(s), err: () => {} },
    );
    expect(code2).toBe(1);
    expect(out2.join("")).toContain("issue update failed: API rate limit exceeded");
    expect(gh2.issues.get(1)!.title).toBe("Lint rule for a");
    expect(gh2.issueEdits).toHaveLength(0);
  });

  it("keeps the proposal across a second improve so a merged PR for its issue resolves it", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [findings]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2 })]);
    const gh = new FakeGitHub();
    const opened = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Lint rule for a", ["a"])) }], gh).deps);
    expect(opened.error).toBeNull();
    const proposal = opened.results[0]!.ticket!.proposals[0]!;
    expect(opened.results[0]!.issues).toEqual([{ proposal_id: proposal.id, number: 1, action: "created" }]);

    // Run on the issue, started before the ticket. Its plan no longer matches the proposal text.
    // A merged PR that closes the issue must still resolve it, and the second improve must not replace the id.
    seedRun(ctx.factoryHome, ctx.repo, new Date("2026-10-29T11:00:00.000Z"), {
      pr: "https://github.com/o/r/pull/4",
      plan: PLAN("rewritten by the run", []),
      taskRef: "#1",
      issue: 1,
    });
    gh.prStates.set("https://github.com/o/r/pull/4", { state: "open", draft: false });

    const second = await improve({ repo: ctx.repo }, deps(ctx, [{ role: "harden", output: selection(item("Stronger lint for a", ["a"])) }], gh).deps);
    expect(second.error).toBeNull();
    expect(second.lifecycle).toEqual([]);
    expect(second.results[0]!.issues).toEqual([{ proposal_id: proposal.id, number: 1, action: "updated" }]);
    expect(listProposals(ctx.factoryHome, ctx.repoId)).toHaveLength(1);
    const kept = listProposals(ctx.factoryHome, ctx.repoId)[0]!.proposals[0]!;
    expect(kept.id).toBe(proposal.id);
    expect(kept.plan_path).toBe(proposal.plan_path);
    expect(kept.status).toBe("open");
    expect(kept.issue).toBe(1);
    expect(kept.plan.goal).toBe("Stronger lint for a");
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.title).toBe("Stronger lint for a");
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "proposed", ref: proposal.id });

    gh.prStates.set("https://github.com/o/r/pull/4", { state: "merged", draft: false });
    gh.issues.get(1)!.state = "closed";
    const resolved = await improve({ repo: ctx.repo }, deps(ctx, [], gh).deps);
    expect(resolved.lifecycle).toEqual([expect.objectContaining({ id: proposal.id, status: "resolved", reason: "factory PR merged", pr: "https://github.com/o/r/pull/4" })]);
    expect(resolved.lifecycle.some((c) => c.status === "dropped")).toBe(false);
    expect(listProposals(ctx.factoryHome, ctx.repoId).flatMap((t) => t.proposals).find((p) => p.id === proposal.id)!.status).toBe("resolved");
    expect(loadMemory(ctx.factoryHome, ctx.repoId).entries[0]).toMatchObject({ status: "resolved", ref: "https://github.com/o/r/pull/4" });
    expect(resolved.results[0]!.ticket).toBeNull();
  });

  it("does not call the model for security, performance or structure without evidence", async () => {
    const ctx = setup(`${CHECKS}improve:\n  aspects: [security, performance, structure]\n`);
    seedMemory(ctx.factoryHome, ctx.repoId, [entry("a", { count: 2, reviewer: "plan" })]);
    const gh = new FakeGitHub();
    const runner = new FakeRunner([
      { role: "audit_security", output: answer },
      { role: "audit_performance", output: answer },
      { role: "audit_refactor", output: answer },
    ]);
    const report = await improve({ repo: ctx.repo }, { ...deps(ctx, []).deps, runner, github: gh });
    expect(report.error).toBeNull();
    expect(runner.calls).toHaveLength(0);
    expect(gh.issues.size).toBe(0);
    expect(report.results.map((r) => r.aspect)).toEqual(["security", "performance", "structure"]);
    expect(report.results.every((r) => r.ticket === null && r.issues.length === 0)).toBe(true);
  });
});

function withFiles(goal: string, files: string[], resolves: string[] = []) {
  const plan = PLAN(goal, resolves);
  return { rationale: `Because ${goal}.`, checklist: [] as string[], plan: { ...plan, packages: [{ ...plan.packages[0]!, files }] } };
}
