import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { postQuestions, questionsMarker, renderQuestionsComment } from "../../src/pipeline/questions.js";

const RUN = "20261116-100000-abcdef";

function gh(): FakeGitHub {
  const g = new FakeGitHub();
  g.issues.set(3, { number: 3, title: "T", body: "B", labels: ["factory-ready"] });
  return g;
}

describe("postQuestions", () => {
  it("a retry after a label failure does not post the comment again", async () => {
    const g = gh();
    g.issueLabelError = "HTTP 403";
    await expect(postQuestions(g, "/repo", 3, RUN, ["Which unit?"])).rejects.toThrow("HTTP 403");
    expect(g.comments.get(3)).toHaveLength(1);
    expect(g.issues.get(3)!.labels).toEqual(["factory-ready"]);

    g.issueLabelError = null;
    await postQuestions(g, "/repo", 3, RUN, ["Which unit?"]);
    expect(g.comments.get(3)).toHaveLength(1);
    expect(g.issues.get(3)!.labels).toEqual(["needs-input"]);
    expect(g.ensuredLabels.map((l) => l.name)).toEqual(["needs-input"]);
  });

  it("redacts the comment body and keeps multi-line questions inside their list item", async () => {
    const g = gh();
    await postQuestions(g, "/repo", 3, RUN, ["Use token s3cr3t?", "Which file?\nsrc/a.ts or src/b.ts"], (t) => t.replaceAll("s3cr3t", "***"));
    const posted = g.comments.get(3)![0]!.body;
    expect(posted).not.toContain("s3cr3t");
    expect(posted).toContain("1. Use token ***?\n2. Which file?\n   src/a.ts or src/b.ts");
    expect(posted.endsWith(questionsMarker(RUN))).toBe(true);
  });

  it("another run's marker does not count as this run's comment", async () => {
    const g = gh();
    g.comments.set(3, [{ author: "factory-bot", body: renderQuestionsComment("20261115-100000-000000", ["Old?"]), created_at: "" }]);
    await postQuestions(g, "/repo", 3, RUN, ["New?"]);
    expect(g.comments.get(3)).toHaveLength(2);
  });
});
