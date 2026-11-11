import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { acquireRepoLock, repoLockHolder, repoLockPath, waitForRepoLock } from "../../src/pipeline/lock.js";
import { validateResponses } from "../../src/pipeline/loop.js";
import type { TrackedFinding } from "../../src/pipeline/merge.js";
import { HandoffSchema } from "../../src/schemas/handoff.js";
import { FakeRunner, type FakeStep } from "../../src/agents/fake-runner.js";
import { EventLog, type FactoryEvent } from "../../src/events.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { costLines } from "../../src/steps/finalize.js";
import { formatGateResults } from "../../src/steps/gates.js";
import { handoffShape, parseHandoff } from "../../src/steps/implement.js";
import { extractPlanBlock, obtainPlan, readTask, resolvePlanEffort } from "../../src/steps/intake.js";

describe("intake helpers", () => {
  it("plan effort: flag, then issue label, then high", () => {
    expect(resolvePlanEffort("none", ["factory:plan-medium"])).toBe("none");
    expect(resolvePlanEffort(undefined, ["bug", "factory:plan-medium"])).toBe("medium");
    expect(resolvePlanEffort(undefined, [])).toBe("high");
  });

  it("extracts a fenced factory-plan block", () => {
    expect(extractPlanBlock("text\n```factory-plan\n{\"version\":1}\n```\n")).toEqual({ version: 1 });
    expect(extractPlanBlock("```json\n{}\n```")).toBeUndefined();
    expect(extractPlanBlock("```factory-plan\n{bad\n```")).toBeUndefined();
  });

  it("reads tasks from issues and files", async () => {
    const gh = new FakeGitHub();
    gh.issues.set(12, { number: 12, title: "Fix max", body: "max is wrong", labels: ["factory:plan-none"] });
    expect(await readTask({ issue: 12 }, "/repo", gh)).toMatchObject({ ref: "#12", issue: 12, title: "Fix max", labels: ["factory:plan-none"] });
    const file = join(mkdtempSync(join(tmpdir(), "t-")), "task.md");
    writeFileSync(file, "\n# Do it\nbody");
    expect(await readTask({ textFile: file }, "/repo", gh)).toMatchObject({ ref: file, title: "Do it", text: "\n# Do it\nbody" });
  });
});

describe("handoff validation", () => {
  it("requires valid JSON for the expected package", () => {
    expect(parseHandoff("no json", "P1")).toMatchObject({ ok: false, errors: ["no JSON object in output"] });
    expect(parseHandoff('```json\n{"package":"P2"}\n```', "P1")).toMatchObject({ ok: false, errors: ["package must be P1"] });
    expect(parseHandoff('```json\n{"package":"P1","evidence":"x"}\n```', "P1").ok).toBe(false);
    expect(parseHandoff('```json\n{"package":"P1"}\n```', "P1").ok).toBe(true);
  });

  it("requires an answer per open finding and a reason for wontfix", () => {
    const open = [{ id: "R1-plan-1" }, { id: "R1-plan-2" }] as TrackedFinding[];
    const h = (responses: unknown[]) => HandoffSchema.parse({ package: "fix", responses });
    expect(validateResponses(h([]), open)).toEqual(["no response for R1-plan-1", "no response for R1-plan-2"]);
    expect(validateResponses(h([
      { finding_id: "R1-plan-1", status: "fixed" },
      { finding_id: "R1-plan-2", status: "wontfix", response: " " },
    ]), open)).toEqual(["wontfix for R1-plan-2 needs a reason"]);
    expect(validateResponses(h([
      { finding_id: "R1-plan-1", status: "fixed" },
      { finding_id: "R1-plan-2", status: "wontfix", response: "by design" },
    ]), open)).toEqual([]);
  });
});

describe("repo lock", () => {
  const REPO = "git@github.com:o/r.git";
  const file = (home: string) => repoLockPath(home, REPO);

  it("is exclusive per repo (any task), released, and taken over when stale", () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const release = acquireRepoLock(home, REPO, "run-a");
    expect(release).toBeTypeOf("function");
    expect(readFileSync(file(home), "utf8")).toBe(`${process.pid}\nrun-a`);
    expect(acquireRepoLock(home, REPO, "run-b")).toBeUndefined();
    expect(repoLockHolder(home, REPO)).toEqual({ pid: process.pid, runId: "run-a" });
    expect(acquireRepoLock(home, "git@github.com:o/other.git", "run-c")).toBeTypeOf("function");
    release!();
    expect(repoLockHolder(home, REPO)).toBeUndefined();
    const again = acquireRepoLock(home, REPO, "run-b");
    expect(again).toBeTypeOf("function");
    again!();
    writeFileSync(file(home), "999999999\nrun-dead");
    expect(repoLockHolder(home, REPO)).toBeUndefined();
    const taken = acquireRepoLock(home, REPO, "run-d");
    expect(taken).toBeTypeOf("function");
    expect(acquireRepoLock(home, REPO, "run-e")).toBeUndefined();
    taken!();
    // a takeover in progress (guard held by a live process) blocks a second taker
    writeFileSync(file(home), "999999999");
    writeFileSync(`${file(home)}.takeover`, String(process.pid));
    expect(acquireRepoLock(home, REPO, "run-f")).toBeUndefined();
  });

  it("is held by another live process until it exits", async () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(file(home), `${child.pid}\nrun-other`);
    expect(acquireRepoLock(home, REPO, "me")).toBeUndefined();
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    const release = acquireRepoLock(home, REPO, "me");
    expect(release).toBeTypeOf("function");
    release!();
  });

  it("waitForRepoLock queues until released and stops on abort", async () => {
    const home = mkdtempSync(join(tmpdir(), "lock-"));
    const held = acquireRepoLock(home, REPO, "run-a")!;
    setTimeout(held, 80);
    const release = await waitForRepoLock(home, REPO, "run-b", { pollMs: 10 });
    expect(repoLockHolder(home, REPO)?.runId).toBe("run-b");
    const controller = new AbortController();
    const waiting = waitForRepoLock(home, REPO, "run-c", { pollMs: 10, signal: controller.signal });
    controller.abort(new Error("interrupted by SIGINT"));
    await expect(waiting).rejects.toThrow("interrupted by SIGINT");
    release();
  });
});

describe("PR cost lines", () => {
  const u = (model: string, billing: "subscription" | "metered", cost_usd: number) => ({ role: "implement", model, calls: 1, errors: 0, tokens_in: 10, tokens_out: 2, cost_usd, billing });
  it("subscriptions show tokens, metered providers USD, both when mixed", () => {
    expect(costLines([u("opencode-go/a", "subscription", 0)])).toEqual(["- subscription tokens: 10 in / 2 out"]);
    expect(costLines([u("anthropic/a", "metered", 0.5)])).toEqual(["- cost (metered providers): $0.5000"]);
    expect(costLines([u("opencode-go/a", "subscription", 0), u("anthropic/a", "metered", 0.25)])).toEqual([
      "- subscription tokens: 10 in / 2 out",
      "- cost (metered providers): $0.2500",
    ]);
    expect(costLines([])).toEqual(["- cost (metered providers): $0.0000"]);
  });
});

const MULTIPLY = "# Add a multiply function\n\nAdd a multiply function to src/math.js.\nmultiply(2, 3) returns 6.\n";

const schemaInvalid = {
  version: 1,
  type: "feature",
  goal: "Add a multiply function",
  packages: [{ title: "multiply", files: ["src/math.js"] }],
  acceptance: ["multiply(2, 3) returns 6"],
};

const faithful = {
  version: 1,
  type: "feature",
  goal: "Add a multiply function",
  context: "",
  packages: [{ id: "P1", title: "multiply", files: ["src/math.js"], source_quote: "Add a multiply function to src/math.js." }],
  acceptance: [{ id: "A1", package: "P1", text: "multiply(2, 3) returns 6", verify: "test", kind: "behavior", source_quote: "multiply(2, 3) returns 6." }],
  out_of_scope: [],
};

function intake(steps: FakeStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "intake-"));
  const events = new EventLog(dir, "r");
  const seen: FactoryEvent[] = [];
  events.onEvent((e) => seen.push(e));
  const runner = new FakeRunner(steps);
  const ctx = {
    deps: {
      runner,
      github: new FakeGitHub(),
      profile: loadProfile(join(import.meta.dirname, "../fixtures/profile.yaml")),
      factoryHome: dir,
      parentEnv: { PATH: process.env.PATH ?? "" },
      sleep: async () => {},
      now: () => Date.now(),
      watchdogPollMs: 60_000,
    },
    repo: parseRepoConfig(""),
    agentHome: dir,
    events,
    task: { ref: "t", title: "Add a multiply function", text: MULTIPLY, labels: [] as string[] },
    repoDir: dir,
    deadline: { at: Date.now() + 3_600_000 },
  };
  return { ctx, runner, seen };
}

describe("plan_normalize schema retry", () => {
  it("feeds zod errors back once and records both attempts", async () => {
    const { ctx, runner, seen } = intake([
      { role: "plan_normalize", output: schemaInvalid },
      { role: "plan_normalize", output: faithful },
    ]);
    const out = await obtainPlan(ctx, "none");
    expect(out.kind).toBe("plan");
    expect(runner.calls.map((c) => c.role)).toEqual(["plan_normalize", "plan_normalize"]);
    expect(runner.calls[0]?.prompt).not.toContain("JSON schema for the failing fields:");
    expect(runner.calls[0]?.prompt).toContain("plan schema shape");
    expect(runner.calls[1]?.prompt).toMatch(/acceptance\.0:.*expected object, received string/);
    expect(runner.calls[1]?.prompt).toContain("Return only one ```json block and no other text.");
    expect(runner.calls[1]?.prompt).toContain("acceptance[]:");
    expect(runner.calls[1]?.prompt).toContain('"verify"');
    const attempts = seen.filter((e) => e.role === "plan_normalize" && e.data.attempts).map((e) => e.data.attempts);
    expect(attempts.at(-1)).toEqual([
      expect.objectContaining({ n: 1, ok: false, errors: expect.arrayContaining([expect.stringMatching(/acceptance\.0:.*expected object, received string/)]) }),
      { n: 2, ok: true },
    ]);
  });

  it("falls back to the planner only after the retry is also invalid, and the event lists both failures", async () => {
    const { ctx, runner, seen } = intake([
      { role: "plan_normalize", output: schemaInvalid },
      { role: "plan_normalize", output: schemaInvalid },
      { role: "plan_medium", output: faithful },
    ]);
    execFileSync("git", ["init", "-q"], { cwd: ctx.repoDir });
    const out = await obtainPlan(ctx, "none");
    expect(out).toMatchObject({ kind: "plan", source: "plan_medium" });
    expect(runner.calls.map((c) => c.role)).toEqual(["plan_normalize", "plan_normalize", "plan_medium"]);
    const last = seen.filter((e) => Array.isArray(e.data.attempts)).at(-1);
    expect(last?.data.attempts).toEqual([
      expect.objectContaining({ n: 1, ok: false }),
      expect.objectContaining({ n: 2, ok: false }),
    ]);
  });
});

describe("gate result lines", () => {
  const row = (name: string, output_tail: string) => ({ name, kind: "builtin" as const, status: "pass" as const, duration_ms: 0, output_tail });

  it("shows a red_green exemption and leaves an ordinary proof detail off the line", () => {
    expect(formatGateResults([
      row("red_green", "EXEMPT not_applicable (loosening): stabilizing a flaky test"),
      row("config_guard", "loosening: red_green not_applicable — stabilizing a flaky test"),
    ])).toBe([
      "- ✅ red_green (builtin): EXEMPT not_applicable (loosening): stabilizing a flaky test",
      "- ✅ config_guard (builtin): loosening: red_green not_applicable — stabilizing a flaky test",
    ].join("\n"));
    expect(formatGateResults([row("red_green", "repro fails on base\nrepro passes on HEAD")])).toBe("- ✅ red_green (builtin)");
  });
});

describe("handoff shape", () => {
  it("names the check refs the gates accept", () => {
    const repo = (names: string[]) => ({ repo: { checks: names.map((name) => ({ name })) } }) as unknown as Parameters<typeof handoffShape>[0];
    const shape = handoffShape(repo(["typecheck", "lint"]), "P1");
    expect(shape).toContain('"package":"P1"');
    expect(shape).toContain("exactly one of these check names: typecheck, lint");
    expect(handoffShape(repo([]), "fix")).toContain("kind:test evidence only");
  });
});
