import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResultSchema } from "../../src/events.js";
import { Interrupted } from "../../src/interrupt.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { canonicalRepoId, flushMemory, loadMemory } from "../../src/memory.js";
import type { AgentRequest } from "../../src/agents/runner.js";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { createSandbox, hostProbe, type Sandbox } from "../../src/sandbox/sandbox.js";
import { addOrigin, commitFile } from "../helpers/repo.js";
import { runScenario, type ScenarioRun, SECRET } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const eventsOf = (r: ScenarioRun, type: string) => r.events.filter((e) => e.event === type);

/** Standard script → fast lane: `plan_normalize` instead of the planner, plan + simplicity in one lean review. */
function toFastLane(steps: FakeStep[]): FakeStep[] {
  const out: FakeStep[] = [];
  for (const step of steps) {
    if (step.role === "plan_high") out.push({ ...step, role: "plan_normalize" });
    else if (step.role === "review_simplicity") {
      const plan = out.findLast((s) => s.role === "review_plan")!;
      plan.output = { reviews: [plan.output, step.output] };
    } else out.push({ ...step });
  }
  return out;
}

describe("E2E with fake-runner on a fixture repo", () => {
  it("planner and plan_normalize read a clean base worktree, never the user's checkout (untracked .env)", async () => {
    const seen: { role: string; cwd: string; env: boolean; listed: boolean; agents: string; pasted: boolean }[] = [];
    const record = (req: AgentRequest, repo: string) => {
      if (!req.role.startsWith("plan")) return;
      expect(req.cwd).not.toBe(repo);
      const agents = readFileSync(join(req.cwd, "AGENTS.md"), "utf8");
      seen.push({ role: req.role, cwd: req.cwd, env: existsSync(join(req.cwd, ".env")), listed: req.prompt.includes(".env"), agents, pasted: req.prompt.includes("BASE RULE") });
    };
    const setup = (repo: string) => {
      // AGENTS.md at the base SHA reaches the agent as session context (the worktree's file), not
      // pasted into the prompt; an uncommitted edit in the checkout does not reach it at all.
      commitFile(repo, "AGENTS.md", "BASE RULE\n", "agents");
      writeFileSync(join(repo, "AGENTS.md"), "UNCOMMITTED RULE\n");
      writeFileSync(join(repo, ".env"), `SECRET=${SECRET}\n`);
    };
    const std = await runScenario({ script: "clean.json", setup, onCall: record });
    const norm = await runScenario({ script: "normalize-ok.json", options: { planEffort: "none" }, setup, onCall: record });
    expect(std.result.result).toBe("done");
    expect(norm.result.result).toBe("done");
    expect(seen.map((s) => s.role)).toEqual(["plan_high", "plan_normalize"]);
    for (const s of seen) expect(s).toMatchObject({ env: false, listed: false, agents: "BASE RULE\n", pasted: false });
    // removed again, and not registered as a worktree any more
    expect(existsSync(seen[0]!.cwd)).toBe(false);
    expect(git(std.repo, "worktree", "list")).not.toContain("plan-base");
  });

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
    expect(pr.body).toMatch(/- implement: `opencode-go\/deepseek-v4.1-flash` ×1, 1000\/200, subscription/);
    expect(pr.body).toMatch(/- subscription tokens: \d+ in \/ \d+ out/);
    expect(pr.body).not.toMatch(/- cost \(metered providers\)/);
    expect(pr.body).toMatch(/- review_plan: `openai\/[\w.-]+` ×1/);
    expect(r.file("pr.md")).toBe(pr.body);

    // factory commits on the branch, as git.author
    const log = git(r.repo, "log", "--format=%an|%s", pr.head);
    expect(log.split("\n")[0]).toBe("factory-bot|feat(P1): multiply");

    // run dir artifacts
    for (const f of ["plan.json", "handoff-P1.json", "gates-1.json", "review-1-plan.json", "review-1-simplicity.json", "merged-1.json", "diff-1.patch"]) {
      expect(() => r.file(f)).not.toThrow();
    }

    // events: required fields and lifecycle
    for (const e of r.events) {
      expect(Object.keys(e).sort()).toEqual(["cost_usd", "data", "event", "model", "role", "run_id", "step", "tokens_in", "tokens_out", "ts"]);
      expect(e.run_id).toBe(r.result.run_id);
    }
    const kinds = new Set(r.events.map((e) => e.event));
    for (const k of ["step_started", "step_finished", "gate_result", "round_finished", "agent_finished", "run_finished"]) expect(kinds).toContain(k);
    expect(r.events.at(-1)).toMatchObject({ event: "run_finished", data: { result: "done" } });
    expect(eventsOf(r, "agent_finished").find((e) => e.role === "implement")).toMatchObject({ tokens_in: 1000, tokens_out: 200 });
    // result.json cost_usd counts metered providers only; these fake models are subscriptions
    expect(r.result.cost_usd).toBe(0);
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

  it("repo.yaml models: override a role for this repo; a merged config that breaks a safety rule fails at intake", async () => {
    const r = await runScenario({ script: "clean.json", patch: (c) => void (c.models = { pr_writer: [{ model: "opencode-go/grok-4.7" }] }) });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.find((c) => c.role === "pr_writer")?.model).toBe("opencode-go/grok-4.7");
    expect(r.runner.calls.find((c) => c.role === "implement")?.model).toBe("opencode-go/deepseek-v4.1-flash");

    const bad = await runScenario({ script: "clean.json", patch: (c) => void (c.models = { review_plan: [{ model: "opencode-go/deepseek-v4-pro" }] }) });
    expect(bad.result.result).toBe("failed");
    expect(bad.result.reason).toMatch(/review_plan from repo layer/);
    expect(bad.runner.calls).toEqual([]);
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

  it("a branch name taken on the remote gets the run id suffix; result.json says where the work is", async () => {
    const r = await runScenario({ script: "clean.json", setup: (repo) => void addOrigin(repo, ["factory/task-add-a-multiply-function"]) });
    expect(r.result.result).toBe("done");
    const head = r.github.prs[0]!.head;
    expect(head).toBe(`factory/task-add-a-multiply-function-${r.result.run_id.slice(-6)}`);
    expect(r.resultFile).toMatchObject({ branch: head, worktree: join(r.runDir, "worktree"), run_dir: r.runDir });
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

  it("an added lint suppression the plan does not name fails the gates and goes back to the implementer", async () => {
    let first = true;
    const r = await runScenario({
      script: "gate-fail-fix.json",
      steps: (s) =>
        s.map((x) => {
          if (x.role !== "implement" || !first || !x.writes) return x;
          first = false;
          const fixed = s.filter((y) => y.role === "implement")[1]!.writes!["src/math.js"]!;
          return { ...x, writes: { ...x.writes, "src/math.js": `// eslint-disable-next-line no-unused-vars
${fixed}` } };
        }),
    });
    expect(r.result.result).toBe("done");
    const gate1 = JSON.parse(r.file("gates-1.json"));
    const guard = gate1.checks.find((c: { name: string }) => c.name === "config_guard");
    expect(guard.status).toBe("fail");
    expect(guard.output_tail).toContain("src/math.js: adds `eslint-disable`");
    expect(r.runner.calls.filter((c) => c.role === "implement")[1]!.prompt).toContain("config_guard");
    expect(JSON.parse(r.file("gates-2.json")).green).toBe(true);
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

  it("findings memory: open findings at exit are remembered; the next run briefs implement and review", async () => {
    const first = await runScenario({ script: "bug-max-rounds.json" });
    const mem = loadMemory(first.factoryHome, canonicalRepoId("", first.repo));
    expect(mem.entries.length).toBeGreaterThan(0);
    expect(mem.entries.every((e) => e.status === "open" && e.count === 1 && e.runs[0] === first.runId)).toBe(true);
    expect(eventsOf(first, "progress").some((e) => (e.data.memory as { observations: number } | undefined)?.observations === mem.entries.length)).toBe(true);
    expect(first.github.prs[0]?.body).not.toContain("Recurring");

    const text = mem.entries[0]!.text;
    const second = await runScenario({
      script: "clean.json",
      before: (repo, factoryHome) =>
        void flushMemory({ factoryHome, repoId: canonicalRepoId("", repo), runId: "old", now: new Date(), observations: mem.entries.map((e) => ({ ...e })) }),
    });
    expect(second.result.result).toBe("done");
    expect(second.runner.calls.find((c) => c.role === "implement")?.prompt).toContain(text);
    expect(second.runner.calls.filter((c) => c.role.startsWith("review_")).every((c) => c.prompt.includes(text))).toBe(true);
    expect(second.runner.calls.find((c) => c.role === "pr_writer")?.prompt ?? "").not.toContain(text);
    expect(second.github.prs[0]?.body).not.toContain(text);
  });

  it("security and checklist reviewers join when the diff touches sensitive paths and unmarked checklist items exist", async () => {
    const checklist = "- Every exported function has a test\n- No TODO comments <!-- check: lint -->\n";
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => commitFile(repo, ".factory/checklist.md", checklist),
      steps: (steps) => {
        // Not in the plan (a sensitive plan file needs a risk criterion): the diff decides, not the plan.
        steps[1]!.writes = { ...steps[1]!.writes, "src/auth/session.js": "export const ttl = 60;\n" };
        return [
          ...steps,
          { role: "review_security", output: { reviewer: "security", prior: [], findings: [] } },
          { role: "review_checklist", output: { reviewer: "checklist", prior: [], findings: [] } },
        ];
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.remaining()).toEqual({});
    expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data.reviewers).toEqual(["plan", "simplicity", "security", "checklist"]);
    const prompt = (role: string) => r.runner.calls.find((c) => c.role === role)?.prompt ?? "";
    expect(prompt("review_security")).toMatch(/security_trigger_files[\s\S]*src\/auth\/session\.js/);
    expect(prompt("review_checklist")).toContain("C1 (checklist.md:1): Every exported function has a test");
    expect(prompt("review_checklist")).not.toContain("No TODO comments");
    expect(prompt("review_plan")).not.toContain("checklist_items");
    expect(prompt("plan_high")).toMatch(/checklist_items[\s\S]*Every exported function has a test/);
    expect(prompt("plan_high")).not.toContain("No TODO comments");
  });

  it("no security reviewer for ordinary files; no checklist reviewer when review.checklist is off or all items are marked", async () => {
    const off = await runScenario({
      script: "clean.json",
      patch: (c) => void ((c.review as Record<string, unknown>).checklist = false),
      setup: (repo) => commitFile(repo, ".factory/checklist.md", "- Every exported function has a test\n"),
    });
    const marked = await runScenario({ script: "clean.json", setup: (repo) => commitFile(repo, ".factory/checklist.md", "- Tests pass <!-- check: unit -->\n") });
    for (const r of [off, marked]) {
      expect(r.result.result).toBe("done");
      expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data.reviewers).toEqual(["plan", "simplicity"]);
    }
  });

  it("a dependency file anywhere activates security", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => {
        (steps[0]!.output as { packages: { files: string[] }[] }).packages[0]!.files.push("tools/package.json");
        steps[1]!.writes = { ...steps[1]!.writes, "tools/package.json": "{\"name\":\"tools\"}\n" };
        return [...steps, { role: "review_security", output: { reviewer: "security", prior: [], findings: [] } }];
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.find((c) => c.role === "review_security")?.prompt).toContain("tools/package.json");
  });

  it("fast lane: plan_normalize, one lean review session, PR says fast", async () => {
    const r = await runScenario({ script: "clean.json", options: { lane: "fast" }, steps: toFastLane });
    expect(r.result).toMatchObject({ result: "done", lane: "fast", rounds: 1 });
    expect(r.runner.remaining()).toEqual({});
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_normalize", "implement", "review_plan", "pr_writer"]);
    const review = r.runner.calls.find((c) => c.role === "review_plan")!;
    expect(review.prompt).toContain('{"reviews":[<plan review>,<simplicity review>]}');
    expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data).toMatchObject({ mode: "lean", reviewers: ["plan", "simplicity"] });
    expect(r.file("review-1-plan.json")).toContain('"reviewer": "plan"');
    expect(r.file("review-1-simplicity.json")).toContain('"reviewer": "simplicity"');
    expect(r.github.prs[0]?.body).toContain("- lane: fast (lean review, at most one fix round)");
    expect(eventsOf(r, "lane_escalated")).toEqual([]);
  });

  it("fast lane: an open bug after the one fix round -> needs_human, no extra round", async () => {
    const r = await runScenario({ script: "bug-max-rounds.json", options: { lane: "fast" }, steps: (s) => {
      // Two review rounds and one fix: the script's third round must never be asked for.
      const seen: Record<string, number> = {};
      return toFastLane(s).filter((x) => !["review_plan", "implement"].includes(x.role) || (seen[x.role] = (seen[x.role] ?? 0) + 1) <= 2);
    } });
    expect(r.result).toMatchObject({ result: "needs_human", lane: "fast", rounds: 2 });
    expect(r.result.reason).toMatch(/no extra round/);
    expect(r.runner.remaining()).toEqual({});
  });

  it("fast lane escalates after implement when the diff is too big: full review, medium risk, PR names the reasons", async () => {
    const r = await runScenario({ script: "clean.json", options: { lane: "fast" }, patch: (c) => void (c.fast_lane = { max_diff_lines: 3 }), steps: (s) => s.map((x) => (x.role === "plan_high" ? { ...x, role: "plan_normalize" } : x)) });
    expect(r.result).toMatchObject({ result: "done", lane: "standard", risk: "medium" });
    expect(r.runner.remaining()).toEqual({});
    const esc = eventsOf(r, "lane_escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ step: "implement", data: { from: "fast", to: "standard" } });
    expect((esc[0]!.data.reasons as string[])[0]).toMatch(/^diff \d+ lines > fast_lane.max_diff_lines 3$/);
    expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data).toMatchObject({ mode: "full" });
    expect(r.github.prs[0]?.body).toMatch(/- lane: fast → standard \(diff \d+ lines/);
    expect(r.github.prs[0]?.body).toContain("fast-lane escalation");
    expect(JSON.parse(r.file("state.json"))).toMatchObject({ lane: "standard" });
  });

  it("fast lane: invalid plan_normalize output escalates at intake to the plan step", async () => {
    const r = await runScenario({ script: "invented-normalize.json", options: { lane: "fast" } });
    expect(r.result).toMatchObject({ result: "done", lane: "standard" });
    expect(r.runner.remaining()).toEqual({});
    expect(eventsOf(r, "lane_escalated")[0]).toMatchObject({ step: "intake" });
    expect((eventsOf(r, "lane_escalated")[0]!.data.reasons as string[])[0]).toMatch(/^plan_normalize output invalid/);
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
    expect(eventsOf(r, "agent_error")[0]).toMatchObject({ tokens_in: 300, cost_usd: 0, data: { billing: "subscription" } });
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

describe("base moved before finalize", () => {
  /** Commits on main of the fixture repo once, when the first reviewer starts (after implement). */
  const moveBaseOnReview = (path: string, content: string) => {
    let moved = false;
    return (req: { role: string }, repo: string) => {
      if (moved || !req.role.startsWith("review_")) return;
      moved = true;
      commitFile(repo, path, content, "main moved");
    };
  };

  it("clean merge: base merged into the branch as git.author (no rebase), full gates re-run, done", async () => {
    const r = await runScenario({ script: "clean.json", onCall: moveBaseOnReview("src/other.js", "export const other = 1;\n") });
    expect(r.result).toMatchObject({ result: "done" });
    const head = r.github.prs[0]!.head;
    const [subject, parents, author] = git(r.repo, "log", "-1", "--format=%s|%P|%an", head).trim().split("|");
    expect(subject).toBe(`chore: merge main into ${head}`);
    expect(parents!.split(" ")).toHaveLength(2);
    expect(author).toBe("factory-bot");
    // the implement commit is still there unchanged (no rewrite → plain push is enough)
    expect(git(r.repo, "log", "--format=%s", head)).toContain("feat(P1): multiply");
    expect(git(r.repo, "merge-base", "--is-ancestor", "main", head)).toBe("");
    const baseMoved = r.events.filter((e) => e.event === "progress" && e.data.base_moved).length;
    expect(baseMoved).toBe(1);
    expect(() => r.file("gates-3.json")).not.toThrow(); // implement, finalize, after merge
    expect(r.github.prs[0]!.draft).toBe(false);
  });

  it("conflict: merge aborted, needs_human naming the files, draft PR, worktree clean", async () => {
    const r = await runScenario({
      script: "clean.json",
      onCall: moveBaseOnReview("src/math.js", "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function divide(a, b) {\n  return a / b;\n}\n"),
    });
    expect(r.result).toMatchObject({ result: "needs_human", merge_policy: "human_review" });
    expect(r.result.reason).toMatch(/^base main moved \([0-9a-f]{8}\): merge conflict in src\/math\.js$/);
    expect(r.github.prs[0]!.draft).toBe(true);
    expect(r.github.prs[0]!.body).toContain("merge conflict in src/math.js");
    const wt = join(r.runDir, "worktree");
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(() => git(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(git(wt, "log", "-1", "--format=%s")).toBe("feat(P1): multiply\n");
    expect(r.events.find((e) => e.data.merge_conflict)?.data.merge_conflict).toEqual(["src/math.js"]);
  });
});

describe("one run per repo", () => {
  it("a second run on the same repo (another task) returns locked, naming the holder", async () => {
    let release: (() => void) | undefined;
    const r = await runScenario({
      script: "clean.json",
      before: (repo, home) => void (release = acquireRepoLock(home, repo, "20261029-000000-aaaaaa")),
    });
    release?.();
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toContain("locked by run 20261029-000000-aaaaaa");
    expect(r.runner.calls).toEqual([]);
  });

  it("--wait queues until the repo is free, then runs", async () => {
    const r = await runScenario({
      script: "clean.json",
      options: { wait: true },
      deps: { lockPollMs: 10 },
      before: (repo, home) => {
        const release = acquireRepoLock(home, repo, "20261029-000000-bbbbbb")!;
        setTimeout(release, 150);
      },
    });
    expect(r.result.result).toBe("done");
    const queued = eventsOf(r, "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toMatchObject({ holder_run_id: "20261029-000000-bbbbbb", holder_pid: process.pid });
    const firstAgent = r.events.findIndex((e) => e.event === "agent_finished");
    expect(r.events.findIndex((e) => e.event === "queued")).toBeLessThan(firstAgent);
    expect(r.events.some((e) => e.data.lock_acquired)).toBe(true);
  });
});

describe("run guards", () => {
  it("max_wall_minutes is the outer limit -> needs_human", async () => {
    const r = await runScenario({ script: "base-red.json", patch: (c) => void ((c.limits as Record<string, unknown>).max_wall_minutes = 0.00001) });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/max_wall_minutes/);
    expect(r.resultFile).toMatchObject({ worktree: null, run_dir: r.runDir });
  });

  it("max_wall_minutes also stops an agent session that keeps heartbeating", async () => {
    const started = Date.now();
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void ((c.limits as Record<string, unknown>).max_wall_minutes = 0.005), // 300 ms
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, heartbeats: { count: 1000, interval_ms: 10 } } : s)),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/max_wall_minutes/);
    expect(eventsOf(r, "heartbeat").length).toBeGreaterThan(3);
    expect(r.events.some((e) => e.event === "progress" && e.data.aborted === "max_wall_minutes")).toBe(true);
  });

  it("an external abort (SIGTERM handler) stops the run as failed and still writes result.json", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, heartbeats: { count: 1000, interval_ms: 10 } } : s)),
      deps: { signal: controller.signal },
      onCall: () => void setTimeout(() => controller.abort(new Interrupted("SIGTERM")), 100),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.resultFile).toMatchObject({ result: "failed", reason: "interrupted by SIGTERM" });
    expect(r.events.at(-1)).toMatchObject({ event: "run_finished", data: { result: "failed" } });
    expect(r.github.prs).toEqual([]);
  });

  const realSandbox = ((): Sandbox | undefined => {
    try {
      return createSandbox("required", hostProbe);
    } catch {
      return undefined;
    }
  })();

  const SERVE = `node -e "require('http').createServer((q,r)=>r.end('hello')).listen(Number(process.argv[1]),'0.0.0.0')" {port:web}`;
  const FETCH = `node -e "fetch(process.env.WEB_URL).then(r=>r.text()).then(t=>process.exit(t==='hello'?0:1),()=>process.exit(2))"`;
  const withWeb = (start: string) => (c: Record<string, unknown>) => {
    c.services = [{ name: "web", start, env: { WEB_URL: "http://127.0.0.1:{port:web}/" }, ready_timeout_s: 20 }];
    (c.checks as unknown[]).push({ name: "web", run: FETCH, tier: "fast", services: ["web"] });
  };

  for (const jailed of [false, true]) {
    it.skipIf(jailed && !realSandbox)(`services: started once for their check, env passed, logs in the run dir, stopped at run end${jailed ? " (sandboxed, pasta forwards)" : ""}`, async () => {
      const r = await runScenario({ script: "clean.json", patch: withWeb(SERVE), deps: jailed ? { sandbox: realSandbox } : {} });
      expect(r.result.result).toBe("done");
      const svc = eventsOf(r, "service").map((e) => e.data.action);
      expect(svc).toEqual(["ports", "service_starting", "service_ready", "service_stopped"]);
      expect(eventsOf(r, "service")[1]!.data.sandboxed).toBe(jailed);
      expect(eventsOf(r, "gate_result").filter((e) => e.data.check === "web").every((e) => e.data.status === "pass")).toBe(true);
      expect(r.file("services/web.log")).toContain("[factory] start web");
      expect(readdirSync(join(r.factoryHome, "ports"))).toEqual([]);
      // stopped before result.json was written
      const stopped = r.events.findIndex((e) => e.event === "service" && e.data.action === "service_stopped");
      expect(stopped).toBeLessThan(r.events.findIndex((e) => e.event === "run_finished"));
    }, 90_000);
  }

  it("services: a service that does not come up stops the run as needs_human (env_missing)", async () => {
    const r = await runScenario({ script: "clean.json", patch: withWeb("echo cannot-bind >&2; exit 1"), steps: (s) => s.filter((x) => x.role === "plan_high") });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/^env_missing: service web exited with code 1[\s\S]*cannot-bind/);
    expect(readdirSync(join(r.factoryHome, "ports"))).toEqual([]);
  });

  it.skipIf(!realSandbox)("sandbox: setup and checks run jailed; agents get the jail; the run still passes", async () => {
    const reqs: AgentRequest[] = [];
    const r = await runScenario({
      script: "clean.json",
      deps: { sandbox: realSandbox },
      onCall: (req) => void reqs.push(req),
      patch: (c) => {
        // Inside the jail: own pid namespace (a handful of processes) and no host factory home.
        c.setup = 'test "$(ls /proc | grep -c "^[0-9]")" -lt 10';
        (c.checks as unknown[]).push({ name: "jailed", run: 'test ! -e "$HOME/../../../pi" && test ! -e /run/docker.sock', tier: "fast" });
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.events.find((e) => e.event === "sandbox")?.data).toMatchObject({ mode: "required", fs: "bwrap", net: "isolated" });
    const impl = reqs.find((q) => q.role === "implement")!;
    expect(impl.jail?.rw).toEqual([join(r.runDir, "worktree"), join(r.runDir, "home")]);
    expect(impl.jail?.ro).toEqual([join(r.repo, ".git")]);
    expect(impl.jail?.hide).toEqual([r.factoryHome]);
  }, 60_000);
});
