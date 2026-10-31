import { describe, expect, it } from "vitest";
import { protectedPaths } from "../../src/gates/builtin.js";
import { repoConfigLoosening } from "../../src/gates/config-guard.js";
import { riskClass } from "../../src/pipeline/risk.js";
import { isProtected, type Plan, validatePlan } from "../../src/schemas/plan.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { protectedSection } from "../../src/steps/finalize.js";

const repo = parseRepoConfig(`human_only_paths: [".factory/**", ".github/workflows/**"]\n`);

function plan(files: string[], protected_changes: unknown[] = []) {
  return {
    version: 1,
    type: "chore",
    goal: "g",
    packages: [{ id: "P1", title: "t", files }],
    acceptance: [{ id: "A1", package: "P1", text: "works", verify: "review" }],
    protected_changes,
  };
}
const errorsOf = (raw: unknown) => {
  const r = validatePlan(raw, { repo });
  return r.ok ? [] : r.errors;
};
const decl = (file: string) => ({ file, change: "add the npm test check", reason: "the task asks for it" });

describe("protected changes in the plan", () => {
  it("a declared protected file in a package's files is valid", () => {
    expect(errorsOf(plan(["src/a.ts", ".factory/repo.yaml"], [decl(".factory/repo.yaml")]))).toEqual([]);
  });

  it("a protected file in files without a declaration is rejected", () => {
    expect(errorsOf(plan([".github/workflows/ci.yml"]))).toEqual([
      "P1: .github/workflows/ci.yml is under human_only_paths; declare it in protected_changes (file, change, reason) or drop it",
    ]);
  });

  it("declarations must be protected, exact paths, in a package and unique", () => {
    expect(errorsOf(plan(["src/a.ts"], [decl("src/a.ts")]))).toContain("protected_changes: src/a.ts is not under human_only_paths (plan it as a normal file)");
    expect(errorsOf(plan(["src/a.ts"], [decl(".factory/repo.yaml")]))).toContain("protected_changes: .factory/repo.yaml is in no package's files");
    expect(errorsOf(plan([".factory/repo.yaml"], [decl(".factory/*")]))).toContain("protected_changes: .factory/* must be a file path, not a glob");
    expect(errorsOf(plan([".factory/repo.yaml"], [decl(".factory/repo.yaml"), decl(".factory/repo.yaml")]))).toContain("protected_changes: .factory/repo.yaml declared twice");
  });

  it("verify guides are never protected, even under .factory/**", () => {
    expect(isProtected(".factory/verify/tours.md", repo.human_only_paths)).toBe(false);
    expect(isProtected(".factory/review-rules.md", repo.human_only_paths)).toBe(true);
    expect(errorsOf(plan([".factory/verify/tours.md"]))).toEqual([]);
  });
});

describe("protected_paths gate", () => {
  const p = (decls: string[]) => ({ protected_changes: decls.map(decl) }) as unknown as Plan;
  it("fails on a changed protected file the plan does not declare", () => {
    const r = protectedPaths(p([".factory/repo.yaml"]), ["src/a.ts", ".factory/repo.yaml", ".github/workflows/x.yml"], repo.human_only_paths);
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/without a protected_changes entry.*\.github\/workflows\/x\.yml$/);
    expect(r.detail).not.toMatch(/repo\.yaml/);
  });
  it("passes when every changed protected file is declared", () => {
    expect(protectedPaths(p([".factory/repo.yaml"]), [".factory/repo.yaml", ".factory/verify/a.md"], repo.human_only_paths)).toMatchObject({ ok: true });
  });
});

describe("risk of protected changes", () => {
  it("is high with the human-approval reason", () => {
    const r = riskClass({ changed: [".github/workflows/ci.yml"], diffLines: 3, repo });
    expect(r.risk).toBe("high");
    expect(r.reasons.join("\n")).toMatch(/human approval required, never auto-merged/);
    expect(riskClass({ changed: [".factory/verify/a.md"], diffLines: 3, repo }).risk).toBe("low");
  });
});

describe("repo.yaml loosening", () => {
  const base = `
setup: npm ci
checks:
  - { name: typecheck, run: npm run typecheck, tier: fast }
human_only_paths: [".factory/**"]
limits: { forbidden_paths: [".env*"] }
`;
  it("adding a check or a protection is not loosening", () => {
    const after = base.replace("checks:\n", "checks:\n  - { name: test, run: npm test, tier: fast }\n").replace('[".factory/**"]', '[".factory/**", ".github/**"]');
    expect(repoConfigLoosening(base, after)).toEqual([]);
    expect(repoConfigLoosening(base, `${base}tests: { globs: ["test/**"] }\n`)).toEqual([]);
  });
  it("removing or changing checks, protections, secrets or agent env is", () => {
    expect(repoConfigLoosening(base, base.replace("checks:\n  - { name: typecheck, run: npm run typecheck, tier: fast }\n", "checks: []\n"))).toEqual(["check typecheck removed"]);
    expect(repoConfigLoosening(base, base.replace("tier: fast", "tier: manual"))).toEqual(["check typecheck changed (run, tier, paths, services or local_only)"]);
    expect(repoConfigLoosening(base, base.replace("tier: fast", "tier: fast, local_only: true"))).toEqual(["check typecheck made local_only (dropped from CI)"]);
    // a new local_only check adds coverage; a new host service runs outside the sandbox
    expect(repoConfigLoosening(base, base.replace("checks:\n", "checks:\n  - { name: db, run: x, tier: full, local_only: true }\n"))).toEqual([]);
    const host = `${base}services:\n  - { name: db, host: true, start: x, ports: [54322], env_from: { command: s, map: { DB_URL: DB_URL } } }\n`;
    expect(repoConfigLoosening(base, host)).toEqual(["host service db added (runs outside the sandbox)"]);
    expect(repoConfigLoosening(host, host.replace("ports: [54322], ", ""))).toEqual(["service db changed or removed"]);
    expect(repoConfigLoosening(host, host.replace(", env_from: { command: s, map: { DB_URL: DB_URL } }", ""))).toEqual(["service db changed or removed"]);
    expect(repoConfigLoosening(base, base.replace('[".factory/**"]', "[]"))).toEqual(["human_only_paths removed: .factory/**"]);
    expect(repoConfigLoosening(base, base.replace('[".env*"]', "[]"))).toEqual(["limits.forbidden_paths removed: .env*"]);
    expect(repoConfigLoosening(base, `${base}agent_env: [API_TOKEN]\nmerge: { auto_merge_max_risk: medium }\n`)).toEqual([
      "merge.auto_merge_max_risk raised",
      "agent_env added: API_TOKEN",
    ]);
    expect(repoConfigLoosening(base, `${base}secrets: { provider: env_file, names: [X_TOKEN] }\n`)).toEqual(["secrets changed"]);
    expect(repoConfigLoosening(base, base.replace('[".env*"] }', '[".env*"], diff_exclude: ["dist/**"] }'))).toEqual(["limits.diff_exclude added: dist/**"]);
    const withEx = base.replace('[".env*"] }', '[".env*"], diff_exclude: ["dist/**", "gen/**"] }');
    expect(repoConfigLoosening(withEx, base)).toEqual([]);
    expect(repoConfigLoosening(withEx, withEx.replace('"gen/**"', '"gen/**", "out/**"'))).toEqual(["limits.diff_exclude added: out/**"]);
    expect(repoConfigLoosening(base, base.replace("npm ci", "npm i"))).toEqual(["setup changed"]);
    expect(repoConfigLoosening(base, undefined)).toEqual(["repo.yaml deleted"]);
    expect(repoConfigLoosening(base, "checks: 3\n")[0]).toMatch(/^repo\.yaml no longer valid/);
  });
});

describe("PR section", () => {
  it("lists declared and undeclared files, fences and caps the diff", () => {
    const ctx = { plan: { protected_changes: [decl(".factory/repo.yaml")] } as unknown as Plan };
    expect(protectedSection(ctx, [], "")).toBe("");
    const s = protectedSection(ctx, [".factory/repo.yaml", ".github/workflows/x.yml"], "+a\n```\n");
    expect(s).toContain("- `.factory/repo.yaml`: add the npm test check (why: the task asks for it)");
    expect(s).toContain("- `.github/workflows/x.yml`: not declared in the plan");
    expect(s).toContain("~~~~diff");
    expect(protectedSection(ctx, [".factory/repo.yaml"], "x".repeat(40_000))).toContain("diff truncated");
  });
});
