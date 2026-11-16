import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeGitHub } from "../../src/gh.js";
import { readState } from "../../src/pipeline/state.js";
import { MAX_COMMENTS_CHARS, renderIssueComments } from "../../src/steps/intake.js";
import { FIXTURES } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const body = readFileSync(join(FIXTURES, "tasks/multiply.md"), "utf8");

function withIssue(gh: FakeGitHub): void {
  gh.issues.set(7, { number: 7, title: "Multiply", body, labels: ["factory-ready", "prio:high"] });
  gh.comments.set(7, [
    { author: "maintainer", association: "OWNER", body: "Keep it to two arguments.", created_at: "2026-11-15T09:00:00Z" },
    { author: "spam", association: "NONE", body: "hidden", created_at: "2026-11-15T09:30:00Z", minimized: true },
  ]);
}

describe("questions on the issue", () => {
  it("posts the plan questions once as an issue comment and swaps factory-ready for needs-input", async () => {
    const r = await runScenario({ script: "needs-input.json", options: { issue: 7 }, github: withIssue });
    expect(r.result.result).toBe("needs_input");
    expect(r.resultFile.stop).toEqual({ cause: "explicit_decision", action: "decide" });
    expect(r.resultFile.questions_posted).toBe(true);
    const comments = r.github.comments.get(7)!;
    expect(comments).toHaveLength(3);
    const posted = comments[2]!.body;
    expect(posted).toContain("1. Should multiply accept more than two arguments?");
    expect(posted).toContain("remove the `needs-input` label and add `factory-ready` again");
    expect(posted).toContain(`<!-- factory:questions run=${r.runId} -->`);
    expect(r.github.issues.get(7)!.labels).toEqual(["prio:high", "needs-input"]);

    // The planner saw the comments under their own heading; the task text stays title and body.
    const plan = r.runner.calls.find((c) => c.role === "plan_high")!;
    expect(plan.prompt).toContain("## Issue comments (oldest first)");
    expect(plan.prompt).toContain("### maintainer (owner), 2026-11-15T09:00:00Z\n\nKeep it to two arguments.");
    expect(plan.prompt).not.toContain("hidden");
    expect(readState(r.runDir).task.text).toBe(`# Multiply\n\n${body}`);
  });

  it("a GitHub failure while posting keeps the needs_input result and records it", async () => {
    const r = await runScenario({
      script: "needs-input.json",
      options: { issue: 7 },
      github: (gh) => {
        withIssue(gh);
        gh.commentError = "HTTP 502";
      },
    });
    expect(r.result.result).toBe("needs_input");
    expect(r.resultFile.reason).toBe("plan needs input");
    expect(r.resultFile.stop).toEqual({ cause: "explicit_decision", action: "decide" });
    expect(r.resultFile.questions).toEqual(["Should multiply accept more than two arguments?"]);
    expect(r.resultFile.questions_posted).toBe(false);
    expect(r.github.comments.get(7)).toHaveLength(2);
    expect(r.github.issues.get(7)!.labels).toEqual(["factory-ready", "prio:high"]);
    expect(r.eventsText).toContain('"questions_posted":false');
    expect(r.eventsText).toContain("HTTP 502");
  });

  it("a text task asks without posting", async () => {
    const r = await runScenario({ script: "needs-input.json" });
    expect(r.result.result).toBe("needs_input");
    expect(r.resultFile).not.toHaveProperty("questions_posted");
  });

  it("plan assumptions reach the PR body and result.json", async () => {
    const assumptions = ["Integers only; floats are a follow-up.", "No input validation."];
    const r = await runScenario({
      script: "clean.json",
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, output: { ...(s.output as object), assumptions } } : s)),
    });
    expect(r.result.result).toBe("done");
    expect(r.resultFile.assumptions).toEqual(assumptions);
    const pr = r.github.prs[0]!.body;
    expect(pr).toContain("## Assumptions");
    expect(pr).toContain("- Integers only; floats are a follow-up.\n- No input validation.");
  });

  it("a plan without assumptions has no Assumptions section", async () => {
    const r = await runScenario({ script: "clean.json" });
    expect(r.result.result).toBe("done");
    expect(r.resultFile).not.toHaveProperty("assumptions");
    expect(r.github.prs[0]!.body).not.toContain("## Assumptions");
  });
});

describe("renderIssueComments", () => {
  it("keeps the newest comments when the thread is long and says how many were left out", () => {
    const long = "x".repeat(3_000);
    const comments = Array.from({ length: 10 }, (_, i) => ({ author: `u${i}`, body: `${i} ${long}`, created_at: `2026-11-1${i}T00:00:00Z` }));
    const text = renderIssueComments(comments);
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENTS_CHARS + 200);
    expect(text).toMatch(/^## Issue comments \(oldest first\)\n\n\(\d+ earlier comments omitted\)/);
    expect(text).toContain("### u9");
    expect(text).not.toContain("### u0,");
    expect(text.indexOf("### u8")).toBeLessThan(text.indexOf("### u9"));
  });

  it("is empty without visible comments", () => {
    expect(renderIssueComments([])).toBe("");
    expect(renderIssueComments([{ author: "a", body: "  ", created_at: "" }])).toBe("");
  });
});
