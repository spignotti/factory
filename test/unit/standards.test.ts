import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standardsMigrateCommand } from "../../src/commands/standards.js";
import { checklistSignals } from "../../src/harden/signals.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { migrateStandards, resolveStandards, STANDARDS_DEPRECATION, unmarkedStandardRules } from "../../src/standards.js";

const io = () => {
  let out = "";
  let err = "";
  return { io: { out: (s: string) => void (out += s), err: (s: string) => void (err += s) }, out: () => out, err: () => err };
};

describe("standards.md", () => {
  const globalRules = "# Review rules\n\n- global-default\n";

  it("keeps severity guidance out of the rules list and falls back to the old files", () => {
    const standards = ["# Standards", "", "- route checks the session", "- migrations are reversible <!-- check: migrations -->", "", "## Severity", "", "- custom-severity", ""].join("\n");
    const resolved = resolveStandards({ standards, defaultReviewRules: globalRules });
    expect(resolved.source).toBe("standards.md");
    expect(resolved.deprecated).toBeUndefined();
    expect(resolved.unmarked.map((i) => i.text)).toEqual(["route checks the session"]);
    expect(resolved.reviewRules).toContain("custom-severity");
    expect(resolved.reviewRules).not.toContain("global-default");

    const fallback = resolveStandards({
      checklist: "- from checklist\n",
      reviewRules: "# Review rules\n\n- legacy-severity\n",
      defaultReviewRules: globalRules,
    });
    expect(fallback.source).toBe("checklist.md");
    expect(fallback.deprecated).toBe(STANDARDS_DEPRECATION);
    expect(fallback.unmarked.map((i) => i.text)).toEqual(["from checklist"]);
    expect(fallback.reviewRules).toContain("legacy-severity");

    const empty = resolveStandards({ standards: "", defaultReviewRules: globalRules, checklist: "- ignored\n" });
    expect(empty.unmarked).toEqual([]);
    expect(empty.reviewRules).toContain("global-default");
    expect(empty.deprecated).toBeUndefined();
  });

  it("migrate writes standards.md from the old files and does not delete them", () => {
    const text = migrateStandards({
      checklist: "# Checklist\n\n- no console.log\n- tests pass <!-- check: unit -->\n",
      reviewRules: "# Review rules\n\n- `bug`: a defect\n",
    });
    expect(text).toBe("# Standards\n\n- no console.log\n- tests pass <!-- check: unit -->\n\n## Severity\n\n- `bug`: a defect\n");
    expect(migrateStandards({})).toBeUndefined();
    expect(migrateStandards({ reviewRules: "# Review rules\n\n- only severity\n" })).toBe("# Standards\n\n## Severity\n\n- only severity\n");

    const dir = mkdtempSync(join(tmpdir(), "std-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "checklist.md"), "- keep this\n");
    writeFileSync(join(dir, ".factory", "review-rules.md"), "# Review rules\n\n- sev\n");
    const c = io();
    expect(standardsMigrateCommand({ repo: dir, json: true }, c.io)).toBe(0);
    expect(JSON.parse(c.out())).toEqual({ written: ".factory/standards.md" });
    expect(readFileSync(join(dir, ".factory", "standards.md"), "utf8")).toContain("keep this");
    expect(readFileSync(join(dir, ".factory", "standards.md"), "utf8")).toContain("## Severity");
    expect(existsSync(join(dir, ".factory", "checklist.md"))).toBe(true);
    expect(existsSync(join(dir, ".factory", "review-rules.md"))).toBe(true);
    expect(standardsMigrateCommand({ repo: dir, json: false }, io().io)).toBe(1);
  });

  it("improve/harden findings read unmarked rules from standards.md, not the old checklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "std-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "checklist.md"), "- old rule\n");
    writeFileSync(join(dir, ".factory", "standards.md"), "- new rule\n- automated <!-- check: unit -->\n\n## Severity\n\n- not a rule\n");
    const repo = parseRepoConfig("review: { checklist: true }\n");
    expect(unmarkedStandardRules(dir)).toEqual(["new rule"]);
    expect(checklistSignals(dir, repo)).toEqual(["new rule"]);
    expect(checklistSignals(dir, parseRepoConfig("review: { checklist: false }\n"))).toEqual([]);
  });
});
