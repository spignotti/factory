import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResultSchema } from "../../src/events.js";
import { runScenario, type ScenarioRun, SECRET } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const eventsOf = (r: ScenarioRun, type: string) => r.events.filter((e) => e.event === type);

describe("E2E with fake-runner on a fixture repo", () => {
  it("clean pass: PR assembled, human_review by default", async () => {
    const r = await runScenario({ script: "clean.json" });
    expect(r.result).toMatchObject({ result: "done", type: "feature", lane: "standard", risk: "low", merge_policy: "human_review", rounds: 1 });
    expect(r.resultFile).toEqual(r.result);
    expect(ResultSchema.parse(r.resultFile).pr).toBe("https://github.test/pr/1");
    expect(r.runner.remaining()).toEqual({});

    const pr = r.github.prs[0]!;
    expect(pr.draft).toBe(false);
    expect(pr.base).toBe("main");
    expect(pr.head).toMatch(/^factory\/task-add-a-multiply-function/);
    expect(r.github.pushes).toEqual([pr.head]);
    expect(r.github.autoMerged).toEqual([]);
    expect(pr.body).toContain("Adds multiply(a, b)");
    expect(pr.body).toContain("| [x] | A1 | multiply(2, 3) returns 6 | test | test: `test/multiply.test.js::multiply` |");
    expect(pr.body).toContain("merge policy: **human_review**");
    expect(pr.body).toMatch(/✅ unit/);
    expect(r.file("pr.md")).toBe(pr.body);

    // factory commits on the branch, as git.author
    const log = git(r.repo, "log", "--format=%an|%s", pr.head);
    expect(log.split("\n")[0]).toBe("factory-bot|feat(P1): multiply");

    // run dir artifacts
    for (const f of ["plan.json", "handoff-P1.json", "gates-1.json", "review-1-plan.json", "review-1-simplicity.json", "merged-1.json", "diff-1.patch"]) {
      expect(() => r.file(f)).not.toThrow();
    }

    // events: SPEC fields and lifecycle
    for (const e of r.events) {
      expect(Object.keys(e).sort()).toEqual(["cost_usd", "data", "event", "model", "role", "run_id", "step", "tokens_in", "tokens_out", "ts"]);
      expect(e.run_id).toBe(r.result.run_id);
    }
    const kinds = new Set(r.events.map((e) => e.event));
    for (const k of ["step_started", "step_finished", "gate_result", "round_finished", "agent_finished", "run_finished"]) expect(kinds).toContain(k);
    expect(r.events.at(-1)).toMatchObject({ event: "run_finished", data: { result: "done" } });
    expect(eventsOf(r, "agent_finished").find((e) => e.role === "implement")).toMatchObject({ tokens_in: 1000, tokens_out: 200 });
    expect(r.result.cost_usd).toBeCloseTo(0.012, 6);
  });

  it("agents get the allowlisted env and an isolated HOME; no env values in events or result", async () => {
    const r = await runScenario({ script: "clean.json" });
    for (const call of r.runner.calls) {
      expect(call.env).not.toHaveProperty("FOO_TOKEN");
      expect(call.env).not.toHaveProperty("GH_TOKEN");
      expect(call.env.HOME).toBe(join(r.runDir, "home"));
      expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(call.env.GH_CONFIG_DIR).toBe(join(r.runDir, "home", ".config", "gh"));
    }
    expect(r.runner.calls.filter((c) => c.role.startsWith("review_")).every((c) => c.tools === "read_only")).toBe(true);
    expect(r.runner.calls.find((c) => c.role === "implement")?.tools).toBe("coding");
    expect(r.eventsText).not.toContain(SECRET);
    expect(JSON.stringify(r.resultFile)).not.toContain(SECRET);
    expect(r.file("pr.md")).not.toContain(SECRET);
  });

  it("secret values that reach agent output are redacted from artifacts, PR body and result", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) =>
        steps.map((s) => {
          if (s.role === "implement") {
            const out = s.output as { done: string[]; uncertain: string[] };
            const writes = { ...s.writes, "src/leak.js": `export const k = "${SECRET}";\n` };
            return { ...s, writes, output: { ...out, done: [...out.done, `used ${SECRET}`], uncertain: [`is ${SECRET} ok?`] } };
          }
          if (s.role === "pr_writer") return { ...s, raw: `Adds multiply. Token: ${SECRET}` };
          return s;
        }),
    });
    expect(r.result.result).toBe("done");
    for (const f of ["handoff-P1.json", "pr.md", "diff-1.patch", "result.json", "events.jsonl"]) expect(r.file(f)).not.toContain(SECRET);
    expect(r.file("pr.md")).toContain("uncertain (P1): is [redacted] ok?");
    expect(r.github.prs[0]!.body).not.toContain(SECRET);
    expect(r.github.prs[0]!.body).toContain("Token: [redacted]");
  });

  it("gate failure then fix: failure tail goes back into the same session", async () => {
    const r = await runScenario({ script: "gate-fail-fix.json" });
    expect(r.result.result).toBe("done");
    const impl = r.runner.calls.filter((c) => c.role === "implement");
    expect(impl).toHaveLength(2);
    expect(impl[1]?.sessionKey).toBe(impl[0]?.sessionKey);
    expect(impl[1]?.prompt).toContain("Gates are red");
    expect(impl[1]?.prompt).toContain("syntax");
    const gate1 = JSON.parse(r.file("gates-1.json"));
    expect(gate1.green).toBe(false);
    expect(gate1.checks.find((c: { name: string }) => c.name === "syntax").status).toBe("fail");
    expect(JSON.parse(r.file("gates-2.json")).green).toBe(true);
    expect(eventsOf(r, "gate_result").some((e) => e.data.status === "fail")).toBe(true);
  });

  it("accepted wontfix: done after round 2", async () => {
    const r = await runScenario({ script: "wontfix.json" });
    expect(r.result).toMatchObject({ result: "done", rounds: 2 });
    const fix = r.runner.calls.filter((c) => c.role === "implement")[1]!;
    expect(fix.prompt).toContain("R1-plan-1");
    const round2 = r.runner.calls.filter((c) => c.role === "review_plan")[1]!;
    expect(round2.prompt).toContain("callers already pass numbers");
    expect(round2.sessionKey).toBe(r.runner.calls.find((c) => c.role === "review_plan")?.sessionKey);
    const merged = JSON.parse(r.file("merged-2.json"));
    expect(merged.findings[0]).toMatchObject({ id: "R1-plan-1", status: "accepted_wontfix" });
    expect(r.github.prs[0]?.draft).toBe(false);
  });

  it("stalemate: rejected wontfix -> needs_human, draft PR, human_review", async () => {
    const r = await runScenario({ script: "stalemate.json", patch: (c) => void (c.merge = { auto_merge_max_risk: "medium" }) });
    expect(r.result).toMatchObject({ result: "needs_human", merge_policy: "human_review", rounds: 2 });
    expect(r.result.reason).toMatch(/stalemate/);
    expect(r.github.prs[0]?.draft).toBe(true);
    expect(r.github.prs[0]?.body).toContain("Blockers (needs_human)");
    expect(r.github.autoMerged).toEqual([]);
  });

  it("bug at max rounds: one extra round, then needs_human", async () => {
    const r = await runScenario({ script: "bug-max-rounds.json" });
    expect(r.result).toMatchObject({ result: "needs_human", rounds: 3 });
    const decisions = eventsOf(r, "round_finished").map((e) => (e.data.decision as { rule: number }).rule);
    expect(decisions).toEqual([6, 4, 5]);
    expect(r.runner.remaining()).toEqual({});
  });

  it("fallback: capacity error -> backoff retry on the same model -> fallback", async () => {
    const r = await runScenario({ script: "fallback.json" });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.filter((c) => c.role === "plan_high").map((c) => c.model)).toEqual([
      "openai/sol", "openai/sol", "openai/sol", "opencode-go/grok-4.7",
    ]);
    expect(r.slept).toEqual([1000, 2000]);
    expect(eventsOf(r, "model_retry")).toHaveLength(2);
    expect(eventsOf(r, "model_fallback")[0]).toMatchObject({ data: { from: "openai/sol", to: "opencode-go/grok-4.7", class: "capacity" } });
    expect(eventsOf(r, "agent_error")[0]).toMatchObject({ tokens_in: 300, cost_usd: 0.003 });
  });

  it("invalid handoff: one re-prompt, then the package fails -> needs_human", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/P1 failed: invalid handoff/);
    const impl = r.runner.calls.filter((c) => c.role === "implement");
    expect(impl).toHaveLength(2);
    expect(impl[1]?.prompt).toContain("Your handoff was invalid");
    expect(impl[1]?.prompt).toContain('{"package":"P1"');
    expect(git(join(r.runDir, "worktree"), "status", "--porcelain")).toBe("");
    // all work was discarded, so there is nothing to open a PR for
    expect(r.github.prs).toEqual([]);
    expect(r.result.reason).toContain("no commits, no PR");
  });

  it("base_red: fast checks red on base stop the run before implement", async () => {
    const r = await runScenario({
      script: "base-red.json",
      patch: (c) => void (c.checks as unknown[]).push({ name: "broken", run: "false", tier: "fast" }),
    });
    expect(r.result).toMatchObject({ result: "base_red", pr: null });
    expect(r.result.reason).toContain("broken");
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
  });

  it.each(["red", "pending"] as const)("base_red: %s CI status on base", async (status) => {
    const r = await runScenario({ script: "base-red.json", github: (gh) => void (gh.status = status) });
    expect(r.result.result).toBe("base_red");
    expect(eventsOf(r, "gate_result")).toEqual([]);
  });

  it("green CI status on base skips the local base check", async () => {
    const r = await runScenario({ script: "clean.json", github: (gh) => void (gh.status = "green") });
    expect(r.result.result).toBe("done");
    expect(eventsOf(r, "gate_result").some((e) => e.data.base)).toBe(false);
  });

  it("bug plans need tests.run for the red-green proof", async () => {
    const r = await runScenario({ script: "bug-plan-only.json", patch: (c) => void delete (c.tests as Record<string, unknown>).run, task: "max-bug.md" });
    expect(r.result).toMatchObject({ result: "needs_human", type: "bug" });
    expect(r.result.reason).toMatch(/tests.run is required/);
  });

  it("invented normalize content is rejected: one retry, then plan step at medium", async () => {
    const r = await runScenario({ script: "invented-normalize.json", options: { planEffort: "none" } });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.map((c) => c.role).slice(0, 3)).toEqual(["plan_normalize", "plan_normalize", "plan_medium"]);
    expect(r.runner.calls[1]?.prompt).toContain("A2: source_quote not found in task text");
    expect(JSON.parse(r.file("plan.json")).acceptance).toHaveLength(1);
  });

  it("faithful normalize output is used as the plan", async () => {
    const r = await runScenario({ script: "normalize-ok.json", options: { planEffort: "none" } });
    expect(r.result.result).toBe("done");
    expect(r.events.find((e) => e.event === "step_finished" && e.step === "intake")?.data.plan_source).toBe("plan_normalize");
  });

  it("needs_input: plan questions end the run with questions in result.json", async () => {
    const r = await runScenario({ script: "needs-input.json" });
    expect(r.result).toMatchObject({ result: "needs_input", questions: ["Should multiply accept more than two arguments?"], pr: null });
    expect(r.resultFile.questions).toEqual(r.result.questions);
  });

  it("bug flow: repro red on base and green on HEAD", async () => {
    const r = await runScenario({ script: "bug-fixed.json", task: "max-bug.md" });
    expect(r.result).toMatchObject({ result: "done", type: "bug" });
    const gates = JSON.parse(r.file("gates-1.json"));
    expect(gates.checks.find((c: { name: string }) => c.name === "red_green")).toMatchObject({ status: "pass" });
    expect(r.github.prs[0]?.title).toBe("fix: max returns the larger value");
  });

  it("bug without failing repro is rejected -> needs_input", async () => {
    const r = await runScenario({ script: "bug-no-repro.json", task: "max-bug.md" });
    expect(r.result.result).toBe("needs_input");
    expect(r.result.reason).toBe("bug without failing repro");
    expect(r.result.questions?.[0]).toMatch(/failing repro/);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(3);
    expect(r.github.prs).toEqual([]);
  });

  describe("each merge policy is reachable via config", () => {
    it("auto (auto_merge_max_risk: low, low-risk diff) enables auto-merge", async () => {
      const r = await runScenario({ script: "clean.json", patch: (c) => void (c.merge = { auto_merge_max_risk: "low" }) });
      expect(r.result).toMatchObject({ result: "done", risk: "low", merge_policy: "auto" });
      expect(r.github.autoMerged).toEqual([r.result.pr]);
    });

    it("bot_review (medium risk above auto_merge_max_risk)", async () => {
      const r = await runScenario({
        script: "clean.json",
        patch: (c) => void (c.merge = { auto_merge_max_risk: "low", low_max_diff_lines: 1, policy: { medium: "bot_review" } }),
      });
      expect(r.result).toMatchObject({ result: "done", risk: "medium", merge_policy: "bot_review" });
      expect(r.github.autoMerged).toEqual([]);
    });

    it("human_review (default config)", async () => {
      const r = await runScenario({ script: "clean.json" });
      expect(r.result.merge_policy).toBe("human_review");
    });

    it("high risk is never auto", async () => {
      const r = await runScenario({
        script: "clean.json",
        patch: (c) => {
          c.merge = { auto_merge_max_risk: "medium" };
          c.human_only_paths = ["src/math.js"];
        },
      });
      expect(r.result).toMatchObject({ risk: "high", merge_policy: "human_review" });
    });
  });

  it("a failing push ends as needs_human, not failed", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => void (gh.push = async () => Promise.reject(new Error("remote rejected"))),
    });
    expect(r.result).toMatchObject({ result: "needs_human", merge_policy: "human_review", pr: null });
    expect(r.result.reason).toMatch(/PR step failed: remote rejected/);
  });

  it("--no-pr skips push and PR", async () => {
    const r = await runScenario({ script: "clean.json", options: { noPr: true } });
    expect(r.result).toMatchObject({ result: "done", pr: null });
    expect(r.github.pushes).toEqual([]);
    expect(r.file("pr.md")).toContain("## Summary");
  });
});

describe("run guards", () => {
  it("max_wall_minutes is the outer limit -> needs_human", async () => {
    const r = await runScenario({ script: "base-red.json", patch: (c) => void ((c.limits as Record<string, unknown>).max_wall_minutes = 0.00001) });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/max_wall_minutes/);
  });
});
