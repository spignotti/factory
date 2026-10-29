import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMemory, memoryDir, updateMemory } from "../../src/memory.js";
import { listProposals, nextProposalId, proposalsDir, saveProposal, writeProposal } from "../../src/proposals.js";
import { type Proposal, ProposalSchema } from "../../src/schemas/proposal.js";

const REPO = "github.com/acme/app";
const plan = {
  version: 1,
  type: "chore",
  goal: "Turn the null check finding into a lint rule",
  context: "",
  packages: [{ id: "P1", title: "lint rule", description: "", files: ["eslint.config.js"], depends_on: [], changes_flows: [] }],
  acceptance: [{ id: "A1", package: "P1", text: "lint fails on unchecked nulls", verify: "check", kind: "behavior", risk: false }],
  out_of_scope: [],
  resolves_findings: ["k1"],
};

function proposal(id: string, kind: Proposal["kind"] = "harden"): Omit<Proposal, "plan_path"> {
  return {
    version: 1,
    kind,
    id,
    repo: REPO,
    created_at: "2026-10-29T10:00:00.000Z",
    status: "open",
    rationale: "k1 recurred 3 times",
    plan: plan as Proposal["plan"],
    references: { findings: ["k1"], checklist: [] },
    signals: { findings: 1 },
    metrics: null,
    resolution: null,
  };
}

describe("proposal store", () => {
  it("writes <id>.json and <id>.plan.json and lists them back", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const p = writeProposal(home, proposal("2026-10-29"));
    expect(p.plan_path).toBe(join(proposalsDir(home, REPO), "2026-10-29.plan.json"));
    expect(JSON.parse(readFileSync(p.plan_path, "utf8")).goal).toBe(plan.goal);
    expect(listProposals(home, REPO).map((x) => x.id)).toEqual(["2026-10-29"]);
    saveProposal(home, { ...p, status: "resolved", resolution: { at: "2026-11-02", status: "resolved", reason: "merged", run_id: "r1", pr: "u" } });
    expect(listProposals(home, REPO)[0]!.status).toBe("resolved");
  });

  it("picks a free id per day and kind", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const dir = proposalsDir(home, REPO);
    expect(nextProposalId(dir, "2026-10-29", "harden")).toBe("2026-10-29");
    writeProposal(home, proposal("2026-10-29"));
    expect(nextProposalId(dir, "2026-10-29", "harden")).toBe("2026-10-29-2");
    expect(nextProposalId(dir, "2026-10-29", "adopt")).toBe("2026-10-29-adopt");
  });

  it("skips unreadable files and rejects unknown fields", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    writeProposal(home, proposal("2026-10-29"));
    writeFileSync(join(proposalsDir(home, REPO), "junk.json"), "{");
    expect(listProposals(home, REPO)).toHaveLength(1);
    expect(ProposalSchema.safeParse({ ...proposal("x"), plan_path: "p", extra: 1 }).success).toBe(false);
  });
});

describe("updateMemory", () => {
  it("applies a change under the lock and writes it", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    updateMemory(home, REPO, (m) => {
      m.entries.push({ key: "k1", text: "t", reviewer: "plan", checkable: "lint", check_sketch: "", count: 1, first_seen: "a", last_seen: "a", runs: ["r"], status: "open", ref: null });
    });
    expect(loadMemory(home, REPO).entries.map((e) => e.key)).toEqual(["k1"]);
    expect(existsSync(join(memoryDir(home, REPO), "findings.json"))).toBe(true);
  });
});
