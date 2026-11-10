import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResultSchema } from "../../src/events.js";
import { Interrupted } from "../../src/interrupt.js";
import type { RunDeps } from "../../src/pipeline/context.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { continueBaseRed } from "../../src/pipeline/run.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { canonicalRepoId, flushMemory, loadMemory } from "../../src/memory.js";
import type { AgentRequest } from "../../src/agents/runner.js";
import { type FakeStep, realSleep } from "../../src/agents/fake-runner.js";
import { createSandbox, hostProbe, type Sandbox } from "../../src/sandbox/sandbox.js";
import { addOrigin, commitFile, FIXTURES } from "../helpers/repo.js";
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

const HOOK_URL = "https://hooks.example.test/automations/webhook/e2e-secret-id";
const HOOK_KEY = "crsr_e2e-sender-key-0123456789abcdef";

/** notify.yaml for acme/widgets in the scenario's factory home, a GitHub-like origin URL, and a fetch spy. */
function withHook(status = 200) {
  const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  return {
    sent,
    setup: (repo: string) => void git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"),
    before: (_repo: string, home: string) => {
      writeFileSync(join(home, "notify.yaml"), `repos:\n  acme/widgets:\n    url: ${HOOK_URL}\n    key: ${HOOK_KEY}\n`, { mode: 0o600 });
    },
    deps: {
      notifyBackoffMs: [0],
      notifyFetch: async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        sent.push({ headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
        return { status };
      },
    },
  };
}

describe("notify hook on run_finished", () => {
  it.each([
    ["done", "clean.json", {}],
    ["base_red", "base-red.json", { github: (gh: { status: string }) => void (gh.status = "red") }],
    ["needs_human", "invalid-handoff.json", {}],
  ] as const)("%s: POSTs the minimal payload once, after result.json; events never hold the URL or key", async (expected, script, extra) => {
    const h = withHook();
    const r = await runScenario({ script, setup: h.setup, before: h.before, deps: h.deps, ...(extra as object) });
    expect(r.result.result).toBe(expected);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.headers.Authorization).toBe(`Bearer ${HOOK_KEY}`);
    expect(h.sent[0]!.body).toMatchObject({
      event: "factory.run_finished", run_id: r.runId, repo: "acme/widgets", result: expected,
      reason: r.result.reason.slice(0, 500), pr: r.result.pr, finished_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(String(h.sent[0]!.body.event_id)).toHaveLength(24);
    expect(eventsOf(r, "notify")).toEqual([expect.objectContaining({ data: expect.objectContaining({ repo: "acme/widgets", status: "sent", http_status: 200 }) })]);
    const all = readdirSync(r.runDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => readFileSync(join(r.runDir, d.name), "utf8")).join("\n");
    expect(all).not.toContain(HOOK_KEY);
    expect(all).not.toContain("e2e-secret-id");
  });

  it("a failing webhook is logged and never changes the result", async () => {
    const h = withHook(503);
    const r = await runScenario({ script: "clean.json", setup: h.setup, before: h.before, deps: h.deps });
    expect(r.result.result).toBe("done");
    expect(h.sent.length).toBeGreaterThan(1);
    expect(eventsOf(r, "notify")[0]!.data).toMatchObject({ status: "failed", http_status: 503 });
  });

  it("locked runs notify too", async () => {
    const h = withHook();
    let release: (() => void) | undefined;
    const r = await runScenario({
      script: "clean.json",
      setup: h.setup,
      // Lock id is the origin URL git reports. A credential rewrite (https://token@github.com/…) must not miss the lock.
      before: (repo, home) => (h.before(repo, home), void (release = acquireRepoLock(home, git(repo, "remote", "get-url", "origin").trim(), "20261029-000000-aaaaaa"))),
      deps: h.deps,
    });
    release?.();
    expect(r.result.result).toBe("locked");
    expect(h.sent.map((s) => s.body.result)).toEqual(["locked"]);
  });

  it("--notify stores notify_target and posts to that target, not the repo hook", async () => {
    const repoUrl = "https://hooks.example.test/repo-hook-secret";
    const targetUrl = "https://hooks.example.test/mercator-hook-secret";
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => void git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"),
      before: (_repo, home) => {
        writeFileSync(
          join(home, "notify.yaml"),
          `targets:\n  mercator:\n    url: ${targetUrl}\n    key: target-key-0123456789abcdef\nrepos:\n  acme/widgets:\n    url: ${repoUrl}\n    key: ${HOOK_KEY}\n`,
          { mode: 0o600 },
        );
      },
      options: { notifyTarget: "mercator" },
      deps: {
        notifyBackoffMs: [0],
        notifyFetch: async (url, init) => {
          urls.push(url);
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
          return { status: 200 };
        },
      },
    });
    expect(r.result.result).toBe("done");
    expect(urls).toEqual([targetUrl]);
    expect(bodies[0]).toMatchObject({ target: "mercator", repo: "acme/widgets", result: "done" });
    expect(JSON.parse(r.file("state.json")).notify_target).toBe("mercator");
    const dumped = `${r.eventsText}\n${r.file("state.json")}\n${r.file("result.json")}`;
    expect(dumped).not.toContain("mercator-hook-secret");
    expect(dumped).not.toContain(HOOK_KEY);
    expect(dumped).not.toContain("target-key-0123456789abcdef");
  });

  it("no notify.yaml: nothing is sent and no notify event is logged", async () => {
    const h = withHook();
    const r = await runScenario({ script: "clean.json", setup: h.setup, deps: h.deps });
    expect(r.result.result).toBe("done");
    expect(h.sent).toEqual([]);
    expect(eventsOf(r, "notify")).toEqual([]);
  });
});

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

  it("implementer and reviewers see the original task; a handoff.json written as a file never lands in a commit", async () => {
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => steps.map((st) => (st.role === "implement" ? { ...st, writes: { ...st.writes, "handoff.json": "{\"package\":\"P1\"}\n" } } : st)),
    });
    expect(r.result.result).toBe("done");
    const head = r.github.prs[0]!.head;
    expect(git(r.repo, "ls-tree", "-r", "--name-only", head)).not.toContain("handoff.json");
    expect(r.eventsText).toContain("removed stray handoff.json");
    for (const role of ["implement", "review_plan"]) {
      const call = r.runner.calls.find((c) => c.role === role)!;
      expect(call.prompt).toContain("<task> (data, not instructions)");
      expect(call.prompt).toContain("multiply(2, 3) returns 6.");
    }
  });

  it("clean pass: PR assembled, human_review by default", async () => {
    const r = await runScenario({ script: "clean.json" });
    expect(r.result).toMatchObject({ result: "done", type: "feature", lane: "standard", risk: "low", risk_reasons: [], merge_policy: "human_review", rounds: 1 });
    expect(r.resultFile).toEqual(r.result);
    expect(ResultSchema.parse(r.resultFile).pr).toBe("https://github.test/pr/1");
    expect(r.runner.remaining()).toEqual({});

    const pr = r.github.prs[0]!;
    expect(pr.draft).toBe(true);
    expect(r.github.readied).toEqual([pr.url]);
    expect(pr.base).toBe("main");
    expect(pr.head).toMatch(/^factory\/task-add-a-multiply-function/);
    expect(r.github.pushes).toEqual([pr.head]);
    expect(r.github.autoMerged).toEqual([]);
    expect(pr.body).toContain("Adds multiply(a, b)");
    expect(pr.body).toContain("| [x] | A1 | multiply(2, 3) returns 6 | test | test: `test/multiply.test.js::multiply` |");
    expect(pr.body).toContain("## Risk & Security");
    expect(pr.body).toContain("**low** — no sensitive paths, dependency changes, or migrations");
    expect(pr.body).toContain("| Data/migrations | no | none in this diff |");
    expect(pr.body).not.toMatch(/merge policy|Needs human review|## Mac install steps/);
    expect(pr.body).toMatch(/✅ unit/);
    expect(pr.body).toContain("Skipped security gates: gitleaks, semgrep");
    expect(pr.body).toMatch(/SKIPPED gitleaks is not on PATH/);
    expect(r.result.skipped_gates).toEqual(["gitleaks", "semgrep"]);
    expect(r.runner.calls.find((c) => c.role.startsWith("review"))?.prompt).toContain('"skipped_gates"');
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
    // diff_count_tests defaults to true: test lines stay in the limit and are not split out.
    expect(r.result.counted_lines).toBeUndefined();
    expect(r.result.excluded_test_lines).toBeUndefined();
    expect(eventsOf(r, "gate_result").filter((e) => e.data.check === "max_diff_lines").every((e) => e.data.counted_lines === undefined)).toBe(true);
  });

  it("opens a draft, pushes, marks ready, and only then reads CI", async () => {
    const order: string[] = [];
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        const push = gh.push.bind(gh);
        const create = gh.createPr.bind(gh);
        const ready = gh.markReady.bind(gh);
        const status = gh.baseStatus.bind(gh);
        gh.push = async (dir, branch) => {
          order.push("push");
          return push(dir, branch);
        };
        gh.createPr = async (req) => {
          order.push(`create:${req.draft}`);
          return create(req);
        };
        gh.markReady = async (dir, pr) => {
          order.push("ready");
          return ready(dir, pr);
        };
        gh.baseStatus = async () => {
          order.push("status");
          return status();
        };
      },
      // One sample: this test is the push/ready order, not the PR CI wait.
      patch: (c) => void ((c.limits as Record<string, unknown>).pr_ci_wait_minutes = 0),
    });
    expect(r.result.result).toBe("done");
    expect(order).toEqual(["status", "push", "create:true", "ready", "status"]);
    expect(r.github.drafted).toEqual([]);
    expect(r.events.some((e) => e.data.pr_ready)).toBe(true);
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
    expect(r.github.prs[0]?.draft).toBe(true);
    expect(r.github.readied).toEqual([r.github.prs[0]!.url]);
  });

  it("stalemate: rejected wontfix -> needs_human, draft PR, human_review", async () => {
    const r = await runScenario({ script: "stalemate.json", patch: (c) => void (c.merge = { auto_merge_max_risk: "medium" }) });
    expect(r.result).toMatchObject({ result: "needs_human", merge_policy: "human_review", rounds: 2 });
    expect(r.result.reason).toMatch(/stalemate/);
    expect(r.github.prs[0]?.draft).toBe(true);
    expect(r.github.readied).toEqual([]);
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

  it("diff_count_tests false: test files stay out of max_diff_lines; the log and result.json report both numbers", async () => {
    const testFile = [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { multiply } from "../src/math.js";',
      "",
      'test("multiply", () => {',
      "  assert.equal(multiply(2, 3), 6);",
      "});",
      ...Array.from({ length: 80 }, (_, i) => `// padding ${i}`),
      "",
    ].join("\n");
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => {
        c.limits = { ...(c.limits as object), diff_count_tests: false, max_diff_lines: 20 };
        c.merge = { ...(c.merge as object), low_max_diff_lines: 30 };
      },
      steps: (steps) => steps.map((st) => (st.role === "implement" ? { ...st, writes: { ...st.writes, "test/multiply.test.js": testFile } } : st)),
    });
    expect(r.result.result).toBe("done");
    // Production diff fits the gate; the same lines plus tests still raise merge risk.
    expect(r.result.counted_lines).toBeGreaterThan(0);
    expect(r.result.counted_lines!).toBeLessThanOrEqual(20);
    expect(r.result.excluded_test_lines).toBeGreaterThan(40);
    const riskLines = r.result.counted_lines! + r.result.excluded_test_lines!;
    expect(riskLines).toBeGreaterThan(30);
    expect(r.result.risk).toBe("medium");
    expect(r.result.risk_reasons).toContain(`diff ${riskLines} lines > 30`);
    expect(r.github.prs[0]?.body).toContain(`diff ${riskLines} lines > 30`);
    expect(r.resultFile).toEqual(r.result);
    const gateEvents = eventsOf(r, "gate_result").filter((e) => e.data.check === "max_diff_lines");
    expect(gateEvents.length).toBeGreaterThan(0);
    for (const e of gateEvents) expect(e.data).toMatchObject({ counted_lines: expect.any(Number), excluded_test_lines: expect.any(Number) });
    const final = [...eventsOf(r, "progress")].reverse().find((e) => typeof e.data.counted_lines === "number");
    expect(final?.data).toMatchObject({ counted_lines: r.result.counted_lines, excluded_test_lines: r.result.excluded_test_lines });
    expect(r.file("gates-1.json")).toContain("test lines not counted");
  });

  it("fast lane escalates after implement when the diff is too big: full review, PR names the reasons, risk stays on the diff", async () => {
    const r = await runScenario({ script: "clean.json", options: { lane: "fast" }, patch: (c) => void (c.fast_lane = { max_diff_lines: 3 }), steps: (s) => s.map((x) => (x.role === "plan_high" ? { ...x, role: "plan_normalize" } : x)) });
    expect(r.result).toMatchObject({ result: "done", lane: "standard", risk: "low" });
    expect(r.runner.remaining()).toEqual({});
    const esc = eventsOf(r, "lane_escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ step: "implement", data: { from: "fast", to: "standard" } });
    expect((esc[0]!.data.reasons as string[])[0]).toMatch(/^diff \d+ lines > fast_lane.max_diff_lines 3$/);
    expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data).toMatchObject({ mode: "full" });
    expect(r.github.prs[0]?.body).toMatch(/- lane: fast → standard \(diff \d+ lines/);
    expect(r.github.prs[0]?.body).not.toContain("fast-lane escalation");
    expect(JSON.parse(r.file("state.json"))).toMatchObject({ lane: "standard" });
  });

  it("fast lane: invalid plan_normalize output escalates at intake to the plan step", async () => {
    const r = await runScenario({ script: "invented-normalize.json", options: { lane: "fast" } });
    expect(r.result).toMatchObject({ result: "done", lane: "standard" });
    expect(r.runner.remaining()).toEqual({});
    expect(eventsOf(r, "lane_escalated")[0]).toMatchObject({ step: "intake" });
    expect((eventsOf(r, "lane_escalated")[0]!.data.reasons as string[])[0]).toMatch(/^plan_normalize output invalid/);
  });

  it("fast lane: normalize failure, small diff, no sensitive paths -> risk low; escalation stays in result.json", async () => {
    const r = await runScenario({ script: "invented-normalize.json", options: { lane: "fast" } });
    expect(r.result).toMatchObject({ result: "done", lane: "standard", risk: "low" });
    expect(r.resultFile).toMatchObject({ lane: "standard", risk: "low" });
    expect(r.runner.calls.map((c) => c.role).slice(0, 3)).toEqual(["plan_normalize", "plan_normalize", "plan_medium"]);
    const reasons = eventsOf(r, "lane_escalated")[0]!.data.reasons as string[];
    expect(reasons[0]).toMatch(/^plan_normalize output invalid/);
    expect(r.github.prs[0]?.body).toContain("plan_normalize output invalid");
    expect(r.github.prs[0]?.body).not.toContain("fast-lane escalation");
  });

  it("fallback: capacity error -> backoff retry on the same model -> fallback", async () => {
    const r = await runScenario({ script: "fallback.json", patch: (c) => void ((c.limits as Record<string, unknown>).pr_ci_wait_minutes = 0) });
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

  it("red CI on base ends the run at once, without waiting", async () => {
    const r = await runScenario({ script: "base-red.json", github: (gh) => void (gh.status = "red"), deps: { baseCiPollMs: 1000 } });
    expect(r.result.reason).toMatch(/is red, not green/);
    expect(r.slept).toEqual([]);
  });

  it("pending CI on base is polled up to limits.base_ci_wait_minutes, then base_red", async () => {
    const r = await runScenario({
      script: "base-red.json",
      github: (gh) => void (gh.status = "pending"),
      patch: (c) => void ((c.limits as Record<string, unknown>).base_ci_wait_minutes = 2),
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result.result).toBe("base_red");
    expect(r.result.reason).toMatch(/is still pending after 2 min, not green/);
    expect(r.slept).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it("pending CI on base that turns green continues the run", async () => {
    const seq = ["pending", "pending", "green"] as const;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        let i = 0;
        gh.baseStatus = async () => seq[Math.min(i++, seq.length - 1)]!;
      },
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result.result).toBe("done");
    expect(r.slept.slice(0, 2)).toEqual([30_000, 30_000]);
    expect(r.events.some((e) => e.event === "progress" && (e.data.base_ci as { status?: string } | undefined)?.status === "green")).toBe(true);
  });

  it("base_ci_wait_minutes: 0 keeps the old behaviour (pending is base_red at once)", async () => {
    const r = await runScenario({
      script: "base-red.json",
      github: (gh) => void (gh.status = "pending"),
      patch: (c) => void ((c.limits as Record<string, unknown>).base_ci_wait_minutes = 0),
    });
    expect(r.result.result).toBe("base_red");
    expect(r.slept).toEqual([]);
  });

  const autoMerge = (c: Record<string, unknown>) => {
    (c.limits as Record<string, unknown>).pr_ci_wait_minutes = 2;
    ((c.merge ??= {}) as Record<string, unknown>).auto_merge_max_risk = "medium";
  };

  it("pending CI on the PR head is polled; still pending is human_review and is not auto-merged", async () => {
    let n = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => (n++ === 0 ? "none" : "pending");
      },
      patch: autoMerge,
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "human_review" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.drafted).toEqual([]);
    expect(r.slept).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(r.events.some((e) => e.event === "progress" && (e.data.pr_ci as { status?: string } | undefined)?.status === "pending")).toBe(true);
  });

  it("none on the PR head is polled until green, then auto-merge is enabled", async () => {
    const seq = ["none", "none", "green"] as const;
    let i = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => seq[Math.min(i++, seq.length - 1)]!;
      },
      patch: autoMerge,
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "auto" });
    expect(r.github.autoMerged).toEqual([r.result.pr]);
    expect(r.slept).toEqual([30_000]);
  });

  it("none on the PR head that never registers is human_review and is not auto-merged", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => void (gh.status = "none"),
      patch: autoMerge,
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "human_review" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.drafted).toEqual([]);
    expect(r.github.readied).toEqual([r.result.pr]);
    expect(r.slept).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it("pending PR CI that turns green continues and does not wait out the whole window", async () => {
    const seq = ["none", "pending", "green"] as const;
    let i = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => seq[Math.min(i++, seq.length - 1)]!;
      },
      patch: autoMerge,
      deps: { baseCiPollMs: 30_000 },
    });
    expect(r.result.result).toBe("done");
    expect(r.slept).toEqual([30_000]);
    expect(r.github.autoMerged).toEqual([r.result.pr]);
  });

  it("red CI on the PR head is needs_human, draft again, and is not auto-merged", async () => {
    let n = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => (n++ === 0 ? "none" : "red");
      },
      patch: autoMerge,
    });
    expect(r.result).toMatchObject({ result: "needs_human", merge_policy: "human_review" });
    expect(r.result.reason).toMatch(/CI on the PR head \([0-9a-f]{8}\) is red/);
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.readied).toEqual([r.result.pr]);
    expect(r.github.drafted).toEqual([r.result.pr]);
    expect(r.github.prStates.get(r.result.pr!)?.draft).toBe(true);
    expect(JSON.parse(r.file("state.json"))).toMatchObject({ pr_draft: true });
    expect(r.events.some((e) => e.data.pr_marked_draft === r.result.pr)).toBe(true);
    expect(r.github.updates.some((u) => u.body.includes("## CI"))).toBe(true);
    expect(r.slept).toEqual([]);
  });

  it("green CI on the PR head enables auto-merge", async () => {
    let n = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => (n++ === 0 ? "none" : "green");
      },
      patch: autoMerge,
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "auto" });
    expect(r.github.autoMerged).toEqual([r.result.pr]);
    expect(r.github.drafted).toEqual([]);
    expect(r.slept).toEqual([]);
  });

  it("pr_ci_wait_minutes 0 does not wait; a pending head still does not fail or auto-merge", async () => {
    let n = 0;
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.baseStatus = async () => (n++ === 0 ? "none" : "pending");
      },
      patch: (c) => {
        (c.limits as Record<string, unknown>).pr_ci_wait_minutes = 0;
        ((c.merge ??= {}) as Record<string, unknown>).auto_merge_max_risk = "medium";
      },
    });
    expect(r.result).toMatchObject({ result: "done", merge_policy: "human_review" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.slept).toEqual([]);
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
    const attempts = eventsOf(r, "progress").filter((e) => e.role === "plan_normalize" && Array.isArray(e.data.attempts));
    expect(attempts.at(-1)?.data.attempts).toEqual([
      expect.objectContaining({ n: 1, ok: false }),
      expect.objectContaining({ n: 2, ok: false }),
    ]);
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

  it("red_green not_applicable is opt-in: the proof is skipped, and the PR and gate name the loosening", async () => {
    const r = await runScenario({ script: "bug-stabilize.json", task: "max-bug.md" });
    expect(r.result).toMatchObject({ result: "done", type: "bug" });
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    const gates = JSON.parse(r.file("gates-1.json"));
    expect(gates.checks.find((c: { name: string }) => c.name === "red_green")).toMatchObject({
      status: "pass",
      output_tail: expect.stringContaining("EXEMPT not_applicable (loosening):"),
    });
    expect(gates.checks.find((c: { name: string }) => c.name === "config_guard").output_tail).toContain("loosening: red_green not_applicable");
    expect(gates.repro_red_on_base).toBeUndefined();
    const body = r.github.prs[0]?.body ?? "";
    expect(body).toContain("## Risk & Security");
    expect(body).toContain("EXEMPT not_applicable (loosening):");
    expect(body).toContain("loosening: red_green not_applicable");
    const review = r.runner.calls.find((c) => c.role === "review_plan");
    expect(review?.prompt).toContain("restricts to only test/max.test.js, which the task text does not say");
    expect(review?.prompt).toContain("red_green loosening: not_applicable");
    expect(review?.prompt).toContain("EXEMPT not_applicable (loosening):");
    expect(review?.system).toContain("must not be stricter than the task");
    expect(eventsOf(r, "step_started").find((e) => e.step === "review")?.data.plan_checks).toEqual(expect.stringContaining("only test/max.test.js"));
    expect(eventsOf(r, "gate_result").find((e) => e.data.check === "red_green")?.data.detail).toEqual(expect.stringContaining("EXEMPT not_applicable"));
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
    it("auto (auto_merge_max_risk: low, low-risk diff) enables auto-merge when CI is green", async () => {
      let n = 0;
      const r = await runScenario({
        script: "clean.json",
        github: (gh) => {
          gh.baseStatus = async () => (n++ === 0 ? "none" : "green");
        },
        patch: (c) => void (c.merge = { auto_merge_max_risk: "low" }),
      });
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
        steps: (steps) =>
          steps.map((s) =>
            s.role === "plan_high" ? { ...s, output: { ...(s.output as object), protected_changes: [{ file: "src/math.js", change: "add multiply", reason: "task" }] } } : s,
          ),
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
    expect(r.github.prs[0]!.draft).toBe(true);
    expect(r.github.readied).toEqual([r.github.prs[0]!.url]);
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
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void ((c.limits as Record<string, unknown>).max_wall_minutes = 0.005), // 300 ms
      // Fake sleep: the 1000 heartbeats do not take 10 s. A wall-clock cap on the whole scenario
      // includes fixture setup and fails when the worker is busy, without saying the limit failed.
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, heartbeats: { count: 1000, interval_ms: 10 } } : s)),
    });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/max_wall_minutes/);
    expect(eventsOf(r, "heartbeat").length).toBeGreaterThan(3);
    expect(r.events.some((e) => e.event === "progress" && e.data.aborted === "max_wall_minutes")).toBe(true);
  });

  it("max_wall_minutes mid-implement: needs_human with active minutes and the resume command, no 1 s gate run", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void ((c.limits as Record<string, unknown>).max_wall_minutes = 0.01), // 600 ms
      steps: (steps) => steps.map((s) => (s.role === "implement" ? { ...s, heartbeats: { count: 1000, interval_ms: 10 } } : s)),
    });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/^max_wall_minutes \(0\.01\) exceeded \(\d+ active min\); factory resume \d{8}-\d{6}-[0-9a-f]{6}$/);
    expect(r.events.some((e) => e.event === "progress" && e.data.aborted === "max_wall_minutes")).toBe(true);
    const abort = r.events.findIndex((e) => e.data.aborted === "max_wall_minutes");
    expect(r.events.slice(abort).some((e) => e.event === "gate_result")).toBe(false);
  });

  it("an external abort (SIGTERM handler) stops the run as failed and still writes result.json", async () => {
    const controller = new AbortController();
    // The plan session is blocked in a long sleep. Abort from outside that call, and time only the
    // stop itself: the old bound included fixture setup and fired late when the worker was busy.
    let abortedAt = 0;
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, heartbeats: { count: 1000, interval_ms: 60_000 } } : s)),
      deps: { signal: controller.signal, sleep: realSleep },
      onCall: () => void setTimeout(() => {
        abortedAt = Date.now();
        controller.abort(new Interrupted("SIGTERM"));
      }, 30),
    });
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(5000);
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
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
    expect(impl.jail?.rw).toEqual([join(r.runDir, "worktree"), join(r.runDir, "home"), join(r.factoryHome, "cache")]);
    expect(impl.jail?.ro).toEqual([join(r.repo, ".git")]);
    expect(impl.jail?.hide).toEqual([r.factoryHome]);
  }, 60_000);
});

describe("base_red resume", () => {
  function depsOf(r: ScenarioRun, extra: Partial<RunDeps> = {}): RunDeps {
    return {
      runner: r.runner,
      github: r.github,
      profile: loadProfile(join(FIXTURES, "profile.yaml")),
      factoryHome: r.factoryHome,
      parentEnv: { ...process.env, FOO_TOKEN: SECRET },
      sleep: async () => {},
      ...extra,
    };
  }

  it("resumes the same run once the base commit is green", async () => {
    const r = await runScenario({ script: "clean.json", github: (gh) => void (gh.status = "red") });
    expect(r.result.result).toBe("base_red");
    const st = JSON.parse(r.file("state.json")) as { base_ci?: string; base_sha?: string; worktree?: string | null };
    expect(st.base_ci).toBe("red");
    expect(st.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(st.worktree ?? null).toBeNull();

    expect(await continueBaseRed(r.runId, depsOf(r))).toBeUndefined();
    expect(JSON.parse(r.file("result.json")).result).toBe("base_red");

    r.github.status = "green";
    const resumed = await continueBaseRed(r.runId, depsOf(r));
    expect(resumed).toMatchObject({ result: "done", run_id: r.runId });
    expect(JSON.parse(r.file("state.json")).base_ci).toBeUndefined();
  });

  it("a pending timeout is resumed once CI is green; an expired window and hours 0 are not", async () => {
    const pending = await runScenario({
      script: "clean.json",
      github: (gh) => void (gh.status = "pending"),
      patch: (c) => void ((c.limits as Record<string, unknown>).base_ci_wait_minutes = 0),
    });
    expect(JSON.parse(pending.file("state.json")).base_ci).toBe("pending");
    pending.github.status = "green";
    expect((await continueBaseRed(pending.runId, depsOf(pending)))?.result).toBe("done");

    const expired = await runScenario({ script: "clean.json", github: (gh) => void (gh.status = "red") });
    const st = JSON.parse(expired.file("state.json")) as { updated_at: string };
    st.updated_at = new Date(Date.now() - 49 * 3_600_000).toISOString();
    writeFileSync(join(expired.runDir, "state.json"), JSON.stringify(st));
    expired.github.status = "green";
    expect(await continueBaseRed(expired.runId, depsOf(expired))).toBeUndefined();
    expect(JSON.parse(expired.file("result.json")).result).toBe("base_red");

    const off = await runScenario({
      script: "clean.json",
      github: (gh) => void (gh.status = "red"),
      patch: (c) => void ((c.limits as Record<string, unknown>).base_red_resume_hours = 0),
    });
    off.github.status = "green";
    expect(await continueBaseRed(off.runId, depsOf(off))).toBeUndefined();
  });

  it("a local fast-check base_red is not resumed, and a locked repo is left base_red", async () => {
    const local = await runScenario({
      script: "base-red.json",
      patch: (c) => void (c.checks as unknown[]).push({ name: "broken", run: "false", tier: "fast" }),
    });
    expect(JSON.parse(local.file("state.json")).base_ci).toBeUndefined();
    local.github.status = "green";
    expect(await continueBaseRed(local.runId, depsOf(local))).toBeUndefined();

    const locked = await runScenario({ script: "clean.json", github: (gh) => void (gh.status = "red") });
    const release = acquireRepoLock(locked.factoryHome, locked.repo, "20261029-000000-bbbbbb")!;
    locked.github.status = "green";
    try {
      expect(await continueBaseRed(locked.runId, depsOf(locked))).toBeUndefined();
      expect(JSON.parse(locked.file("result.json")).result).toBe("base_red");
      expect(locked.eventsText).not.toContain("base_red_resume");
      const text = readFileSync(join(locked.runDir, "events.jsonl"), "utf8");
      expect(text).toContain("base_red_resume");
    } finally {
      release();
    }
  });
});
