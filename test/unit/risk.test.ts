import { describe, expect, it } from "vitest";
import { diffSizeSignal, mergePolicy, riskClass, securityRows } from "../../src/pipeline/risk.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const repo = parseRepoConfig(`
sensitive_paths: ["src/auth/**"]
human_only_paths: [".github/**", "AGENTS.md"]
merge: { low_max_diff_lines: 100 }
`);
const risk = (changed: string[], diffLines = 10) => riskClass({ changed, diffLines, repo });

describe("risk class", () => {
  it("high when human_only_paths are touched", () => {
    expect(risk(["src/a.js", ".github/workflows/ci.yml"])).toMatchObject({ risk: "high" });
    expect(risk(["AGENTS.md", "src/auth/x.js"]).risk).toBe("high");
  });
  it("medium for sensitive paths and dependencies", () => {
    expect(risk(["src/auth/login.js"])).toMatchObject({ risk: "medium", reasons: ["sensitive_paths: src/auth/login.js"] });
    expect(risk(["package.json"]).risk).toBe("medium");
    expect(risk(["uv.lock"]).risk).toBe("medium");
  });
  it("a large or test-only diff stays low; size is a signal, not the class", () => {
    expect(risk(["src/a.js"], 101)).toEqual({ risk: "low", reasons: [] });
    expect(risk(["test/a.test.js", "test/fixtures/big.json"], 5000)).toEqual({ risk: "low", reasons: [] });
    expect(diffSizeSignal(101, 100)).toBe("diff 101 lines > 100");
    expect(diffSizeSignal(100, 100)).toBeNull();
    expect(diffSizeSignal(5000, 300)).toBe("diff 5000 lines > 300");
  });
  it("low otherwise", () => {
    expect(risk(["src/a.js"], 100)).toEqual({ risk: "low", reasons: [] });
  });
});

describe("human_review_paths (hard list)", () => {
  const withKey = (yaml: string) => parseRepoConfig(yaml);
  const classify = (r: typeof repo, changed: string[]) => riskClass({ changed, diffLines: 10, repo: r });

  it("default (key absent): migrations and secret files are high with a hard-list reason", () => {
    expect(risk(["supabase/migrations/001.sql"])).toEqual({ risk: "high", reasons: ["human_review_paths: supabase/migrations/001.sql"] });
    expect(risk(["src/a.js", ".env", "config/secrets/prod.yaml", "keys/server.pem"])).toEqual({
      risk: "high",
      reasons: ["human_review_paths: .env, config/secrets/prod.yaml, keys/server.pem"],
    });
  });

  it("default leaves auth, deploy and ordinary files off the hard list", () => {
    expect(risk(["src/auth/login.js"]).risk).toBe("medium");
    expect(risk(["Dockerfile", "deploy/app.yaml", "src/a.js"])).toEqual({ risk: "low", reasons: [] });
  });

  it("an explicit list replaces the default", () => {
    const r = withKey('merge: { human_review_paths: ["billing/**"] }');
    expect(classify(r, ["billing/charge.js", "src/a.js"])).toEqual({ risk: "high", reasons: ["human_review_paths: billing/charge.js"] });
    // Not listed any more: migrations are medium as before, secrets are low.
    expect(classify(r, ["db/migrations/001.sql"])).toEqual({ risk: "medium", reasons: ["migrations: db/migrations/001.sql"] });
    expect(classify(r, [".env"])).toEqual({ risk: "low", reasons: [] });
  });

  it("an empty list means no hard-list paths", () => {
    const r = withKey("merge: { human_review_paths: [] }");
    expect(classify(r, [".env", "src/a.js"])).toEqual({ risk: "low", reasons: [] });
    expect(classify(r, ["db/migrations/001.sql"]).risk).toBe("medium");
  });

  it("a file on both the hard list and sensitive_paths is high and named once", () => {
    const r = withKey('sensitive_paths: ["src/auth/**"]\nmerge: { human_review_paths: ["src/auth/keys.js"] }');
    expect(classify(r, ["src/auth/keys.js"])).toEqual({ risk: "high", reasons: ["human_review_paths: src/auth/keys.js"] });
    // Other files keep their own medium reasons next to the hard-list hit.
    expect(classify(r, ["src/auth/keys.js", "src/auth/login.js", "package.json"])).toEqual({
      risk: "high",
      reasons: ["human_review_paths: src/auth/keys.js", "sensitive_paths: src/auth/login.js", "dependencies: package.json"],
    });
  });

  it("human_only_paths behave as before and win over the hard list", () => {
    expect(risk([".github/workflows/ci.yml", "db/migrations/001.sql"])).toEqual({
      risk: "high",
      reasons: ["human_only_paths: .github/workflows/ci.yml", "changes protected config (CI / factory)"],
    });
  });

  it("the PR table names the hard-list hit", () => {
    const rows = securityRows(["db/migrations/001.sql", "src/a.js"], ["**/migrations/**"]);
    expect(rows.at(-1)).toEqual({ area: "Human review (hard list)", touched: true, note: "db/migrations/001.sql" });
    expect(securityRows(["src/a.js"], []).at(-1)).toMatchObject({ area: "Human review (hard list)", touched: false });
  });
});

describe("merge policy", () => {
  const merge = (yaml: string) => parseRepoConfig(yaml).merge;

  it("default auto_merge_max_risk none: everything human_review", () => {
    const m = merge("{}");
    expect(m.auto_merge_max_risk).toBe("none");
    for (const r of ["low", "medium", "high"] as const) expect(mergePolicy(r, "done", m)).toBe("human_review");
  });

  it("low: only low is auto", () => {
    const m = merge("merge: { auto_merge_max_risk: low, policy: { medium: bot_review } }");
    expect(mergePolicy("low", "done", m)).toBe("auto");
    expect(mergePolicy("medium", "done", m)).toBe("bot_review");
    expect(mergePolicy("high", "done", m)).toBe("human_review");
  });

  it("medium: low and medium auto, high never auto", () => {
    const m = merge("merge: { auto_merge_max_risk: medium }");
    expect(mergePolicy("low", "done", m)).toBe("auto");
    expect(mergePolicy("medium", "done", m)).toBe("auto");
    expect(mergePolicy("high", "done", m)).toBe("human_review");
  });

  it("rejects high as auto_merge_max_risk and auto in the policy map", () => {
    expect(() => merge("merge: { auto_merge_max_risk: high }")).toThrow();
    expect(() => merge("merge: { policy: { low: auto } }")).toThrow();
    expect(() => merge("merge: { policy: { high: bot_review } }")).toThrow();
  });

  it("a hard-list hit (high) waits for a human whatever the merge config says", () => {
    const m = merge("merge: { auto_merge_max_risk: medium, policy: { low: bot_review, medium: bot_review } }");
    const cfg = parseRepoConfig("{}");
    const high = riskClass({ changed: ["db/migrations/001.sql"], diffLines: 1, repo: cfg }).risk;
    expect(high).toBe("high");
    expect(mergePolicy(high, "done", m)).toBe("human_review");
  });

  it("needs_human always forces human_review", () => {
    const m = merge("merge: { auto_merge_max_risk: medium }");
    expect(mergePolicy("low", "needs_human", m)).toBe("human_review");
  });
});
