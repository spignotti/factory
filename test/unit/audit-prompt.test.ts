import { describe, expect, it } from "vitest";
import { auditUserPrompt } from "../../src/commands/audit.js";
import { asData } from "../../src/prompts.js";
import { PLAN_SHAPE } from "../../src/steps/plan.js";

const signals = { findings: [], metrics: null };
const checks = [{ name: "lint", run: "true", tier: "fast" }];

/** The prompt `factory audit` sent before `audit.focus` existed. */
function historical(type: "security" | "performance", max = 5): string {
  const shape = `Return a single \`\`\`json block: {"proposals":[{"rationale":"<2-4 sentences naming the evidence, with file:line>","plan":<plan.json>}, …]}.
Up to ${max} ${type} proposals, ranked: the most valuable first. Each is its own factory run and PR: distinct goals, and a
memory key belongs to at most one proposal. Fewer is fine when the repository does not justify more.
${PLAN_SHAPE.split("\nor ")[0]}
plan.resolves_findings: memory keys from the open findings, or []. Do not return questions.`;
  return [asData("signals", JSON.stringify(signals, null, 2)), asData("checks", JSON.stringify(checks, null, 2)), shape].join("\n\n");
}

describe("auditUserPrompt", () => {
  it("is byte-identical to the historical prompt when focus is omitted", () => {
    expect(auditUserPrompt({ signals, checks, max: 5, type: "security" })).toBe(historical("security"));
    expect(auditUserPrompt({ signals, checks, max: 5, type: "performance", focus: undefined })).toBe(historical("performance"));
    expect(auditUserPrompt({ signals, checks, max: 5, type: "security", focus: "" })).toBe(historical("security"));
  });

  it("inserts only that call's focus, as data, ahead of the selection instructions", () => {
    const note = "Privacy and GDPR: personal data in logs, fixtures, exports and retention.";
    const security = auditUserPrompt({ signals, checks, max: 5, type: "security", focus: note });
    const performance = auditUserPrompt({ signals, checks, max: 5, type: "performance", focus: "- slow queries" });
    expect(security).toBe(historical("security").replace(`\n\nReturn a single`, `\n\n${asData("focus", note)}\n\nReturn a single`));
    expect(performance).toBe(historical("performance").replace(`\n\nReturn a single`, `\n\n${asData("focus", "- slow queries")}\n\nReturn a single`));
    expect(security).not.toContain("slow queries");
    expect(performance).not.toContain(note);
  });
});
