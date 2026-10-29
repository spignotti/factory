import { describe, expect, it } from "vitest";
import { criterionEvidence, evaluationMarkdown } from "../../src/evaluate/pr.js";
import type { EvaluateReport } from "../../src/steps/evaluate.js";

const report: EvaluateReport = {
  round: 2,
  url: "http://127.0.0.1:4100",
  devices: ["Pixel 7"],
  areas: ["tours"],
  flows: [{ area: "tours", files: ["flows/tours.mjs"], status: "pass", changes_flows: false }],
  pages: [
    { device: "Pixel 7", page: "/", head: "r2-pixel-7-root.png", base: "base-pixel-7-root.png", diff: "r2-diff-pixel-7-root.png", diff_ratio: 0.0123, new_console: [], new_network: [] },
    { device: "Pixel 7", page: "/tours", head: "r2-pixel-7-tours.png", base: "base-pixel-7-tours.png", diff_ratio: 0, new_console: [{ kind: "console", text: "x", url: "" }], new_network: [] },
  ],
  criteria: [
    { id: "A1", met: true, screenshot: "r2-A1.png", note: "ok" },
    { id: "A2", met: false, note: "missing" },
  ],
  evidence: [
    { kind: "gif", file: "r2-session.gif", label: "session" },
    { kind: "video", file: "r2-session.webm", label: "session" },
  ],
  notes: ["no base comparison: base app: down"],
  review: { reviewer: "evaluator", prior: [], findings: [] },
};
const link = (f: string) => (f.endsWith(".webm") ? undefined : `https://e/${f}`);

describe("evaluation in the PR", () => {
  it("criterion cells link the screenshot; unmet criteria say so", () => {
    expect(criterionEvidence(report, "A1", link)).toEqual({ met: true, cell: "evaluator: met, [screenshot](https://e/r2-A1.png)" });
    expect(criterionEvidence(report, "A2", link)).toEqual({ met: false, cell: "evaluator: NOT met" });
    expect(criterionEvidence(report, "A9", link)).toBeUndefined();
    expect(criterionEvidence(undefined, "A1", link)).toBeUndefined();
  });

  it("section: flows, pages with base/diff, GIF inline, unpublished files by name, notes", () => {
    const md = evaluationMarkdown(report, link, ["evidence not published: big.webm"]);
    expect(md).toContain("## Evaluation (round 2)");
    expect(md).toContain("- flow tours: pass");
    expect(md).toContain("- page / (Pixel 7): [HEAD](https://e/r2-pixel-7-root.png) · [base](https://e/base-pixel-7-root.png) · [diff](https://e/r2-diff-pixel-7-root.png) 1.2% changed");
    expect(md).toContain("no pixel change · 1 new console/network error(s)");
    expect(md).toContain("![evaluator session](https://e/r2-session.gif)");
    expect(md).toContain("Video: `r2-session.webm`");
    expect(md).toContain('| A1 ✅ | <img src="https://e/r2-A1.png" width="320"> |');
    expect(md).toContain("> no base comparison: base app: down");
    expect(md).toContain("> evidence not published: big.webm");
    expect(evaluationMarkdown(undefined, link)).toBe("");
  });
});
