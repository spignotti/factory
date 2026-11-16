import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { runScenario, type ScenarioRun } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function changedSinceMain(r: ScenarioRun): string {
  return git(join(r.runDir, "worktree"), "diff", "--name-only", "main").trim();
}

const reviews = (): FakeStep[] => [
  { role: "review_plan", output: { reviewer: "plan", prior: [], findings: [] } },
  { role: "review_simplicity", output: { reviewer: "simplicity", prior: [], findings: [] } },
  { role: "pr_writer", raw: "Docs and evidence." },
];

function planStep(plan: unknown): FakeStep {
  return { role: "plan_high", output: plan };
}

const unchanged = {
  version: 1,
  type: "feature",
  goal: "Keep sum covered by the existing test",
  context: "",
  packages: [{ id: "P1", title: "note", description: "Comment only", files: ["src/math.js"], depends_on: [], changes_flows: [] }],
  acceptance: [{ id: "A1", package: "P1", text: "sum(1, 2) returns 3", verify: "test", kind: "behavior", risk: false }],
  out_of_scope: [],
};

const math = `export function sum(a, b) {
  return a + b;
}

/** Larger of two numbers. */
export function max(a, b) {
  return a < b ? a : b;
}
`;

describe("evidence scenarios", () => {
  it("V08: an unchanged test that ran is evidence, and the test file stays out of the diff", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: () => [
        planStep(unchanged),
        {
          role: "implement",
          writes: { "src/math.js": math },
          output: {
            package: "P1",
            done: ["cited the existing sum test"],
            evidence: [{ acceptance_id: "A1", kind: "test", ref: "test/math.test.js::sum adds" }],
          },
        },
        ...reviews(),
      ],
    });
    expect(r.result.result).toBe("done");
    expect(changedSinceMain(r)).toBe("src/math.js");
    const gates = r.file("gates-1.json");
    expect(gates).toMatch(/"name": "test_presence"/);
    expect(gates).toMatch(/"name": "evidence"/);
    expect(gates).not.toMatch(/no executed test evidence/);
    const implement = r.runner.calls.find((c) => c.role === "implement");
    expect(implement?.system).toMatch(/do not add a wrapper/);
    expect(implement?.prompt).toMatch(/An unchanged test is valid evidence/);
  });

  it("V09: an invented test reference is an advisory note: the run finishes and the PR names it", async () => {
    const invented = {
      role: "implement",
      writes: { "src/math.js": math },
      output: {
        package: "P1",
        done: ["cited a test that does not exist"],
        evidence: [{ acceptance_id: "A1", kind: "test", ref: "test/does-not-exist.test.js::nope" }],
      },
    } satisfies FakeStep;
    const r = await runScenario({
      script: "clean.json",
      steps: () => [planStep(unchanged), invented, ...reviews()],
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    const gates = JSON.parse(r.file("gates-1.json"));
    expect(gates.green).toBe(true);
    expect(gates.checks.find((c: { name: string }) => c.name === "evidence")).toMatchObject({ status: "fail", advisory: true });
    expect(gates.checks.find((c: { name: string }) => c.name === "test_presence")).toMatchObject({ status: "fail", advisory: true });
    const body = r.github.prs[0]?.body ?? "";
    const [blocking, advisory] = body.split("Advisory gates (reported, not blocking):");
    expect(advisory).toMatch(/- 📝 evidence \(builtin, advisory, failed\): .*invented reference/);
    expect(advisory).toMatch(/- 📝 test_presence \(builtin, advisory, failed\)/);
    expect(blocking).not.toMatch(/evidence \(builtin/);
    expect(blocking).not.toContain("❌");
    // The invented reference is no evidence: the criterion stays unchecked.
    expect(body).toContain("| [ ] | A1 | sum(1, 2) returns 3 | test | — |");
    expect(body).toContain("Unverified criteria: A1");
  });

  it("an invented reference on a bundle row does not close the partner issue", async () => {
    const plan = { ...unchanged, acceptance: [{ ...unchanged.acceptance[0]!, text: "sum(1, 2) returns 3; fulfills #8" }] };
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 5, bundle: [8] },
      github: (gh) => {
        gh.issues.set(5, { number: 5, title: "Sum", body: "Keep sum covered.\nfactory-bundle: #8", labels: ["factory-ready"] });
      },
      steps: () => [
        planStep(plan),
        {
          role: "implement",
          writes: { "src/math.js": math },
          output: { package: "P1", done: ["cited a test that does not exist"], evidence: [{ acceptance_id: "A1", kind: "test", ref: "test/does-not-exist.test.js::nope" }] },
        },
        ...reviews(),
      ],
    });
    expect(r.result.result).toBe("done");
    const body = r.github.prs[0]?.body ?? "";
    expect(body).toContain("Closes #5");
    expect(body).not.toContain("Closes #8");
    expect(body).toMatch(/\| \[ \] \| A1 \|/);
    expect(JSON.parse(r.file("fulfilled.json"))).toEqual({ issues: [] });
  });

  it("an accepted reference closes the bundle partner, and fulfills #N of a non-partner closes nothing", async () => {
    const plan = {
      ...unchanged,
      acceptance: [
        { ...unchanged.acceptance[0]!, text: "sum(1, 2) returns 3; fulfills #8" },
        { id: "A2", package: "P1", text: "sum stays exported; fulfills #9", verify: "review", kind: "behavior", risk: false },
      ],
    };
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 5, bundle: [8] },
      github: (gh) => {
        gh.issues.set(5, { number: 5, title: "Sum", body: "Keep sum covered.\nfactory-bundle: #8", labels: ["factory-ready"] });
      },
      steps: () => [
        planStep(plan),
        {
          role: "implement",
          writes: { "src/math.js": math },
          output: { package: "P1", done: ["cited the existing sum test"], evidence: [{ acceptance_id: "A1", kind: "test", ref: "test/math.test.js::sum adds" }] },
        },
        ...reviews(),
      ],
    });
    expect(r.result.result).toBe("done");
    const body = r.github.prs[0]?.body ?? "";
    expect(body).toContain("Closes #5\nCloses #8");
    expect(body).not.toContain("Closes #9");
    expect(JSON.parse(r.file("fulfilled.json"))).toEqual({ issues: [8] });
    expect(JSON.parse(r.file("state.json")).task.bundle).toEqual([8]);
  });

  it("V10: a documentation change finishes with review and without a new test", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: () => [
        planStep({
          version: 1,
          type: "chore",
          goal: "Correct the docs",
          context: "",
          packages: [{ id: "P1", title: "docs", description: "Wording", files: ["docs/index.md"], depends_on: [], changes_flows: [] }],
          acceptance: [{ id: "A1", package: "P1", text: "the docs name the command", verify: "review", kind: "behavior", risk: false }],
          out_of_scope: ["No new sentence tests"],
        }),
        {
          role: "implement",
          writes: { "docs/index.md": "# Widget\n\nRun `node --test`.\n" },
          output: { package: "P1", done: ["rewrote the intro"], evidence: [] },
        },
        ...reviews(),
      ],
    });
    expect(r.result.result).toBe("done");
    expect(changedSinceMain(r)).toBe("docs/index.md");
    expect(r.runner.calls.some((c) => c.role === "review_plan")).toBe(true);
    const review = r.runner.calls.find((c) => c.role === "review_plan");
    expect(review?.system).toMatch(/do not need sentence, screenshot, or test-name tests/);
    expect(r.file("gates-1.json")).not.toMatch(/no executed test evidence/);
  });
});
