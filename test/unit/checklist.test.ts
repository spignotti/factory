import { describe, expect, it } from "vitest";
import { parseChecklist, unmarkedItems } from "../../src/checklist.js";

describe("checklist markers", () => {
  const text = [
    "# Checklist",
    "",
    "Intro text is ignored.",
    "- Every API route checks the session",
    "- [ ] Migrations are reversible <!-- check: migrations -->",
    "* [x] No console.log in src <!--check:lint-->",
    "1. Errors are logged with a request id",
    "   and never include the token",
    "+ <!-- just a comment -->",
    "- Public functions have docs <!-- note --> <!-- check:  docs coverage  -->",
    "    - nested item counts too",
  ].join("\n");

  it("parses bullets, task boxes, ordered items and continuation lines", () => {
    expect(parseChecklist(text)).toEqual([
      { line: 4, text: "Every API route checks the session" },
      { line: 5, text: "Migrations are reversible", check: "migrations" },
      { line: 6, text: "No console.log in src", check: "lint" },
      { line: 7, text: "Errors are logged with a request id and never include the token" },
      { line: 10, text: "Public functions have docs", check: "docs coverage" },
      { line: 11, text: "nested item counts too" },
    ]);
  });

  it("only unmarked items go to the checklist reviewer", () => {
    expect(unmarkedItems(parseChecklist(text)).map((i) => i.line)).toEqual([4, 7, 11]);
    expect(parseChecklist("")).toEqual([]);
  });
});
