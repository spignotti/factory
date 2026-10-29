import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findHeadlessShell } from "../../src/evaluate/browser.js";
import { createSandbox, hostProbe, type Sandbox } from "../../src/sandbox/sandbox.js";
import type { EvaluateReport } from "../../src/steps/evaluate.js";
import { addOrigin, gitIn } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const browser = findHeadlessShell() !== undefined;
const realSandbox = ((): Sandbox | undefined => {
  try {
    return createSandbox("required", hostProbe);
  } catch {
    return undefined;
  }
})();

/** A GitHub-looking origin that resolves to a local bare repo (git `insteadOf`), so links get a slug. */
function githubOrigin(repo: string): string {
  const bare = addOrigin(repo);
  gitIn(repo, "remote", "set-url", "origin", "https://github.com/acme/tours.git");
  gitIn(repo, "config", "url." + bare + ".insteadOf", "https://github.com/acme/tours.git");
  return bare;
}

const report = (runDir: string, round: number) => JSON.parse(readFileSync(join(runDir, `evaluate-${round}.json`), "utf8")) as EvaluateReport;

describe.skipIf(!browser)("evaluate (ui fixture, real headless shell, fake LLM)", () => {
  for (const jailed of [false, true]) {
    it.skipIf(jailed && !realSandbox)(`evaluator criterion met with browser tools; base vs HEAD diff; evidence on factory-evidence and in the PR${jailed ? " (sandboxed)" : ""}`, async () => {
      let bare = "";
      const r = await runScenario({
        fixture: "ui-repo",
        script: "ui-clean.json",
        task: "subtitle.md",
        setup: (repo) => void (bare = githubOrigin(repo)),
        deps: jailed ? { sandbox: realSandbox } : {},
      });
      expect(r.result).toMatchObject({ result: "done" });
      expect(r.runner.remaining()).toEqual({});
      const ev = report(r.runDir, 1);
      expect(ev.flows).toEqual([]);
      expect(ev.criteria).toEqual([{ id: "A1", met: true, note: "opened /, #subtitle reads Guided tours", screenshot: "r1-A1.png" }]);
      expect(ev.review.findings).toEqual([]);
      const home = ev.pages.find((p) => p.page === "/")!;
      expect(home).toMatchObject({ device: "Desktop Chrome", head: "r1-desktop-chrome-root.png", base: "base-desktop-chrome-root.png", new_console: [], new_network: [] });
      expect(home.diff_ratio).toBeGreaterThan(0);
      const files = readdirSync(join(r.runDir, "evidence"));
      expect(files).toEqual(expect.arrayContaining(["r1-A1.png", home.diff!, "r1-session.webm", "r1-session.gif"]));
      // The fake evaluator really drove the browser.
      const evalCall = r.runner.calls.find((c) => c.role === "evaluate")!;
      expect(evalCall.toolResults).toEqual([
        { tool: "goto", text: expect.stringMatching(/^200 http:\/\/127\.0\.0\.1:\d+\/ — Tours$/) },
        { tool: "text", text: "Guided tours" },
        { tool: "screenshot", text: "saved r1-A1.png" },
      ]);
      // Evaluate ran before the reviewers.
      const order = r.events.filter((e) => e.event === "step_started").map((e) => e.step);
      expect(order.indexOf("evaluate")).toBeLessThan(order.indexOf("review"));

      // Evidence: pinned links into the orphan branch, embedded in the PR.
      const tip = gitIn(bare, "rev-parse", "factory-evidence").trim();
      expect(gitIn(bare, "ls-tree", "-r", "--name-only", "factory-evidence").trim().split("\n")).toEqual(expect.arrayContaining([`${r.runId}/r1-A1.png`, `${r.runId}/r1-session.gif`]));
      const body = r.github.prs[0]!.body;
      const link = (f: string) => `https://github.com/acme/tours/blob/${tip}/${r.runId}/${f}?raw=true`;
      expect(body).toContain(`| [x] | A1 | The home page shows the subtitle Guided tours | evaluator | evaluator: met, [screenshot](${link("r1-A1.png")}) |`);
      expect(body).toContain("## Evaluation (round 1)");
      expect(body).toContain(`![evaluator session](${link("r1-session.gif")})`);
      expect(body).toContain(`[diff](${link(home.diff!)})`);
      expect(readdirSync(join(r.factoryHome, "ports"))).toEqual([]);
    }, 180_000);
  }

  it("a red recorded flow in an area without changes_flows is a regression bug: reviewers skip that round, fix, done", async () => {
    const r = await runScenario({ fixture: "ui-repo", script: "ui-regression.json", task: "rename-tour.md" });
    expect(r.result).toMatchObject({ result: "done" });
    expect(r.runner.remaining()).toEqual({});
    const first = report(r.runDir, 1);
    expect(first.areas).toEqual(["tours"]);
    expect(first.flows).toEqual([expect.objectContaining({ area: "tours", status: "fail", changes_flows: false, output: expect.stringContaining("Alps tour missing") })]);
    expect(first.review.findings).toEqual([expect.objectContaining({ severity: "bug", claim: "regression: recorded flow of area tours fails (no package changes its flows)" })]);
    expect(first.pages.map((p) => p.page)).toEqual(["/", "/tours"]);
    // Round 1: no reviewer ran (the evaluator bug went straight to fix); they ran once, in round 2.
    const rounds = r.events.filter((e) => e.event === "round_finished").map((e) => e.data);
    expect(rounds[0]).toMatchObject({ round: 1, review_skipped: true, open_bugs: 1 });
    expect(rounds[1]).toMatchObject({ round: 2, review_skipped: false, open: 0 });
    const reviewerCalls = r.runner.calls.filter((c) => c.role.startsWith("review_"));
    expect(reviewerCalls).toHaveLength(2);
    const second = report(r.runDir, 2);
    expect(second.flows).toEqual([expect.objectContaining({ status: "pass" })]);
    expect(second.review.prior).toEqual([{ finding_id: "R1-evaluator-1", verdict: "resolved" }]);
    const merged = JSON.parse(readFileSync(join(r.runDir, "merged-2.json"), "utf8")) as { findings: { id: string; status: string }[] };
    expect(merged.findings).toEqual([expect.objectContaining({ id: "R1-evaluator-1", status: "resolved" })]);
    // No origin: evidence stays local and the PR says why.
    expect(r.github.prs[0]!.body).toMatch(/> evidence not published: /);
    expect(existsSync(join(r.runDir, "evidence", "base-captures.json"))).toBe(true);
  }, 180_000);
});
