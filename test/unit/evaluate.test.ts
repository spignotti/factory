import { describe, expect, it } from "vitest";
import type { TrackedFinding } from "../../src/pipeline/merge.js";
import { parseRepoConfig, placeholderTexts } from "../../src/schemas/repo.js";
import type { Finding } from "../../src/schemas/review.js";
import {
  affectedAreas,
  criteriaFindings,
  EvaluatorOutputSchema,
  evaluateApplies,
  flowFindings,
  normalizeEntry,
  pageFindings,
  priorVerdicts,
  slug,
  validateCriteria,
} from "../../src/steps/evaluate.js";

const repo = parseRepoConfig(`
ui: { start: "node server.mjs --port {port:app}", url: "http://127.0.0.1:{port:app}", paths: ["web/**"] }
verify:
  run: "node {files}"
  areas:
    - { name: tours, paths: ["web/tours/**"], flows: ["flows/tours.mjs"], pages: ["/tours"] }
    - { name: auth, paths: ["web/auth/**"], flows: ["flows/auth.mjs"] }
`);

describe("evaluate helpers", () => {
  it("schema defaults: devices, pages, verify.run is a placeholder text", () => {
    expect(repo.ui!.devices).toEqual(["Desktop Chrome"]);
    expect(repo.ui!.pages).toEqual(["/"]);
    expect(repo.verify.areas[1]!.pages).toEqual([]);
    expect(placeholderTexts(repo).map((t) => t.where)).toContain("verify run");
    expect(() => parseRepoConfig(`ui: { start: x, url: y, devices: [] }`)).toThrow();
  });

  it("applies only with a ui and a change under ui.paths (none = any change)", () => {
    expect(evaluateApplies(repo, ["web/tours/list.js"])).toBe(true);
    expect(evaluateApplies(repo, ["server/db.js"])).toBe(false);
    expect(evaluateApplies(parseRepoConfig("ui: { start: x, url: y }"), ["anything"])).toBe(true);
    expect(evaluateApplies(parseRepoConfig("ui: { start: x, url: y }"), [])).toBe(false);
    expect(evaluateApplies(parseRepoConfig("{}"), ["web/a.js"])).toBe(false);
  });

  it("affected areas by path; slugs", () => {
    expect(affectedAreas(repo, ["web/tours/a.js", "README.md"]).map((a) => a.name)).toEqual(["tours"]);
    expect(slug("/")).toBe("root");
    expect(slug("Pixel 7")).toBe("pixel-7");
    expect(slug("/tours/new?x=1")).toBe("tours-new-x-1");
  });

  it("normalizes origins, ports, queries, positions and hashes", () => {
    const o = "http://127.0.0.1:4100";
    expect(normalizeEntry("TypeError at http://127.0.0.1:4100/app.3f9a2b1c7d.js?v=2:10:5", o)).toBe("TypeError at /app.#.js");
    expect(normalizeEntry("fetch http://localhost:5173/api", o)).toBe(normalizeEntry("fetch http://127.0.0.1:4100/api", o));
  });

  it("flow failures are bugs; the claim tells a regression from a planned flow change", () => {
    const f = flowFindings([
      { area: "tours", files: ["flows/tours.mjs"], status: "fail", changes_flows: false, output: "AssertionError" },
      { area: "auth", files: ["flows/auth.mjs"], status: "fail", changes_flows: true },
      { area: "x", files: [], status: "pass", changes_flows: false },
      { area: "y", files: [], status: "skipped", changes_flows: false },
    ]);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.severity === "bug")).toBe(true);
    expect(f[0]!.claim).toMatch(/^regression: recorded flow of area tours fails/);
    expect(f[0]!.evidence).toBe("AssertionError");
    expect(f[1]!.claim).toMatch(/after the planned flow change/);
  });

  it("new console errors and failed requests are bugs with stable claims", () => {
    const f = pageFindings([
      {
        device: "Pixel 7",
        page: "/",
        head: "r1-pixel-7-root.png",
        new_console: [{ kind: "console", text: "boom", url: "http://127.0.0.1:4100/app.js" }],
        new_network: [{ method: "GET", url: "http://127.0.0.1:4100/api/tours?x=1", status: 500 }],
      },
    ]);
    expect(f.map((x) => x.claim)).toEqual(["new console error on / (Pixel 7): boom", "new failed request on / (Pixel 7): GET /api/tours → 500"]);
    expect(f.every((x) => x.severity === "bug")).toBe(true);
  });

  it("validates criteria: each answered once, with a screenshot actually taken, no unknown ids", () => {
    const out = EvaluatorOutputSchema.parse({ criteria: [{ id: "A1", met: true, screenshot: "A1" }, { id: "A3", met: false, screenshot: "x" }] });
    expect(validateCriteria(out, ["A1", "A2"], new Map([["A1", "r1-A1.png"]]))).toEqual([
      "criterion A2: answer it exactly once",
      "unknown criterion A3",
    ]);
    expect(validateCriteria(out, ["A1"], new Map())).toContain('criterion A1: screenshot "A1" was not taken (call screenshot with that name)');
  });

  it("unmet criteria become bugs", () => {
    const f = criteriaFindings([
      { id: "A1", met: true, note: "ok" },
      { id: "A2", met: false, note: "button missing" },
    ]);
    expect(f).toEqual([expect.objectContaining({ severity: "bug", claim: "acceptance criterion A2 is not met in the running app", evidence: "button missing" })]);
  });

  it("prior verdicts in code: found again → still open (or reject_wontfix), else resolved", () => {
    const base: Finding = { severity: "bug", file: "", line: 0, claim: "acceptance criterion A2 is not met in the running app", evidence: "", fix: "", checkable: "no", check_sketch: "" };
    const prior: TrackedFinding[] = [
      { ...base, id: "F1", reviewer: "evaluator", round: 1, status: "open" },
      { ...base, claim: "regression: recorded flow of area tours fails (no package changes its flows)", id: "F2", reviewer: "evaluator", round: 1, status: "open" },
      { ...base, claim: "new console error on / (Desktop Chrome): boom", id: "F3", reviewer: "evaluator", round: 1, status: "open", response: { finding_id: "F3", status: "wontfix", note: "upstream" } as never },
      { ...base, id: "F4", reviewer: "security", round: 1, status: "open" },
      { ...base, id: "F5", reviewer: "evaluator", round: 1, status: "resolved" },
    ];
    const now: Finding[] = [{ ...base, evidence: "different note" }, { ...base, claim: "New console error on / (Desktop Chrome): boom!" }];
    expect(priorVerdicts(prior, now)).toEqual([
      { finding_id: "F1", verdict: "still_open" },
      { finding_id: "F2", verdict: "resolved" },
      { finding_id: "F3", verdict: "reject_wontfix" },
    ]);
  });
});
