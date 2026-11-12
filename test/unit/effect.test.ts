import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { effectStatus, formatLifecycle, provenImprovement, resolveProposals } from "../../src/harden/lifecycle.js";
import { writeProposal } from "../../src/proposals.js";
import { listRuns } from "../../src/runs.js";
import { PLAN, seedRun } from "../helpers/harden.js";

const repoId = "github.com/o/r";

function open(home: string, acceptance: string) {
  const plan = PLAN("Speed the suite");
  plan.acceptance = [{ id: "A1", package: "P1", text: acceptance, verify: "check", kind: "behavior", risk: false }];
  return writeProposal(home, {
    version: 1,
    kind: "improve",
    id: "2026-10-01-improve-performance",
    repo: repoId,
    created_at: "2026-10-01T00:00:00.000Z",
    proposals: [{ status: "open", aspect: "performance", rationale: "slow", plan, references: { findings: [], checklist: [] }, resolution: null }],
    signals: {},
    metrics: null,
  });
}

async function merge(home: string, acceptance: string, checks: { name: string; status: string }[] | null) {
  const ticket = open(home, acceptance);
  const proposal = ticket.proposals[0]!;
  const runId = seedRun(home, "/repo", new Date("2026-10-02T00:00:00.000Z"), {
    pr: "https://github.com/o/r/pull/3",
    plan: proposal.plan,
  });
  if (checks) {
    const dir = join(home, "runs", runId);
    writeFileSync(join(dir, "gates-1.json"), JSON.stringify({ n: 1, checks: [{ name: "speed", status: "pass" }] }));
    writeFileSync(join(dir, "gates-2.json"), JSON.stringify({ n: 2, checks }));
  }
  const gh = new FakeGitHub();
  gh.prStates.set("https://github.com/o/r/pull/3", { state: "merged", draft: false });
  const changes = await resolveProposals({
    factoryHome: home,
    repoId,
    repoDir: "/repo",
    runs: listRuns(home),
    github: gh,
    now: new Date("2026-10-03T00:00:00.000Z"),
  });
  return changes;
}

describe("effect is not the merge", () => {
  it("classifies a named effect check without treating a merge as proof", () => {
    const plan = { acceptance: [{ text: "effect check: speed" }] };
    expect(effectStatus(plan, null)).toBe("unclear");
    expect(effectStatus({ acceptance: [{ text: "the suite is faster" }] }, [{ name: "speed", status: "pass" }])).toBe("unclear");
    expect(effectStatus(plan, [{ name: "speed", status: "fail" }])).toBe("negative");
    expect(effectStatus(plan, [{ name: "other", status: "pass" }])).toBe("unclear");
    expect(effectStatus(plan, [{ name: "speed", status: "pass" }])).toBe("confirmed");
    expect(provenImprovement("confirmed")).toBe(true);
    expect(provenImprovement("negative")).toBe(false);
    expect(provenImprovement("unclear")).toBe(false);
    expect(provenImprovement(undefined)).toBe(false);
    expect(formatLifecycle({ id: "p", status: "resolved", reason: "factory PR merged", effect: "unclear" })).toBe(
      "proposal p: implemented (factory PR merged; effect unclear; not a proven improvement)\n",
    );
    expect(formatLifecycle({ id: "p", status: "resolved", reason: "factory PR merged", effect: "negative" })).toContain("not a proven improvement");
    expect(formatLifecycle({ id: "p", status: "resolved", reason: "factory PR merged", effect: "confirmed" })).toContain("effect confirmed");
    expect(formatLifecycle({ id: "p", status: "dropped", reason: "issue closed without merged PR" })).toBe("proposal p: dropped (issue closed without merged PR)\n");
  });

  it("stores unclear when the merged run has no gates report", async () => {
    const home = mkdtempSync(join(tmpdir(), "effect-"));
    const changes = await merge(home, "effect check: speed", null);
    expect(changes).toEqual([expect.objectContaining({ status: "resolved", reason: "factory PR merged", effect: "unclear" })]);
    expect(provenImprovement(changes[0]!.effect)).toBe(false);
    expect(formatLifecycle(changes[0]!)).toContain("not a proven improvement");
  });

  it("stores negative when the latest gates report did not pass the named check", async () => {
    const home = mkdtempSync(join(tmpdir(), "effect-"));
    const changes = await merge(home, "effect check: speed", [{ name: "speed", status: "fail" }]);
    expect(changes[0]!.effect).toBe("negative");
    expect(provenImprovement(changes[0]!.effect)).toBe(false);
    expect(formatLifecycle(changes[0]!)).toContain("not a proven improvement");
  });

  it("stores confirmed only when every named effect check passed", async () => {
    const home = mkdtempSync(join(tmpdir(), "effect-"));
    const changes = await merge(home, "keep the suite\neffect check: speed", [{ name: "speed", status: "pass" }]);
    expect(changes[0]!.effect).toBe("confirmed");
    expect(provenImprovement(changes[0]!.effect)).toBe(true);
    expect(formatLifecycle(changes[0]!)).toContain("effect confirmed");
  });
});
