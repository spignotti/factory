import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchTestEvidence, parseTestReport, runCitedTests } from "../../src/gates/evidence.js";
import { testPresence, type EvidenceInputs } from "../../src/gates/builtin.js";
import { rolePrompt } from "../../src/prompts.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { PlanSchema } from "../../src/schemas/plan.js";
import { sh } from "../../src/exec.js";

const env = { PATH: process.env.PATH ?? "" };

describe("executed test evidence", () => {
  it("parses a real node run: a passing test counts and a skipped test does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-evidence-"));
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test/sum.test.js"),
      "import { test } from \"node:test\";\ntest(\"sum adds\", () => {});\ntest(\"later\", { skip: true }, () => {});\n",
    );
    const ran = await sh("node --test test/sum.test.js", { cwd: dir, env });
    expect(ran.code).toBe(0);
    const parsed = parseTestReport("test/sum.test.js", ran.output, ran.code);
    expect(parsed).toEqual([
      { file: "test/sum.test.js", name: "sum adds", result: "pass" },
      { file: "test/sum.test.js", name: "later", result: "skip" },
    ]);
    expect(matchTestEvidence("test/sum.test.js::sum adds", parsed, true)).toEqual({ ok: true, reason: "" });
    expect(matchTestEvidence("test/sum.test.js::later", parsed, true).reason).toMatch(/skipped test/);
    expect(matchTestEvidence("test/sum.test.js::nope", parsed, true).reason).toMatch(/invented reference/);
    expect(matchTestEvidence("test/missing.test.js::sum adds", parsed, false).reason).toMatch(/file not in the tree/);
  });

  it("cites a SQL file that the command ran, without a second test that reads its source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sql-"));
    mkdirSync(join(dir, "supabase/tests"), { recursive: true });
    writeFileSync(join(dir, "supabase/tests/rls.sql"), "select 1;\n");
    const executed = await runCitedTests({
      cwd: dir,
      files: ["supabase/tests/rls.sql"],
      testCommand: "test -s {files}",
      env,
    });
    expect(executed).toEqual([{ file: "supabase/tests/rls.sql", name: "", result: "pass" }]);
    const plan = PlanSchema.parse({
      version: 1, type: "feature", goal: "rls",
      packages: [{ id: "P1", title: "rls", files: ["supabase/tests/rls.sql"] }],
      acceptance: [{ id: "A1", package: "P1", text: "tenant isolation holds", verify: "test" }],
    });
    const handoff = HandoffSchema.parse({
      package: "P1",
      evidence: [{ acceptance_id: "A1", kind: "test", ref: "supabase/tests/rls.sql" }],
    });
    const evidence: EvidenceInputs = {
      files: ["supabase/tests/rls.sql"],
      executed,
      knownChecks: [],
      ranChecks: [],
    };
    expect(testPresence(plan, ["P1"], [handoff], evidence).ok).toBe(true);
    expect(handoff.evidence).toHaveLength(1);
  });
});

describe("evidence prompts", () => {
  it("planner, implementer and reviewer do not demand a wrapper or a wording test", () => {
    const plan = rolePrompt("plan");
    const implement = rolePrompt("implement");
    const review = `${rolePrompt("review-plan")}\n${rolePrompt("review-common")}`;
    expect(plan).toMatch(/Documentation wording and organizational non-goals are verify:review, not verify:test/);
    expect(plan).toMatch(/do not add a test whose only job is to read another test's source/);
    expect(plan).not.toMatch(/prefer verify:test or verify:check over review/);
    expect(implement).toMatch(/do not add a wrapper/);
    expect(implement).not.toMatch(/write a test for each verify:test criterion/);
    expect(review).toMatch(/does not need a new test file or a wrapper/);
    expect(review).toMatch(/do not need sentence, screenshot, or test-name tests/);
  });

  it("review-checklist resolves to the standards prompt", () => {
    expect(rolePrompt("review-checklist")).toBe(rolePrompt("review-standards"));
    expect(rolePrompt("review-standards")).toMatch(/standards_items/);
  });
});
