import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan } from "../../src/schemas/plan.js";
import {
  classifyScopeFile,
  collectScopeFindings,
  MAX_SCOPE_REPAIRS,
  planScopeRepair,
  scopeFingerprint,
  scopeHunks,
  type ScopeFileFacts,
  type ScopeFinding,
} from "../../src/pipeline/scope-repair.js";

const RUN = "factory-bot@users.noreply.github.com";

const finding = (file: string, hunks: string[], ownership: ScopeFinding["ownership"] = "run"): ScopeFinding => ({ file, hunks, ownership });
const facts = (over: Partial<ScopeFileFacts> & { file: string }): ScopeFileFacts => ({
  commits: [{ authorEmail: RUN, subject: "feat(P1): x" }],
  uncommitted: false,
  protectedPath: false,
  planned: false,
  ...over,
});

describe("scope repair classification (#180)", () => {
  it("only changes the run committed are removable", () => {
    expect(classifyScopeFile(facts({ file: "docs/scratch.md" }), RUN)).toBe("run");
    expect(classifyScopeFile(facts({ file: "docs/scratch.md", commits: [{ authorEmail: "human@test", subject: "note" }] }), RUN)).toBe("foreign");
    expect(classifyScopeFile(
      facts({ file: "docs/scratch.md", commits: [{ authorEmail: RUN, subject: "feat(P1): x" }, { authorEmail: "human@test", subject: "note" }] }),
      RUN,
    )).toBe("mixed");
  });

  it("the resume protocol's human fix is not run-owned even under the factory identity", () => {
    expect(classifyScopeFile(facts({ file: "a.md", commits: [{ authorEmail: RUN, subject: "fix: human changes before resume" }] }), RUN)).toBe("foreign");
    expect(
      classifyScopeFile(
        facts({ file: "a.md", commits: [{ authorEmail: RUN, subject: "fix: human changes before resume" }, { authorEmail: RUN, subject: "feat(P1): x" }] }),
        RUN,
      ),
    ).toBe("mixed");
  });

  it("a deviation no commit owns is unattributed, never assumed removable", () => {
    expect(classifyScopeFile(facts({ file: "a.md", commits: [] }), RUN)).toBe("unattributed");
  });

  it("protected config and planned files are outside what cleanup may remove", () => {
    expect(classifyScopeFile(facts({ file: ".github/workflows/ci.yml", protectedPath: true }), RUN)).toBe("protected");
    expect(classifyScopeFile(facts({ file: "src/math.js", planned: true }), RUN)).toBe("protected");
  });

  it("an uncommitted delta on top of the run's commits is uncertain", () => {
    expect(classifyScopeFile(facts({ file: "a.md", uncommitted: true }), RUN)).toBe("mixed");
  });
});

describe("scope repair decision (#180)", () => {
  const runId = "20260101-000000-abcdef";

  it("no deviations: the loop proceeds untouched", () => {
    expect(planScopeRepair([], { scopeRepairs: 0 }, runId)).toEqual({ action: "clean" });
  });

  it("foreign or uncertain changes stop as a decision and nothing is removed", () => {
    const plan = planScopeRepair([finding("notes/x.md", ["@@ -0,0 +1,2 @@"], "foreign")], { scopeRepairs: 0 }, runId);
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.cause).toBe("explicit_decision");
    expect(plan.reason).toContain("notes/x.md");
    expect(plan.reason).toContain("@@ -0,0 +1,2 @@"); // actionable file/hunk evidence
    expect(plan.reason).toMatch(/never discards/i);
  });

  it("a removable set is removed once; the identical set returning is an unchanged failure that stops", () => {
    const set = [finding("assets/logo.png", ["Binary files a/assets/logo.png and b/assets/logo.png differ (binary artifact)"])];
    const budget = { scopeRepairs: 0, scopeLast: undefined as string | undefined };
    const first = planScopeRepair(set, budget, runId);
    expect(first.action).toBe("remove");
    if (first.action !== "remove") return;
    budget.scopeRepairs = 1;
    budget.scopeLast = first.fingerprint;
    const again = planScopeRepair(set, budget, runId);
    expect(again.action).toBe("stop");
    if (again.action !== "stop") return;
    expect(again.cause).toBe("explicit_decision");
    expect(again.reason).toContain("returned unchanged");
    expect(again.reason).toContain("assets/logo.png");
  });

  it("the shared persisted budget caps different deviation sets: exhaustion is a decision, not a loop", () => {
    const plan = planScopeRepair([finding("a.md", ["@@ -1 +1 @@"])], { scopeRepairs: MAX_SCOPE_REPAIRS }, runId);
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.cause).toBe("budget_exhausted");
  });

  it("fingerprint is order-stable, content-sensitive and covers every file", () => {
    const a = scopeFingerprint([finding("a.md", ["@@ -0,0 +1 @@"], "foreign"), finding("b.md", ["@@ -0,0 +2 @@"], "foreign")]);
    const b = scopeFingerprint([finding("b.md", ["@@ -0,0 +2 @@"], "foreign"), finding("a.md", ["@@ -0,0 +1 @@"], "foreign")]);
    expect(a).toBe(b);
    expect(scopeFingerprint([finding("a.md", ["@@ -0,0 +9 @@"], "foreign"), finding("b.md", ["@@ -0,0 +2 @@"], "foreign")])).not.toBe(a);
    expect(scopeFingerprint([finding("a.md", ["@@ -0,0 +1 @@"], "foreign")])).not.toBe(a);
  });

  it("hunk evidence names the binary artifact and caps text hunks", () => {
    expect(scopeHunks("Binary files a/x.png and b/x.png differ\n")).toEqual(["Binary files a/x.png and b/x.png differ (binary artifact)"]);
    const many = Array.from({ length: 30 }, (_, i) => `@@ -${i},1 +${i},1 @@`).join("\n");
    expect(scopeHunks(many)).toHaveLength(12);
  });
});

describe("scope findings from git evidence (#180)", () => {
  it("separates run-owned, foreign and uncertain deviations in a real repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-git-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const gAs = (who: string, email: string, ...args: string[]) => g("-c", `user.name=${who}`, "-c", `user.email=${email}`, ...args);
    g("init", "-q", "-b", "main");
    writeFileSync(join(dir, "src.txt"), "base\n");
    gAs("alice", "alice@test", "add", "-A");
    gAs("alice", "alice@test", "commit", "-q", "-m", "init");
    const base = g("rev-parse", "HEAD").trim();
    g("checkout", "-q", "-b", "factory", base);
    // the run adds an unrelated image artifact and an unrelated test file
    writeFileSync(join(dir, "logo.png"), "\u0000PNG\u0000");
    writeFileSync(join(dir, "extra.test.js"), "test.skip(\"scratch\", () => {});\n");
    gAs("factory-bot", "factory-bot@users.noreply.github.com", "add", "-A");
    gAs("factory-bot", "factory-bot@users.noreply.github.com", "commit", "-q", "-m", "feat(P1): multiply");
    // a person commits their own unrelated note onto the branch
    writeFileSync(join(dir, "human.md"), "a person's note\n");
    gAs("bob", "bob@test", "add", "-A");
    gAs("bob", "bob@test", "commit", "-q", "-m", "my note");
    // and the worktree still holds an uncommitted change to a planned-adjacent unplanned file
    writeFileSync(join(dir, "draft.txt"), "nobody claims this yet\n");

    const plan = {
      goal: "multiply",
      packages: [{ id: "P1", title: "t", description: "", files: ["src.txt"], depends_on: [], changes_flows: [] }],
      protected_changes: [],
    } as unknown as Plan;
    const findings = await collectScopeFindings(dir, base, plan, [".factory/**"], "factory-bot@users.noreply.github.com");
    const by = Object.fromEntries(findings.map((f) => [f.file, f.ownership]));
    expect(by).toMatchObject({ "logo.png": "run", "extra.test.js": "run", "human.md": "foreign", "draft.txt": "unattributed" });
    expect(findings.find((f) => f.file === "extra.test.js")!.hunks.join(" ")).toMatch(/@@ -0,0 \+1 @@/);
    expect(findings.find((f) => f.file === "logo.png")!.hunks.join(" ")).toMatch(/binary/i);
  });
});
