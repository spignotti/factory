/**
 * Issue #179: every `needs_human`-class stop persists a machine-readable stop cause and the
 * permitted recovery action next to the diagnostics. Readers (worker, status) use the stored
 * cause, never the reason text; legacy stops without a cause fail closed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import type { Io } from "../../src/commands/gates.js";
import { queueAdd } from "../../src/commands/queue.js";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { ResultSchema, STOP_ACTION, STOP_CAUSES, type RunResult } from "../../src/events.js";
import { FakeGitHub, type Issue } from "../../src/gh.js";
import { stopCauseOf, stopFor } from "../../src/pipeline/outcome.js";
import { readState } from "../../src/pipeline/state.js";
import { stopCauseForMergeFailure, stopCauseForSyncFailure } from "../../src/steps/finalize.js";
import { commitFile } from "../helpers/repo.js";
import { loadQueueByKey, repoQueueKey } from "../../src/queue/store.js";
import { applyOutcome, runQueue, type StartRun } from "../../src/queue/worker.js";
import type { QueueEntry, QueueFile } from "../../src/queue/store.js";
import { FIXTURES, createFixtureRepo } from "../helpers/repo.js";
import { resumeScenario, runScenario, type ScenarioRun } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");
const issue = { number: 7, title: "Multiply", body, labels: ["factory-ready"] };

/** A done run whose PR-head CI turns red after the first look: a technical, continuable stop. */
async function redPr(): Promise<ScenarioRun> {
  let checks = 0;
  return runScenario({
    script: "clean.json",
    options: { issue: 7 },
    patch: (cfg) => {
      cfg.merge = { auto_merge_max_risk: "low" };
    },
    github: (gh) => {
      gh.issues.set(7, issue);
      gh.baseStatus = async () => (checks++ === 0 ? "none" : "red");
    },
  });
}

/** Replace the first scripted implement call with these failing calls of the same role. */
function failFirstImplement(errors: FakeStep[]) {
  return (steps: FakeStep[]): FakeStep[] => {
    const out: FakeStep[] = [];
    let replaced = false;
    for (const s of steps) {
      if (!replaced && s.role === "implement") {
        out.push(...errors);
        replaced = true;
        continue;
      }
      out.push(s);
    }
    return out;
  };
}

describe("stop cause on the run result and state", () => {
  it("a stream abort after the retry budget persists transient_retry", async () => {
    const abort = (model: string): FakeStep => ({ role: "implement", model, error: { message: "premature EOF" } });
    const errors = [
      ...Array.from({ length: 3 }, () => abort("opencode-go/deepseek-v4.1-flash")),
      ...Array.from({ length: 3 }, () => abort("opencode-go/deepseek-v4-pro")),
    ];
    const r = await runScenario({ script: "clean.json", steps: failFirstImplement(errors) });
    expect(r.result.result).toBe("needs_human");
    expect(r.resultFile.stop).toEqual({ cause: "transient_retry", action: "retry" });
    const st = readState(r.runDir);
    expect(st.stop).toEqual({ cause: "transient_retry", action: "retry" });
    expect(st.transient).toBe(true);
  });

  it("an exhausted provider capacity chain persists transient_retry, not a usage-window reset", async () => {
    const at = (model: string): FakeStep => ({ role: "implement", model, error: { message: "429 at capacity, the model is overloaded" } });
    const errors = [
      ...Array.from({ length: 3 }, () => at("opencode-go/deepseek-v4.1-flash")),
      ...Array.from({ length: 3 }, () => at("opencode-go/deepseek-v4-pro")),
    ];
    const r = await runScenario({ script: "clean.json", steps: failFirstImplement(errors) });
    expect(r.result.result).toBe("needs_human");
    // #179 does not infer a usage-window reset from 429/capacity. #177 owns that metadata.
    expect(r.resultFile.stop).toEqual({ cause: "transient_retry", action: "retry" });
    expect(readState(r.runDir).stop).toEqual({ cause: "transient_retry", action: "retry" });
    expect(r.resultFile.stop).not.toEqual({ cause: "provider_window_wait", action: "wait" });
  });

  it("plan questions persist explicit_decision", async () => {
    const r = await runScenario({ script: "needs-input.json" });
    expect(r.result.result).toBe("needs_input");
    expect(r.resultFile.stop).toEqual({ cause: "explicit_decision", action: "decide" });
    expect(readState(r.runDir).stop).toEqual({ cause: "explicit_decision", action: "decide" });
  });

  it("a red PR head on a continuable run persists technical_repair", async () => {
    const r = await redPr();
    expect(r.result.result).toBe("needs_human");
    expect(readState(r.runDir).continuation?.kind).toBe("ci");
    expect(r.resultFile.stop).toEqual({ cause: "technical_repair", action: "repair" });
    expect(readState(r.runDir).stop).toEqual({ cause: "technical_repair", action: "repair" });
  });

  it("a protected diff with red PR CI is human_approval, not a technical recovery", async () => {
    let repoDir = "";
    let checks = 0;
    const r = await runScenario({
      script: "clean.json",
      patch: (cfg) => {
        cfg.merge = { auto_merge_max_risk: "low" };
      },
      before: (repo) => {
        repoDir = repo;
      },
      github: (gh) => {
        gh.baseStatus = async () => (checks++ === 0 ? "none" : "red");
      },
      steps: (steps) => steps.map((s) => {
        if (s.role === "plan_high") {
          const plan = s.output as { packages: { files: string[] }[]; protected_changes?: unknown[] };
          plan.packages[0]!.files.push(".factory/repo.yaml");
          plan.protected_changes = [{ file: ".factory/repo.yaml", change: "add a red check", reason: "the task asks for it" }];
        }
        if (s.role === "implement") {
          const cfg = parse(readFileSync(join(repoDir, ".factory/repo.yaml"), "utf8")) as { checks: unknown[] };
          cfg.checks.push({ name: "red", run: "false", tier: "fast" });
          s.writes = { ...s.writes, ".factory/repo.yaml": stringify(cfg) };
        }
        return s;
      }),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/CI on the PR head/);
    expect(r.result.merge_policy).toBe("human_review");
    expect(r.result.risk).toBe("high");
    expect(r.result.risk_reasons ?? []).toContain("changes protected config (CI / factory)");
    expect(r.resultFile.stop).toEqual({ cause: "human_approval", action: "approve" });
    expect(readState(r.runDir).stop).toEqual({ cause: "human_approval", action: "approve" });
    expect(readState(r.runDir).continuation).toBeUndefined();
    expect(r.resultFile.stop).not.toEqual({ cause: "technical_repair", action: "repair" });
    expect(r.github.autoMerged).toEqual([]);
    expect(r.github.labels.map((l) => l.label)).toContain("factory:protected-config");
    expect(r.github.prs).toHaveLength(1);
  });

  it("post-push repair exhaustion persists budget_exhausted and keeps the spent attempt budget", async () => {
    const r = await redPr();
    const st = readState(r.runDir);
    st.continuation_attempts = 2;
    st.continuation = { kind: "ci", sha: st.reviewed_sha! };
    st.repair = { gate_attempts: 3, network_retries: 4, format_used: true, infra_reruns: 1, class: "code" };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    const exhausted = await resumeScenario(r, { script: "clean.json" });
    expect(exhausted.result.result).toBe("needs_human");
    expect(exhausted.result.reason).toMatch(/exhausted/);
    expect(exhausted.resultFile.stop).toEqual({ cause: "budget_exhausted", action: "decide" });
    const after = readState(r.runDir);
    expect(after.continuation_attempts).toBe(2);
    expect(after.repair).toMatchObject({ gate_attempts: 3, network_retries: 4, infra_reruns: 1 });
    expect(after.stop).toEqual({ cause: "budget_exhausted", action: "decide" });
    expect(exhausted.runner.calls).toEqual([]);
    expect(exhausted.result.run_id).toBe(r.runId);
    expect(exhausted.result.branch).toBe(st.branch);
    expect(exhausted.result.worktree).toBe(st.worktree);
    expect(exhausted.result.pr).toBe(r.result.pr);
  });

  it("a missing repo config for the bug red-green proof persists human_approval", async () => {
    const r = await runScenario({
      script: "bug-plan-only.json",
      patch: (c) => void delete (c.tests as Record<string, unknown>).run,
      task: "max-bug.md",
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/tests.run is required/);
    expect(r.resultFile.stop).toEqual({ cause: "human_approval", action: "approve" });
  });

  it("a completed technical recovery keeps the original run, branch, worktree, PR and spent budgets", async () => {
    const r = await redPr();
    const before = readState(r.runDir);
    expect(before.stop).toEqual({ cause: "technical_repair", action: "repair" });
    before.repair = { gate_attempts: 1, network_retries: 2, format_used: false, infra_reruns: 0, class: "code" };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(before));
    const identity = { run_id: r.runId, branch: before.branch, worktree: before.worktree, pr: before.pr };
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
    const done = await resumeScenario(r, {
      script: "clean.json",
      steps: (steps) =>
        steps
          .filter((s) => !s.role.startsWith("plan_"))
          .map((s) =>
            s.role !== "implement"
              ? s
              : { ...s, writes: { ...s.writes!, "src/math.js": `${s.writes!["src/math.js"]}\n// Correct the CI-only boundary.\n` }, output: { ...(s.output as object), package: "fix" } },
          ),
    });
    expect(done.result.result).toBe("done");
    expect(done.result).toMatchObject(identity);
    expect(done.resultFile.stop).toBeUndefined();
    const after = readState(r.runDir);
    expect(after.stop).toBeUndefined();
    expect(after).toMatchObject(identity);
    // A successful fix clears the gate counter. It must not drop the spent network budget or start a new run.
    expect(after.repair?.network_retries).toBe(2);
    expect(after.continuation_attempts).toBe(1);
    expect(after.pr).toBe(identity.pr);
    expect(done.github.prs).toHaveLength(1);
    expect(done.github.prs[0]!.url).toBe(identity.pr);
    // Recovery permission is not a protected-config approval.
    expect(done.result.risk_reasons ?? []).not.toContain("changes protected config (CI / factory)");
    expect(done.github.labels.map((l) => l.label)).not.toContain("factory:protected-config");
    expect(done.github.autoMerged.every((pr) => pr === identity.pr)).toBe(true);
  });

  it("a base merge conflict is an explicit decision, not a technical repair", async () => {
    let moved = false;
    const r = await runScenario({
      script: "clean.json",
      onCall: (_req, repo) => {
        if (moved || !_req.role.startsWith("review_")) return;
        moved = true;
        commitFile(repo, "src/math.js", "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function divide(a, b) {\n  return a / b;\n}\n", "main moved");
      },
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/merge conflict in src\/math\.js/);
    expect(r.resultFile.stop).toEqual({ cause: "explicit_decision", action: "decide" });
    expect(readState(r.runDir).stop).toEqual({ cause: "explicit_decision", action: "decide" });
    expect(r.github.autoMerged).toEqual([]);
  });
});

describe("worker uses the stored stop cause, not the reason text", () => {
  function outcome(repo: string, issueNo: number, result: RunResult["result"], reason: string, extra: Partial<RunResult> = {}): RunResult {
    return {
      run_id: `20261029-120000-${issueNo.toString(16).padStart(6, "0")}`,
      repo,
      task: `#${issueNo}`,
      type: "feature",
      lane: "standard",
      result,
      risk: null,
      merge_policy: null,
      pr: null,
      rounds: 0,
      minutes: 0,
      cost_usd: 0,
      reason,
      branch: null,
      worktree: null,
      run_dir: "",
      ...extra,
    };
  }

  function gate(): { start: StartRun; calls: number[]; release: (issueNo: number, result: RunResult) => void } {
    const calls: number[] = [];
    const pending = new Map<number, (r: RunResult) => void>();
    return {
      calls,
      release(issueNo, result) {
        const resolve = pending.get(issueNo);
        if (!resolve) throw new Error(`no pending start for #${issueNo}`);
        resolve(result);
      },
      start: ({ issue: issueNo }) => {
        calls.push(issueNo);
        let resolve!: (r: RunResult) => void;
        const done = new Promise<RunResult>((r) => {
          resolve = r;
        });
        pending.set(issueNo, resolve);
        return { done, pid: 0, runId: () => undefined, kill: () => undefined, unref: () => undefined };
      },
    };
  }

  async function enqueue(factoryHome: string, repo: string, github: FakeGitHub, issues: number[]): Promise<void> {
    for (const n of issues) github.issues.set(n, { number: n, title: `Issue ${n}`, body: "Do the work.", labels: ["factory-ready"], state: "open" } as Issue);
    const io: Io = { out: () => undefined, err: (s) => { throw new Error(s); } };
    expect(await queueAdd({ factoryHome, repo, issues, github }, io)).toBe(0);
  }

  async function waitFor(label: string, pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function entriesOf(factoryHome: string, repo: string): Promise<QueueEntry[]> {
    return loadQueueByKey(factoryHome, await repoQueueKey(repo))!.entries;
  }

  it("requeues a needs_human whose stop cause is transient_retry, without any legacy flag, keeping run and checkpoint", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-stop-"));
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    const g = gate();
    const ctl = new AbortController();
    const io: Io = { out: () => undefined, err: () => undefined };
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("first", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "needs_human", "provider stream aborted after 4 retries: premature EOF; factory resume x", { stop: { cause: "transient_retry", action: "retry" } }));
      await waitFor("issue 2 takes the freed slot", () => g.calls.length === 2);
      await waitFor("requeued behind the queue", async () => (await entriesOf(factoryHome, repo)).some((e) => e.issue === 1 && e.status === "pending"));
      const entry = (await entriesOf(factoryHome, repo)).find((e) => e.issue === 1);
      // An actionable cause keeps the original run and checkpoint for the next attempt.
      expect(entry).toMatchObject({ status: "pending", requeues: 1, run_id: "20261029-120000-000001" });
      expect(g.calls).toEqual([1, 2]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("parks an explicit_decision stop without a slot and never auto-resumes it", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-stop-"));
    const github = new FakeGitHub();
    await enqueue(factoryHome, repo, github, [1, 2]);
    const g = gate();
    const ctl = new AbortController();
    const io: Io = { out: () => undefined, err: () => undefined };
    const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io });
    try {
      await waitFor("first", () => g.calls.length === 1);
      g.release(1, outcome(repo, 1, "needs_human", "plan needs input", { stop: { cause: "explicit_decision", action: "decide" } }));
      await waitFor("issue 2 starts", () => g.calls.length === 2);
      g.release(2, outcome(repo, 2, "done", "", { pr: "https://github.test/pr/2" }));
      await worker;
      const entries = await entriesOf(factoryHome, repo);
      const parked = entries.find((e) => e.issue === 1)!;
      expect(parked).toMatchObject({ status: "parked" });
      expect(parked.requeues).toBeUndefined();
      expect(g.calls.filter((n) => n === 1)).toEqual([1]);
    } finally {
      ctl.abort();
      await worker.catch(() => undefined);
    }
  });

  it("the stored cause outranks a stale legacy transient flag", () => {
    const repo = "/r";
    const e: QueueEntry = { issue: 1, status: "running", added_at: "2026-01-01T00:00:00Z", run_id: "20261029-120000-000001" };
    const q: QueueFile = { version: 1, repo, repo_key: "k", entries: [e] };
    const result = { ...outcome(repo, 1, "needs_human", "paused: operator pause", { stop: { cause: "human_approval", action: "approve" }, pr: "https://github.test/pr/9" }), transient: true } as RunResult;
    expect(applyOutcome(q, e, result, { transient: true })).toBe("parked");
    expect(e.status).toBe("parked");
    expect(e.requeues).toBeUndefined();
  });

  it("a technical_repair stop keeps run id and checkpoint while parked", () => {
    const repo = "/r";
    const e: QueueEntry = { issue: 1, status: "running", added_at: "2026-01-01T00:00:00Z" };
    const q: QueueFile = { version: 1, repo, repo_key: "k", entries: [e] };
    const result = outcome(repo, 1, "needs_human", "CI on the PR head (aaaaaaaa) is red", { stop: { cause: "technical_repair", action: "repair" } });
    expect(applyOutcome(q, e, result)).toBe("parked");
    expect(e.run_id).toBe("20261029-120000-000001");
  });

  function parked(stop: unknown, transient = false): QueueEntry {
    const repo = "/r";
    const e: QueueEntry = { issue: 1, status: "running", added_at: "2026-01-01T00:00:00Z", run_id: "20261029-120000-000001" };
    const q: QueueFile = { version: 1, repo, repo_key: "k", entries: [e] };
    const result = {
      ...outcome(repo, 1, "needs_human", "CI on the PR head is red; technical repair", { ...(stop ? { stop: stop as RunResult["stop"] } : {}), pr: "https://github.test/pr/9" }),
      ...(transient ? { transient: true } : {}),
    } as RunResult;
    applyOutcome(q, e, result, { transient });
    return e;
  }

  it("rejects a cause/action pair the schema does not canonically bind", () => {
    const minimal = {
      run_id: "20261029-120000-000001", repo: "/r", task: "#1", type: "feature" as const, lane: "standard" as const,
      result: "needs_human" as const, risk: null, merge_policy: null, pr: null, rounds: 0, minutes: 0, cost_usd: 0,
      reason: "x", branch: null, worktree: null, run_dir: "/tmp/r",
    };
    expect(ResultSchema.safeParse({ ...minimal, stop: { cause: "transient_retry", action: "repair" } }).success).toBe(false);
    expect(ResultSchema.safeParse({ ...minimal, stop: { cause: "transient_retry", action: "retry" } }).success).toBe(true);
    for (const cause of STOP_CAUSES) {
      expect(stopFor(cause), cause).toEqual({ cause, action: STOP_ACTION[cause] });
      expect(ResultSchema.safeParse({ ...minimal, stop: { cause, action: STOP_ACTION[cause] } }).success, cause).toBe(true);
    }
    const restarted = { ...minimal, stop: { cause: "budget_exhausted", action: "restart" } };
    expect(ResultSchema.safeParse(restarted).success).toBe(false);
    expect(stopCauseOf({ cause: "transient_retry", action: "none" })).toBeUndefined();
    expect(stopCauseOf({ cause: "technical_repair" })).toBeUndefined();
    expect(stopCauseOf(undefined)).toBeUndefined();
  });

  it("present malformed stop metadata fails closed instead of honoring a stale transient flag", () => {
    const mismatch = parked({ cause: "transient_retry", action: "none" }, true);
    expect(mismatch).toMatchObject({ status: "parked" });
    expect(mismatch.requeues).toBeUndefined();
    const missingAction = parked({ cause: "transient_retry" }, true);
    expect(missingAction.status).toBe("parked");
    expect(missingAction.requeues).toBeUndefined();
    const restart = parked({ cause: "budget_exhausted", action: "restart" }, true);
    expect(restart.status).toBe("parked");
    expect(restart.requeues).toBeUndefined();
  });

  it("contradictory canonical stops fail closed on requeue", async () => {
    const hostile = [
      { cause: "human_approval", action: "approve" },
      { cause: "budget_exhausted", action: "decide" },
      { cause: "unknown", action: "none" },
    ] as const;
    for (const stateStop of hostile) {
      const repo = createFixtureRepo();
      const factoryHome = mkdtempSync(join(tmpdir(), "factory-stop-"));
      const github = new FakeGitHub();
      await enqueue(factoryHome, repo, github, [1, 2]);
      const g = gate();
      const ctl = new AbortController();
      const worker = runQueue({ factoryHome, github, repo, slots: 1, pollMs: 15, signal: ctl.signal, start: g.start, io: { out: () => undefined, err: () => undefined } });
      try {
        await waitFor(`${stateStop.cause} first`, () => g.calls.length === 1);
        const result = outcome(repo, 1, "needs_human", "provider stream aborted after 4 retries", { stop: { cause: "transient_retry", action: "retry" } });
        const dir = join(factoryHome, "runs", result.run_id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "state.json"), JSON.stringify({ stop: stateStop, transient: true }));
        g.release(1, result);
        await waitFor(`${stateStop.cause} settled`, async () => {
          const row = (await entriesOf(factoryHome, repo)).find((e) => e.issue === 1);
          return row?.status === "parked" || row?.status === "pending";
        });
        const row = (await entriesOf(factoryHome, repo)).find((e) => e.issue === 1)!;
        expect(row, stateStop.cause).toMatchObject({ status: "parked" });
        expect(row.requeues, stateStop.cause).toBeUndefined();
        expect(g.calls.filter((n) => n === 1), stateStop.cause).toEqual([1]);
        await waitFor(`${stateStop.cause} slot`, () => g.calls.includes(2));
      } finally {
        ctl.abort();
        await worker.catch(() => undefined);
      }
    }
  });

  it("a legacy transient flag still requeues only when no stop metadata is present", () => {
    const legacy = parked(undefined, true);
    expect(legacy).toMatchObject({ status: "pending", requeues: 1 });
    const unclassified = parked(undefined, false);
    expect(unclassified.status).toBe("parked");
    expect(unclassified.requeues).toBeUndefined();
  });

  it("provider_window_wait does not requeue and does not schedule a reset", () => {
    const waiting = parked({ cause: "provider_window_wait", action: "wait" }, true);
    expect(waiting.status).toBe("parked");
    expect(waiting.requeues).toBeUndefined();
  });
});

describe("status explains exhausted recovery", () => {
  function fakeRun(home: string, id: string, state: Record<string, unknown>): void {
    const dir = join(home, "runs", id);
    mkdirSync(dir, { recursive: true });
    const base = {
      version: 1, run_id: id, repo: "/r", task: { ref: `text:${id}.md` }, no_pr: false, step: "implement", result: "needs_human", reason: "",
      branch: "factory/1-x", worktree: "/r/wt", pr: null, lane: "standard", packages: {}, failures: {}, handoffs: [], rounds: 0, findings: [], gate_count: 0, updated_at: new Date().toISOString(),
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...base, ...state }));
  }

  it("names the spent budgets when the stop cause is budget_exhausted", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const id = "20261029-080000-0000a1";
    fakeRun(home, id, {
      reason: "repair exhausted: class=code attempts=3/3 checkpoint=abcdef123456",
      repair: { gate_attempts: 3, network_retries: 0, format_used: false, infra_reruns: 0, class: "code" },
      continuation_attempts: 2,
      stop: { cause: "budget_exhausted", action: "decide" },
    });
    const report = await statusReport({ factoryHome: home, github: new FakeGitHub() });
    const row = report.waiting.find((w) => w.run_id === id);
    expect(row?.reason).toContain("budgets spent");
    expect(row?.reason).toContain("not reset");
    expect(row?.reason).toContain("explicit grant required");
    expect(row?.reason).toContain("gate repair 3/3");
    expect(row?.reason).toContain("post-push repair 2/2");
    expect(renderStatus(report)).toContain("explicit grant required");
    expect(report.brief.waiting_on.find((w) => w.detail.includes("gate repair 3/3"))?.class).toBe("human_decision");
    expect(report.brief.waiting_on.some((w) => w.class === "technical_repair")).toBe(false);
  });

  it("a budget_exhausted stop stored with action restart is not a recoverable cause", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const id = "20261029-080000-0000a3";
    fakeRun(home, id, { reason: "some unrelated wording", stop: { cause: "budget_exhausted", action: "restart" } });
    const report = await statusReport({ factoryHome: home, github: new FakeGitHub() });
    expect(stopCauseOf({ cause: "budget_exhausted", action: "restart" })).toBeUndefined();
    const row = report.waiting.find((w) => w.run_id === id);
    expect(row?.reason).toBe("some unrelated wording");
    expect(row?.reason).not.toContain("explicit grant required");
    expect(row?.reason).not.toContain("not reset");
  });

  it("classifies a stored provider_window_wait as provider without reading the text", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const id = "20261029-080000-0000a2";
    // A stored window-reset cause, not a 429. #179 does not schedule the reset.
    fakeRun(home, id, { reason: "some unrelated wording", stop: { cause: "provider_window_wait", action: "wait" } });
    const report = await statusReport({ factoryHome: home, github: new FakeGitHub() });
    expect(report.brief.waiting_on.find((w) => w.detail.includes("some unrelated wording"))?.class).toBe("provider");
  });
});

describe("syncBase failure kinds", () => {
  it("maps a real conflict to an explicit decision and an ambiguous merge failure closed", () => {
    expect(stopCauseForMergeFailure(["src/math.js"])).toBe("explicit_decision");
    expect(stopCauseForMergeFailure([])).toBe("unknown");
    expect(stopCauseForSyncFailure("conflict")).toBe("explicit_decision");
    expect(stopCauseForSyncFailure("ambiguous")).toBe("unknown");
    expect(stopCauseForSyncFailure("gates", { checks: [{ status: "fail" }] })).toBe("technical_repair");
    expect(stopCauseForSyncFailure("gates", { checks: [{ status: "timeout" }, { status: "fail" }] })).toBe("unknown");
  });
});
