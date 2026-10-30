import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { Interrupted } from "../../src/interrupt.js";
import { acquireRepoLock } from "../../src/pipeline/lock.js";
import { readState } from "../../src/pipeline/state.js";
import { addOrigin, commitFile } from "../helpers/repo.js";
import { resumeScenario, runScenario, SECRET } from "../helpers/scenario.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const gitAs = (cwd: string, ...args: string[]) => git(cwd, "-c", "user.name=human", "-c", "user.email=human@test", ...args);
const roles = (...keep: string[]) => (steps: FakeStep[]) => steps.filter((s) => keep.includes(s.role));

const MULTIPLY = "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
const DIVIDE = "export function sum(a, b) {\n  return a + b;\n}\n\nexport function max(a, b) {\n  return a < b ? a : b;\n}\n\nexport function divide(a, b) {\n  return a / b;\n}\n";
const BOTH = MULTIPLY + "\nexport function divide(a, b) {\n  return a / b;\n}\n";
const MULTIPLY_TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { multiply } from "../src/math.js";\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n';

describe("state.json", () => {
  it("is written after every step and ends at finished; a finished run cannot be resumed", async () => {
    const r = await runScenario({ script: "clean.json" });
    expect(r.result.result).toBe("done");
    const st = readState(r.runDir);
    expect(st).toMatchObject({ run_id: r.runId, step: "finished", result: "done", packages: { P1: "done" }, pr: r.result.pr, rounds: 1 });
    expect(st.branch).toBe(r.result.branch);
    await expect(resumeScenario(r, { script: "clean.json" })).rejects.toThrow(/finished/);
  });

  it("is redacted like every other run file", async () => {
    const r = await runScenario({
      script: "invalid-handoff.json",
      steps: (s) => s.map((x) => (x.role === "implement" ? { ...x, raw: `no handoff, token ${SECRET}` } : x)),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.file("state.json")).not.toContain(SECRET);
  });
});

describe("factory resume", () => {
  it("after a human fix: commits it, re-checks the gates, continues from implement and opens the PR", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.result.result).toBe("needs_human");
    expect(readState(r.runDir)).toMatchObject({ step: "implement", packages: { P1: "failed" } });
    const wt = join(r.runDir, "worktree");
    writeFileSync(join(wt, "src/math.js"), MULTIPLY);
    writeFileSync(join(wt, "test/multiply.test.js"), MULTIPLY_TEST);

    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(r2.result).toMatchObject({ result: "done", run_id: r.runId, branch: r.result.branch });
    expect(r2.runner.calls.map((c) => c.role)).toEqual(["implement", "review_plan", "review_simplicity", "pr_writer"]);
    expect(git(wt, "log", "--format=%s|%an", "main..HEAD")).toContain("fix: human changes before resume|factory-bot");
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(r2.github.prs).toHaveLength(1);
    expect(r2.github.prs[0]!.draft).toBe(false);
    expect(r2.events.some((e) => e.step === "resume" && e.data.human_changes_committed)).toBe(true);
    expect(readState(r.runDir)).toMatchObject({ step: "finished", result: "done", packages: { P1: "done" } });
    // events.jsonl is appended to, not replaced
    expect(r2.eventsText.startsWith(r.eventsText)).toBe(true);
  });

  it("after an interrupt: re-runs the unfinished package without re-planning", async () => {
    const ac = new AbortController();
    const r = await runScenario({
      script: "clean.json",
      deps: { signal: ac.signal },
      onCall: (req) => void (req.role === "implement" && ac.abort(new Interrupted("SIGTERM"))),
    });
    expect(r.result.result).toBe("failed");
    expect(readState(r.runDir).step).toBe("implement");
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(r2.result.result).toBe("done");
    expect(r2.runner.calls.some((c) => c.role === "plan_high")).toBe(false);
    // the interrupted agent's uncommitted leftovers are discarded, not committed as a human fix
    expect(r2.events.some((e) => e.step === "resume" && e.data.discarded_uncommitted)).toBe(true);
    expect(git(join(r.runDir, "worktree"), "log", "--format=%s", "main..HEAD")).toBe("feat(P1): multiply\n");
  });

  it("is refused while another run holds the repo lock and leaves result.json alone", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    const before = r.file("result.json");
    const release = acquireRepoLock(r.factoryHome, r.repo, "20261029-000000-cccccc")!;
    try {
      const r2 = await resumeScenario(r, { script: "clean.json" });
      expect(r2.result.result).toBe("locked");
      expect(r2.result.reason).toContain("20261029-000000-cccccc");
      expect(r2.runner.calls).toEqual([]);
    } finally {
      release();
    }
    expect(r.file("result.json")).toBe(before);
  });

  it("refuses a worktree with an unfinished merge", async () => {
    const r = await runScenario({
      script: "clean.json",
      onCall: (req, repo) => void (req.role === "review_plan" && commitFile(repo, "src/math.js", DIVIDE, "main moved")),
    });
    expect(r.result.result).toBe("needs_human");
    const wt = join(r.runDir, "worktree");
    expect(() => gitAs(wt, "merge", "main")).toThrow(); // conflict, left in progress
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("pr_writer") });
    expect(r2.result).toMatchObject({ result: "needs_human" });
    expect(r2.result.reason).toMatch(/^resume: a merge is in progress/);
  });

  it("merge conflict: still conflicting → needs_human again; resolved on the PR branch → plain push, PR updated and marked ready", async () => {
    let origin = "";
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => void (origin = addOrigin(repo)),
      github: (gh) => {
        gh.push = async (dir, branch) => {
          gh.pushes.push(branch);
          git(dir, "push", "-q", "-u", "origin", branch); // a real, non-forced push
        };
      },
      onCall: (req, repo) => {
        if (req.role !== "review_plan") return;
        commitFile(repo, "src/math.js", DIVIDE, "main moved");
        git(repo, "push", "-q", "origin", "main");
      },
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/merge conflict in src\/math\.js/);
    const branch = r.result.branch!;
    const firstPush = git(origin, "rev-parse", branch).trim();
    expect(r.github.prs[0]).toMatchObject({ draft: true });

    // nobody resolved it yet
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("pr_writer") });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/^resume: base main moved \([0-9a-f]{8}\): merge conflict in src\/math\.js$/);
    expect(r2.runner.calls).toEqual([]);

    // a human resolves the conflict on the PR branch (as if on GitHub)
    const clone = join(mkdtempSync(join(tmpdir(), "factory-human-")), "c");
    git(tmpdir(), "clone", "-q", "-b", branch, origin, clone);
    expect(() => gitAs(clone, "merge", "origin/main")).toThrow();
    writeFileSync(join(clone, "src/math.js"), BOTH);
    gitAs(clone, "add", "-A");
    gitAs(clone, "commit", "-q", "--no-edit");
    git(clone, "push", "-q", "origin", branch);

    const r3 = await resumeScenario(r, { script: "clean.json", steps: roles("pr_writer") });
    expect(r3.result).toMatchObject({ result: "done", pr: r.result.pr });
    expect(r3.runner.calls.map((c) => c.role)).toEqual(["pr_writer"]);
    expect(r3.github.prs).toHaveLength(1); // no second PR
    expect(r3.github.updates.map((u) => u.pr)).toEqual([r.result.pr]);
    expect(r3.github.readied).toEqual([r.result.pr]);
    const head = git(origin, "rev-parse", branch).trim();
    expect(git(origin, "merge-base", "--is-ancestor", firstPush, head)).toBe(""); // history kept, never forced
    expect(git(origin, "merge-base", "--is-ancestor", "main", head)).toBe("");
    expect(readFileSync(join(r.runDir, "worktree", "src/math.js"), "utf8")).toBe(BOTH);
    expect(r3.events.some((e) => e.step === "resume" && e.data.remote_branch_merged)).toBe(true);
  });
});

describe("notify hook on resume", () => {
  it("a resumed run notifies again when it finishes, and a locked resume notifies too", async () => {
    const sent: Record<string, unknown>[] = [];
    const deps = {
      notifyBackoffMs: [0],
      notifyFetch: async (_url: string, init: { body: string }) => (sent.push(JSON.parse(init.body) as Record<string, unknown>), { status: 200 }),
    };
    const r = await runScenario({
      script: "invalid-handoff.json",
      setup: (repo) => void git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"),
      before: (_repo, home) => writeFileSync(join(home, "notify.yaml"), "repos:\n  acme/widgets:\n    url: https://hooks.example.test/x\n    key: k-resume-0123456789\n", { mode: 0o600 }),
      deps,
    });
    expect(sent.map((p) => p.result)).toEqual(["needs_human"]);

    const release = acquireRepoLock(r.factoryHome, "https://github.com/acme/widgets.git", "20261029-000000-dddddd")!;
    try {
      expect((await resumeScenario(r, { script: "clean.json", deps })).result.result).toBe("locked");
    } finally {
      release();
    }
    expect(sent.map((p) => p.result)).toEqual(["needs_human", "locked"]);

    const wt = r.result.worktree!;
    writeFileSync(join(wt, "src/math.js"), MULTIPLY);
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer"), deps });
    expect(r2.result.result).toBe("done");
    expect(sent.map((p) => [p.run_id, p.result])).toEqual([[r.runId, "needs_human"], [r.runId, "locked"], [r.runId, "done"]]);
  });
});

describe("result.json across resumes", () => {
  it("is removed while a resume runs and rewritten with that attempt's outcome", async () => {
    const ac = new AbortController();
    const r = await runScenario({
      script: "clean.json",
      deps: { signal: ac.signal },
      onCall: (req) => void (req.role === "implement" && ac.abort(new Interrupted("SIGTERM"))),
    });
    expect(r.resultFile.result).toBe("failed");
    let duringPush: boolean | undefined;
    const push = r.github.push.bind(r.github);
    r.github.push = async (dir, branch) => {
      duringPush = existsSync(join(r.runDir, "result.json"));
      return push(dir, branch);
    };
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("implement", "review_plan", "review_simplicity", "pr_writer") });
    expect(duringPush).toBe(false);
    expect(r2.result.result).toBe("done");
    expect(r2.resultFile).toMatchObject({ result: "done", pr: r2.result.pr, run_id: r.runId });
    expect(readState(r.runDir)).toMatchObject({ step: "finished", result: "done" });
  });

  it("a resume that ends needs_human rewrites it too", async () => {
    const r = await runScenario({ script: "invalid-handoff.json" });
    expect(r.resultFile.result).toBe("needs_human");
    const r2 = await resumeScenario(r, { script: "invalid-handoff.json", steps: roles("implement") });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.resultFile).toEqual(r2.result);
  });
});

describe("idempotent PR step", () => {
  it("a push that errors after origin took it counts as pushed", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        const push = gh.push.bind(gh);
        gh.push = async (dir, branch) => {
          await push(dir, branch); // the server got it…
          throw new Error("fatal: unable to access 'https://github.com/x/y.git/': Connection timed out after 332242 milliseconds");
        };
      },
    });
    expect(r.result).toMatchObject({ result: "done" });
    expect(r.github.prs).toHaveLength(1);
    expect(r.events.some((e) => e.step === "finalize" && (e.data.push_error_ignored as { remote_sha?: string })?.remote_sha)).toBe(true);
  });

  it("a push that errors and did not land stays needs_human", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.push = async () => Promise.reject(new Error("Connection timed out"));
        gh.remoteShas.set("unrelated", "0".repeat(40));
      },
    });
    expect(r.result).toMatchObject({ result: "needs_human", pr: null });
    expect(r.result.reason).toMatch(/PR step failed: Connection timed out/);
  });

  it("an open PR on the branch at HEAD is adopted (updated, marked ready), not created twice", async () => {
    // Iris's run 20261030-125347-5b7ada: attempt 2's push timed out although it landed, the PR got opened
    // meanwhile; attempt 3's `gh pr create` then failed with "already exists".
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        const push = gh.push.bind(gh);
        gh.push = async (dir, branch) => {
          await push(dir, branch);
          gh.prs.push({ repoDir: dir, head: branch, base: "main", title: "opened elsewhere", body: "", draft: true, url: "https://github.test/pr/15" });
          throw new Error("Connection timed out");
        };
        gh.createPr = async () => Promise.reject(new Error("a pull request for branch already exists"));
      },
    });
    expect(r.result).toMatchObject({ result: "done", pr: "https://github.test/pr/15" });
    expect(r.resultFile.pr).toBe("https://github.test/pr/15");
    expect(r.github.prs).toHaveLength(1);
    expect(r.github.updates.map((u) => u.pr)).toEqual(["https://github.test/pr/15"]);
    expect(r.github.readied).toEqual(["https://github.test/pr/15"]);
    expect(readState(r.runDir)).toMatchObject({ step: "finished", pr: "https://github.test/pr/15", pr_draft: false });
    expect(r.events.some((e) => e.step === "finalize" && e.data.pr_adopted)).toBe(true);
  });

  it("a create that fails although the PR was opened adopts it", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        const create = gh.createPr.bind(gh);
        gh.createPr = async (req) => {
          await create(req);
          throw new Error("gh: timeout");
        };
      },
    });
    expect(r.result).toMatchObject({ result: "done", pr: "https://github.test/pr/1" });
    expect(r.github.prs).toHaveLength(1);
  });

  it("an open PR whose head is not the run's HEAD is not adopted", async () => {
    const r = await runScenario({
      script: "clean.json",
      github: (gh) => {
        gh.findOpenPr = async () => ({ url: "https://github.test/pr/99", draft: false, headSha: "f".repeat(40) });
      },
    });
    expect(r.result).toMatchObject({ result: "done", pr: "https://github.test/pr/1" });
    expect(r.github.updates).toEqual([]);
  });

  it("resume after a PR step failure adopts the PR instead of a second needs_human", async () => {
    const sent: Record<string, unknown>[] = [];
    const deps = {
      notifyBackoffMs: [0],
      notifyFetch: async (_url: string, init: { body: string }) => (sent.push(JSON.parse(init.body) as Record<string, unknown>), { status: 200 }),
    };
    let fail = true;
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => void git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"),
      before: (_repo, home) => writeFileSync(join(home, "notify.yaml"), "repos:\n  acme/widgets:\n    url: https://hooks.example.test/x\n    key: k-resume-0123456789\n", { mode: 0o600 }),
      deps,
      github: (gh) => {
        const create = gh.createPr.bind(gh);
        gh.createPr = async (req) => {
          const url = await create(req);
          if (fail) {
            // created, but the PR's head is not visible yet: the run cannot tell and stops
            gh.remoteShas.delete(req.head);
            throw new Error("gh: timeout");
          }
          return url;
        };
      },
    });
    expect(r.result.result).toBe("needs_human");
    fail = false;
    const r2 = await resumeScenario(r, { script: "clean.json", steps: roles("pr_writer"), deps });
    expect(r2.result).toMatchObject({ result: "done", pr: "https://github.test/pr/1" });
    expect(r2.github.prs).toHaveLength(1);
    expect(r2.resultFile.result).toBe("done");
    expect(sent.map((p) => p.result)).toEqual(["needs_human", "done"]);
  });
});
