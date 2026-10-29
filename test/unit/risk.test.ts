import { describe, expect, it } from "vitest";
import { mergePolicy, riskClass } from "../../src/pipeline/risk.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const repo = parseRepoConfig(`
sensitive_paths: ["src/auth/**"]
human_only_paths: [".github/**", "AGENTS.md"]
merge: { low_max_diff_lines: 100 }
`);
const risk = (changed: string[], diffLines = 10, laneEscalated = false) => riskClass({ changed, diffLines, repo, laneEscalated });

describe("risk class", () => {
  it("high when human_only_paths are touched", () => {
    expect(risk(["src/a.js", ".github/workflows/ci.yml"])).toMatchObject({ risk: "high" });
    expect(risk(["AGENTS.md", "src/auth/x.js"]).risk).toBe("high");
  });
  it("medium for sensitive paths, dependencies, migrations, big diffs, lane escalation", () => {
    expect(risk(["src/auth/login.js"])).toMatchObject({ risk: "medium", reasons: ["sensitive_paths: src/auth/login.js"] });
    expect(risk(["package.json"]).risk).toBe("medium");
    expect(risk(["uv.lock"]).risk).toBe("medium");
    expect(risk(["supabase/migrations/001.sql"]).risk).toBe("medium");
    expect(risk(["src/a.js"], 101)).toMatchObject({ risk: "medium", reasons: ["diff 101 lines > 100"] });
    expect(risk(["src/a.js"], 10, true)).toMatchObject({ risk: "medium", reasons: ["fast-lane escalation"] });
  });
  it("low otherwise", () => {
    expect(risk(["src/a.js"], 100)).toEqual({ risk: "low", reasons: [] });
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

  it("needs_human always forces human_review", () => {
    const m = merge("merge: { auto_merge_max_risk: medium }");
    expect(mergePolicy("low", "needs_human", m)).toBe("human_review");
  });
});
