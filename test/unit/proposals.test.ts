import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMemory, memoryDir, updateMemory } from "../../src/memory.js";
import { listProposals, nextProposalId, type ProposalDraft, proposalsDir, saveProposal, writeProposal } from "../../src/proposals.js";
import { type Proposal, ProposalSchema } from "../../src/schemas/proposal.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const REPO = "github.com/acme/app";
const plan = {
  version: 1,
  type: "chore",
  goal: "Turn the null check finding into a lint rule",
  context: "",
  packages: [{ id: "P1", title: "lint rule", description: "", files: ["eslint.config.js"], depends_on: [], changes_flows: [] }],
  acceptance: [{ id: "A1", package: "P1", text: "lint fails on unchecked nulls", verify: "check", kind: "behavior", risk: false }],
  out_of_scope: [],
  protected_changes: [],
  resolves_findings: ["k1"],
};

function ticket(id: string, kind: Proposal["kind"] = "harden", n = 1): ProposalDraft {
  return {
    version: 1,
    kind,
    id,
    repo: REPO,
    created_at: "2026-10-29T10:00:00.000Z",
    proposals: Array.from({ length: n }, (_, i) => ({
      status: "open" as const,
      rationale: `reason ${i + 1}`,
      plan: { ...plan, goal: `${plan.goal} ${i + 1}`, resolves_findings: [`k${i + 1}`] } as Proposal["proposals"][number]["plan"],
      references: { findings: [`k${i + 1}`], checklist: [] },
      resolution: null,
    })),
    signals: { findings: 1 },
    metrics: null,
  };
}

describe("proposal store", () => {
  it("writes one ticket <id>.json with ranked proposals and one <id>.<rank>.plan.json each", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const t = writeProposal(home, ticket("2026-10-29", "harden", 3));
    expect(t.proposals.map((p) => [p.rank, p.id])).toEqual([[1, "2026-10-29.1"], [2, "2026-10-29.2"], [3, "2026-10-29.3"]]);
    expect(t.proposals[1]!.plan_path).toBe(join(proposalsDir(home, REPO), "2026-10-29.2.plan.json"));
    expect(JSON.parse(readFileSync(t.proposals[1]!.plan_path, "utf8")).goal).toBe(`${plan.goal} 2`);
    expect(listProposals(home, REPO).map((x) => x.id)).toEqual(["2026-10-29"]);
    const proposals = t.proposals.map((p, i) => (i === 1 ? { ...p, status: "resolved" as const, resolution: { at: "2026-11-02", status: "resolved" as const, reason: "merged", run_id: "r1", pr: "u" } } : p));
    saveProposal(home, { ...t, proposals });
    expect(listProposals(home, REPO)[0]!.proposals.map((p) => p.status)).toEqual(["open", "resolved", "open"]);
  });

  it("picks a free id per day and kind", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const dir = proposalsDir(home, REPO);
    expect(nextProposalId(dir, "2026-10-29", "harden")).toBe("2026-10-29");
    writeProposal(home, ticket("2026-10-29"));
    expect(nextProposalId(dir, "2026-10-29", "harden")).toBe("2026-10-29-2");
    expect(nextProposalId(dir, "2026-10-29", "adopt")).toBe("2026-10-29-adopt");
  });

  it("skips unreadable files; rejects unknown fields, empty lists and wrong ranks or ids", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const t = writeProposal(home, ticket("2026-10-29", "harden", 2));
    writeFileSync(join(proposalsDir(home, REPO), "junk.json"), "{");
    expect(listProposals(home, REPO)).toHaveLength(1);
    expect(ProposalSchema.safeParse(t).success).toBe(true);
    expect(ProposalSchema.safeParse({ ...t, extra: 1 }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...t, proposals: [] }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...t, proposals: [t.proposals[1], t.proposals[0]] }).success).toBe(false);
    expect(ProposalSchema.safeParse({ ...t, proposals: [{ ...t.proposals[0], id: "x.1" }, t.proposals[1]] }).success).toBe(false);
  });
});

describe("repo.yaml harden.max_proposals", () => {
  it("defaults to 5 and is bounded 1..10", () => {
    expect(parseRepoConfig("checks: []\n").harden.max_proposals).toBe(5);
    expect(parseRepoConfig("harden: { max_proposals: 2 }\n").harden.max_proposals).toBe(2);
    expect(() => parseRepoConfig("harden: { max_proposals: 11 }\n")).toThrow();
    expect(() => parseRepoConfig("harden: { max_proposals: 0 }\n")).toThrow();
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
