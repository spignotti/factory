import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import type { AgentRequest } from "../../src/agents/runner.js";
import { evalCommand, experimentCommand, validateCommand } from "../../src/commands/eval.js";
import { evalOne, type EvalDeps, layerOn, type LoadedEvalProfile, loadTasks, resolveEvalProfile, runEval } from "../../src/eval/eval.js";
import { createSandbox, hostProbe, type Sandbox } from "../../src/sandbox/sandbox.js";
import { EvalRecordSchema, EvalTaskSchema, VerdictSchema } from "../../src/schemas/eval.js";
import { commitFile, createFixtureRepo, FIXTURES, gitIn } from "../helpers/repo.js";

const MATH = (op: string) => `export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function multiply(a, b) {\n  return a ${op} b;\n}\n`;
const HIDDEN = `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../../src/math.js";\n\ntest("hidden multiply", () => {\n  assert.equal(multiply(4, 5), 20);\n});\n`;

/** Fixture repo: base commit, then an "upstream fix" commit with multiply and a hidden test. */
function taskRepo(): { repo: string; base: string; fix: string } {
  const repo = createFixtureRepo();
  const base = gitIn(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "src", "math.js"), MATH("*"));
  commitFile(repo, "test/hidden/multiply.test.js", HIDDEN, "upstream fix");
  const fix = gitIn(repo, "rev-parse", "HEAD").trim();
  gitIn(repo, "checkout", "-q", base); // the hidden commit is not checked out anywhere
  return { repo, base, fix };
}

function writeTask(dir: string, t: { repo: string; base: string; fix: string }, id = "fixture-multiply"): string {
  const path = join(dir, `${id}.yaml`);
  writeFileSync(
    path,
    [
      `id: ${id}`,
      `repo: ${t.repo}`,
      `base: ${t.base}`,
      "task: |\n  Add a multiply function to src/math.js. multiply(2, 3) returns 6.",
      "hidden:",
      `  from_commit: ${t.fix}`,
      "  paths: [test/hidden/multiply.test.js]",
      "  check: node --test test/hidden/multiply.test.js",
      "plan_effort: high",
      "timeout_min: 5",
      "license: MIT",
      "source: test fixture",
      "",
    ].join("\n"),
  );
  return path;
}

const script = (name: string): FakeStep[] => FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", name), "utf8"))).steps;

/** Round 1 implements `a + b` with a weak own test; review raises a bug; the fix writes `a * b`. */
function bugFixedInRound2(): FakeStep[] {
  const steps = structuredClone(script("wontfix.json"));
  const impl = steps[1]!;
  impl.writes = {
    "src/math.js": MATH("+"),
    "test/multiply.test.js": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(typeof multiply(2, 3), "number");\n});\n`,
  };
  const finding = (steps[2]!.output as { findings: Record<string, unknown>[] }).findings[0]!;
  Object.assign(finding, { severity: "bug", claim: "multiply adds instead of multiplying", checkable: "no" });
  steps[4]!.writes = { "src/math.js": MATH("*") };
  (steps[4]!.output as { responses: Record<string, unknown>[] }).responses[0] = { finding_id: "R1-plan-1", status: "fixed", response: "now multiplies" };
  (steps[5]!.output as { prior: Record<string, unknown>[] }).prior[0] = { finding_id: "R1-plan-1", verdict: "resolved" };
  return steps;
}

const profile = (name: string, prompts: Record<string, string> = {}): LoadedEvalProfile => ({ name, source: `${name}.yaml`, data: {}, prompts });

function deps(runners: Record<string, () => FakeStep[]>, seen: AgentRequest[] = [], extra: Partial<EvalDeps> = {}): EvalDeps & { workDir: string } {
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  mkdirSync(join(factoryHome), { recursive: true });
  writeFileSync(join(factoryHome, "profile.yaml"), readFileSync(join(FIXTURES, "profile.yaml")));
  return {
    factoryHome,
    workDir: mkdtempSync(join(tmpdir(), "factory-eval-")),
    runner: (p) => {
      const fake = new FakeRunner(runners[p.name]!());
      return { run: (req) => (seen.push(req), fake.run(req)) };
    },
    now: (() => {
      let t = 1_000_000;
      return () => (t += 1000);
    })(),
    ...extra,
  };
}

describe("factory eval (fake runner)", () => {
  it("clean pass: hidden tests copied in after the run and green; agents never saw the hidden commit", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const seen: AgentRequest[] = [];
    const d = deps({ a: () => script("clean.json") }, seen);
    const r = await evalOne(task!, profile("a"), 1, d);
    expect(EvalRecordSchema.parse(r)).toMatchObject({ task: "fixture-multiply", profile: "a", result: "done", hidden_pass: true, rounds: 1, real_findings: 0, gate_failures: 0, bug_findings: 0 });
    expect(r.tokens_in).toBeGreaterThan(0);
    expect(r.usage.map((u) => u.role)).toContain("implement");
    expect(r.wall_s).toBeGreaterThan(0);
    // isolation: the user's factory home got no run; the clone dir is gone
    expect(existsSync(join(d.factoryHome, "runs"))).toBe(false);
    expect(existsSync(join(d.workDir, "fixture-multiply--a--1"))).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) expect(req.prompt).not.toContain("hidden multiply");
  });

  it("a bug finding fixed in round 2 that turns the hidden check green counts as a real finding", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const r = await evalOne(task!, profile("a"), 1, deps({ a: bugFixedInRound2 }));
    expect(r).toMatchObject({ result: "done", hidden_pass: true, rounds: 2, real_findings: 1 });
  });

  it("a wontfix suggestion is no real finding; the hidden check fails on a wrong implementation", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const wrong = () => {
      const s = bugFixedInRound2();
      s[4]!.writes = {}; // the "fix" changes nothing
      (s[4]!.output as { responses: Record<string, unknown>[] }).responses[0] = { finding_id: "R1-plan-1", status: "wontfix", response: "intended" };
      (s[5]!.output as { prior: Record<string, unknown>[] }).prior[0] = { finding_id: "R1-plan-1", verdict: "accept_wontfix" };
      return s;
    };
    const r = await evalOne(task!, profile("a"), 1, deps({ a: wrong }));
    expect(r.hidden_pass).toBe(false);
    expect(r.real_findings).toBe(0);
    expect(r.hidden_output).toMatch(/hidden multiply|20/);
  });

  it("prompt overrides of a profile replace the role prompt", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const seen: AgentRequest[] = [];
    await evalOne(task!, profile("v", { implement: "VARIANT-IMPLEMENT-PROMPT" }), 1, deps({ v: () => script("clean.json") }, seen));
    const impl = seen.find((r) => r.role === "implement")!;
    expect(impl.prompt + (impl.system ?? "")).toContain("VARIANT-IMPLEMENT-PROMPT");
    const review = seen.find((r) => r.role === "review_plan")!;
    expect(review.prompt + (review.system ?? "")).not.toContain("VARIANT-IMPLEMENT-PROMPT");
  });

  it("a harness error (bad base sha) is recorded as result error, not thrown", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), { ...t, base: "f".repeat(40) }));
    const r = await evalOne(task!, profile("a"), 1, deps({ a: () => script("clean.json") }));
    expect(r).toMatchObject({ result: "error", hidden_pass: false });
  });

  it("runEval interleaves profiles per task and repeat", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const order: string[] = [];
    const rs = await runEval({ tasks: [task!], profiles: [profile("a"), profile("b")], repeat: 2 }, deps({ a: () => script("clean.json"), b: () => script("clean.json") }), (r) => order.push(`${r.profile}${r.repeat}`));
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
    expect(rs).toHaveLength(4);
  });

  it("eval and experiment commands write jsonl + markdown and a schema-valid verdict", async () => {
    const t = taskRepo();
    const dir = mkdtempSync(join(tmpdir(), "evalcmd-"));
    writeTask(dir, t);
    writeFileSync(join(dir, "a.yaml"), "description: base\n");
    writeFileSync(join(dir, "b.yaml"), "description: variant\nflags: { plan_effort: medium }\n");
    let out = "";
    const io = { out: (s: string) => void (out += s), err: () => undefined };
    const d = deps({ a: () => script("clean.json"), b: () => script("clean.json") });
    expect(await evalCommand({ profiles: ["a.yaml"], tasks: "*-multiply.yaml", repeat: 1, cwd: dir }, d, io)).toBe(0);
    expect(out).toContain("| a | 1 | 1 |");
    const day = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(dir, "evals", "results", `${day}.jsonl`), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(dir, "evals", "results", `${day}.md`), "utf8")).toContain("## eval a");

    out = "";
    expect(await experimentCommand({ base: "a.yaml", variant: "b.yaml", tasks: "*-multiply.yaml", repeat: 1, cwd: dir }, d, { out: (s) => void (out += s), err: () => undefined })).toBe(2);
    expect(await experimentCommand({ base: "a.yaml", variant: "b.yaml", tasks: "*-multiply.yaml", repeat: 2, cwd: dir }, d, io)).toBe(0);
    const verdict = VerdictSchema.parse(JSON.parse(out));
    expect(verdict).toMatchObject({ base: "a", variant: "b", repeat: 2, tasks: ["fixture-multiply"], cost_measure: "usd" });
    expect(verdict.summaries.base.runs).toBe(2);
    expect(verdict.summaries.variant.determinism_ratio).toBe(1);
    expect(readFileSync(join(dir, "evals", "results", `${day}.jsonl`), "utf8").trim().split("\n")).toHaveLength(5);
  });

  it("--validate: hidden tests red on base and green on the upstream fix; a non-detecting task fails", async () => {
    const t = taskRepo();
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    writeTask(dir, t, "good");
    // hidden tests that already pass on base: useless as a task
    const weak = join(dir, "weak.yaml");
    writeFileSync(weak, readFileSync(writeTask(dir, t, "weak-src"), "utf8").replace("id: weak-src", "id: weak").replace("test/hidden/multiply.test.js]", "test/math.test.js]").replace("check: node --test test/hidden/multiply.test.js", "check: node --test test/math.test.js"));
    let out = "";
    const io = { out: (s: string) => void (out += s), err: () => undefined };
    const d = deps({});
    expect(await validateCommand({ tasks: "good.yaml", cwd: dir }, d, io)).toBe(0);
    expect(out).toContain("ok   good");
    out = "";
    expect(await validateCommand({ tasks: "weak.yaml", cwd: dir }, d, io)).toBe(1);
    expect(out).toContain("FAIL weak");
  });

  const realSandbox = ((): Sandbox | undefined => {
    try {
      return createSandbox("required", hostProbe);
    } catch {
      return undefined;
    }
  })();

  it.skipIf(!realSandbox)("sandboxed: hidden check and real-findings verification run jailed", async () => {
    const t = taskRepo();
    const [task] = loadTasks(writeTask(mkdtempSync(join(tmpdir(), "tasks-")), t));
    const r = await evalOne(task!, profile("a"), 1, deps({ a: bugFixedInRound2 }, [], { sandbox: realSandbox }));
    expect(r).toMatchObject({ result: "done", hidden_pass: true, rounds: 2, real_findings: 1 });
  });

  it("task schema rejects escaping hidden paths and short shas", () => {
    const ok = { id: "x", license: "MIT", source: "s", repo: "https://example.com/r.git", base: "a".repeat(40), task: "t", hidden: { from_commit: "b".repeat(40), paths: ["t.py"], check: "pytest" } };
    expect(EvalTaskSchema.safeParse(ok).success).toBe(true);
    expect(EvalTaskSchema.safeParse({ ...ok, base: "abc123" }).success).toBe(false);
    expect(EvalTaskSchema.safeParse({ ...ok, hidden: { ...ok.hidden, paths: ["../x"] } }).success).toBe(false);
    expect(EvalTaskSchema.safeParse({ ...ok, hidden: { ...ok.hidden, paths: ["/etc/passwd"] } }).success).toBe(false);
  });

  it("an experiment variant is layered on its base: models, prompts and flags", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const base: LoadedEvalProfile = { name: "b", source: "b.yaml", data: { roles: { pr_writer: [{ model: "openai/gpt-6-luna" }] }, flags: { lane: "fast" } }, prompts: { implement: "BASE", plan: "BASE-PLAN" } };
    const v = layerOn({ name: "v", source: "v.yaml", data: { roles: { review_plan: [{ model: "openai/gpt-6-luna" }] }, flags: { plan_effort: "high" } }, prompts: { implement: "VAR" } }, base);
    expect(v.name).toBe("v");
    expect(v.prompts).toEqual({ implement: "VAR", plan: "BASE-PLAN" });
    expect(v.data.flags).toEqual({ lane: "fast", plan_effort: "high" });
    const p = resolveEvalProfile(v, home);
    expect(p.roles.pr_writer[0]!.model).toBe("openai/gpt-6-luna");
    expect(p.roles.review_plan[0]!.model).toBe("openai/gpt-6-luna");
  });
});
