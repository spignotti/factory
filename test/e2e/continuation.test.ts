import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState } from "../../src/pipeline/state.js";
import { issueRevision } from "../../src/queue/admit.js";
import { updateQueue } from "../../src/queue/store.js";
import { runQueue } from "../../src/queue/worker.js";
import { FIXTURES, commitFile } from "../helpers/repo.js";
import { resumeScenario, runScenario } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");
const issue = { number: 7, title: "Multiply", body, labels: ["factory-ready"] };

async function redPr() {
  let checks = 0;
  return runScenario({ script: "clean.json", options: { issue: 7 }, patch: (cfg) => { cfg.merge = { auto_merge_max_risk: "low" }; }, github: (gh) => {
    gh.issues.set(7, issue);
    gh.baseStatus = async () => checks++ === 0 ? "none" : "red";
  } });
}

describe("bounded post-push continuation", () => {
  it("reuses a test invocation that already supplied gate evidence", async () => {
    const counter = join(mkdtempSync(join(tmpdir(), "evidence-count-")), "runs");
    const r = await runScenario({ script: "clean.json", github: (gh) => { gh.status = "green"; },
      patch: (cfg) => { cfg.checks = [{ name: "unit", run: "node --test test/multiply.test.js", tier: "fast" }]; },
      steps: (steps) => steps.map((s) => s.role !== "implement" ? s : { ...s, writes: { ...s.writes,
        "test/multiply.test.js": `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "ran\\n");\n${s.writes!["test/multiply.test.js"]}`,
      } }),
    });
    expect(r.result.result).toBe("done");
    // One fast gate and one final full gate; neither adds a duplicate evidence invocation.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });
  it("repairs a CI-only assertion on the same PR, then reviews the actual fixed commit", async () => {
    const r = await redPr();
    expect(r.result.result).toBe("needs_human");
    expect(readState(r.runDir).continuation?.kind).toBe("ci");
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "unit", output_tail: "AssertionError: CI-only boundary is wrong" }];
    await updateQueue(r.factoryHome, r.repo, (q) => q.entries.push({
      issue: 7, status: "parked", added_at: new Date().toISOString(), run_id: r.runId,
      issue_rev: issueRevision(issue.title, issue.body), pr: r.result.pr!,
    }));
    let resumed: Awaited<ReturnType<typeof resumeScenario>> | undefined;
    const starts: string[] = [];
    await runQueue({ factoryHome: r.factoryHome, github: r.github, repo: r.repo, pollMs: 10,
      start: (req) => {
        expect(req.resumeRunId).toBe(r.runId);
        starts.push(req.resumeRunId!);
        const done = resumeScenario(r, { script: "clean.json", steps: (steps) => steps
          .filter((s) => !s.role.startsWith("plan_"))
          .map((s) => s.role !== "implement" ? s : { ...s,
            writes: { ...s.writes, "src/math.js": `${s.writes!["src/math.js"]}\n// Correct the CI-only boundary.\n` },
            output: { ...(s.output as object), package: "fix" },
          }) }).then((result) => { resumed = result; return result.result; });
        return { done, pid: 0, runId: () => r.runId, kill: () => {}, unref: () => {} };
      },
    });
    expect(starts).toEqual([r.runId]);
    expect(resumed!.result).toMatchObject({ result: "done", pr: r.result.pr, run_id: r.runId });
    expect(resumed!.runner.calls.map((c) => c.role)).toEqual(["implement", "review_plan", "review_simplicity", "pr_writer"]);
    expect(r.github.prs).toHaveLength(1);
    const st = readState(r.runDir);
    expect(st.continuation_attempts).toBe(1);
    expect(st.continuation).toBeUndefined();
    expect(st.reviewed_sha).toBe(st.approved_sha);
    expect(st.reviewed_sha).not.toBe((JSON.parse(r.file("ci-failure-1.json")) as { sha: string }).sha);
  });

  it("does not reset the persisted attempt budget or edit code for an unknown CI failure", async () => {
    const r = await redPr();
    r.github.baseStatus = async () => "green";
    r.github.failures = [{ name: "external", output_tail: "No actionable diagnosis" }];
    const resumed = await resumeScenario(r, { script: "clean.json" });
    expect(resumed.result.result).toBe("needs_human");
    expect(resumed.runner.calls).toEqual([]);
    expect(readState(r.runDir).continuation_attempts).toBe(1);
    const st = readState(r.runDir);
    st.continuation_attempts = 2;
    st.continuation = { kind: "ci", sha: st.reviewed_sha! };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    const exhausted = await resumeScenario(r, { script: "clean.json" });
    expect(exhausted.result.reason).toMatch(/exhausted/);
    expect(exhausted.runner.calls).toEqual([]);
    expect(readState(r.runDir).continuation_attempts).toBe(2);
  });

  it("revalidates a moved base with gates and delta review instead of stamping a review SHA", async () => {
    const r = await runScenario({ script: "clean.json" });
    const prior = readState(r.runDir).reviewed_sha;
    commitFile(r.repo, "src/new-base.js", "export const fresh = true;\n", "feat: base moved");
    const st = readState(r.runDir);
    st.continuation = { kind: "base", sha: st.approved_sha! };
    writeFileSync(join(r.runDir, "state.json"), JSON.stringify(st));
    const next = await resumeScenario(r, { script: "clean.json", steps: (s) => s.filter((x) => ["review_plan", "review_simplicity", "pr_writer"].includes(x.role)) });
    expect(next.result.result).toBe("done");
    expect(next.runner.calls.map((c) => c.role)).toEqual(["review_plan", "review_simplicity", "pr_writer"]);
    expect(next.runner.calls[0]!.prompt).toContain("incremental_diff");
    expect(readState(r.runDir).reviewed_sha).not.toBe(prior);
    expect(r.github.updatedBranches).toEqual([]);
  });

  it("leaves uncommitted work untouched during automatic recovery", async () => {
    const r = await redPr();
    writeFileSync(join(r.runDir, "worktree/src/personal.js"), "uncommitted\n");
    const next = await resumeScenario(r, { script: "clean.json" });
    expect(next.result.reason).toMatch(/uncommitted changes/);
    expect(next.runner.calls).toEqual([]);
    expect(readFileSync(join(r.runDir, "worktree/src/personal.js"), "utf8")).toBe("uncommitted\n");
  });
});
