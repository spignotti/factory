import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { resolveImproveConfig } from "../../src/commands/improve.js";
import { paginateOpenIssues, readIssuePage } from "../../src/gh.js";
import { dedupeProposals, findingsInKey, proposalKey, proposalMarker } from "../../src/improve/issues.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { PLAN } from "../helpers/harden.js";

const plan = (files: string[], resolves: string[] = []) => ({ ...PLAN("goal", resolves), packages: [{ ...PLAN("goal", resolves).packages[0]!, files }] });

describe("proposal identity", () => {
  it("keys findings in sorted order, and otherwise hashes the sorted file paths", () => {
    expect(proposalKey("findings", plan([], ["b", "a", "a"]))).toBe("findings:a,b");
    expect(proposalKey("security", plan(["src/b.ts", "src/a.ts"]))).toBe(proposalKey("security", plan(["src/a.ts", "src/b.ts"])));
    expect(proposalKey("security", plan(["src/a.ts"]))).not.toBe(proposalKey("security", plan(["src/b.ts"])));
    expect(proposalKey("security", plan(["src/a.ts"])).slice("security:".length)).toMatch(/^[0-9a-f]{64}$/);
    expect(findingsInKey(proposalKey("security", plan(["src/a.ts"])))).toEqual([]);
    expect(findingsInKey("findings:b,a")).toEqual(["b", "a"]);
    const key = proposalKey("security", plan(["src/a.ts"], ["z", "m"]));
    expect(proposalMarker(key)).toBe(`<!-- factory-proposal: ${key} -->`);
    expect(key).toBe("security:m,z");
  });

  it("keeps the first proposal with a key and lists the second", () => {
    const first = { plan: plan(["src/a.ts"], ["b", "a"]) };
    first.plan.goal = "Add rate limiting";
    const second = { plan: plan(["src/other.ts"], ["a", "b"]) };
    second.plan.goal = "Add rate limiting.";
    const { kept, dropped } = dedupeProposals("security", [first, second]);
    expect(kept).toEqual([first]);
    expect(dropped).toEqual([`dropped duplicate proposal key security:a,b: Add rate limiting.`]);
    const other = { plan: plan(["src/rate.ts"]) };
    other.plan.goal = "Add rate limiting";
    expect(dedupeProposals("security", [first, other]).kept).toHaveLength(2);
  });
});

describe("open issue pages", () => {
  const issue = (n: number, label = "factory-ready") => ({ number: n, title: `t${n}`, body: "<!-- factory-proposal: findings:a -->", labels: [{ name: label }], state: "OPEN" });
  const pr = (n: number) => ({ ...issue(n), pull_request: { url: "https://github.test/pull/1" } });

  it("drops pull requests and keeps a label that is not factory-proposal", () => {
    const page = readIssuePage([issue(4), pr(9), { number: 0, title: "bad", labels: [] }]);
    expect(page.map((i) => i.number)).toEqual([4]);
    expect(page[0]).toMatchObject({ labels: ["factory-ready"], state: "open" });
    expect(() => readIssuePage({})).toThrow(/not a JSON array/);
  });

  it("is complete on a short page and incomplete when the page cap is full", async () => {
    const done = await paginateOpenIssues(async () => [issue(1), pr(2)], 3, 5);
    expect(done.complete).toBe(true);
    expect(done.issues.map((i) => i.number)).toEqual([1]);

    const capped = await paginateOpenIssues(async (page) => [issue(page)], 1, 2);
    expect(capped.complete).toBe(false);
    expect(capped.issues.map((i) => i.number)).toEqual([1, 2]);
    await expect(paginateOpenIssues(async () => ({}))).rejects.toThrow(/not a JSON array/);
  });
});

describe("audit thinking fallback", () => {
  const resolved = (text: string) => resolveImproveConfig(parseRepoConfig(text), (parse(text) ?? {}) as Record<string, unknown>);

  it("uses the higher of refactor and simplify, and ignores a type that is not enabled", () => {
    expect(resolved("audit:\n  types: [refactor, simplify]\n  thinking: { refactor: low, simplify: high }\n").thinking.structure).toBe("high");
    expect(resolved("audit:\n  types: [refactor, simplify]\n  thinking: { refactor: xhigh, simplify: low }\n").thinking.structure).toBe("xhigh");
    expect(resolved("audit:\n  types: [refactor]\n  thinking: { refactor: low, simplify: high }\n").thinking.structure).toBe("low");
    expect(resolved("audit:\n  types: [simplify]\n  thinking: { simplify: high }\n").thinking.structure).toBe("high");
  });
});
