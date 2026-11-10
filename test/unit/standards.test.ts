import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standardsMigrateCommand } from "../../src/commands/standards.js";
import { checklistSignals } from "../../src/harden/signals.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { migrateStandards, readRepoStandards, resolveStandards, standardsDoctorNotes, standardsOldIgnored, standardsRemovalDeclared, standardsRemovals, STANDARDS_DEPRECATION, unmarkedStandardRules } from "../../src/standards.js";

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

  it("migrate writes severity first and ## Rules last, and a line appended there is a rule", () => {
    const text = migrateStandards({
      checklist: "# Checklist\n\n- no console.log\n- tests pass <!-- check: unit -->\n",
      reviewRules: "# Review rules\n\n- `bug`: a defect\n\n## Repo rules\n\n- flag keys\n",
    });
    expect(text).toBe("# Standards\n\n## Severity\n\n- `bug`: a defect\n\n### Repo rules\n\n- flag keys\n\n## Rules\n\n- no console.log\n- tests pass <!-- check: unit -->\n");
    const migrated = resolveStandards({ standards: text, defaultReviewRules: globalRules });
    expect(migrated.unmarked.map((i) => i.text)).toEqual(["no console.log"]);
    expect(migrated.reviewRules).toContain("flag keys");
    expect(migrated.reviewRules).not.toContain("no console.log");
    const appended = `${text!.trimEnd()}\n- appended rule\n`;
    expect(resolveStandards({ standards: appended, defaultReviewRules: globalRules }).unmarked.map((i) => i.text)).toEqual(["no console.log", "appended rule"]);
    expect(migrateStandards({})).toBeUndefined();
    const severityOnly = migrateStandards({ reviewRules: "# Review rules\n\n- only severity\n" });
    expect(severityOnly).toBe("# Standards\n\n## Severity\n\n- only severity\n\n## Rules\n");
    expect(resolveStandards({ standards: `${severityOnly}- new rule\n`, defaultReviewRules: globalRules }).unmarked.map((i) => i.text)).toEqual(["new rule"]);

    const ruled = ["# Standards", "", "- before", "", "## Severity", "", "- not a rule", "", "## Review rules", "", "- legacy guidance", "", "## Notes", "", "- later rule", ""].join("\n");
    const later = resolveStandards({ standards: ruled, defaultReviewRules: globalRules });
    expect(later.unmarked.map((i) => i.text)).toEqual(["before", "later rule"]);
    expect(later.reviewRules).toContain("not a rule");
    expect(later.reviewRules).toContain("legacy guidance");
    expect(later.reviewRules).not.toContain("later rule");

    const dir = mkdtempSync(join(tmpdir(), "std-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "checklist.md"), "- keep this\n");
    writeFileSync(join(dir, ".factory", "review-rules.md"), "# Review rules\n\n- sev\n");
    const c = io();
    expect(standardsMigrateCommand({ repo: dir, json: true }, c.io)).toBe(0);
    expect(JSON.parse(c.out())).toEqual({ written: ".factory/standards.md" });
    const written = readFileSync(join(dir, ".factory", "standards.md"), "utf8");
    expect(written).toContain("## Severity");
    expect(written.trimEnd().endsWith("## Rules\n\n- keep this")).toBe(true);
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

    writeFileSync(join(dir, ".factory", "standards.md"), "# Standards\n\n## Severity\n\n- not a rule\n\n## Rules\n\n- appended later\n");
    expect(unmarkedStandardRules(dir)).toEqual(["appended later"]);
    expect(checklistSignals(dir, repo)).toEqual(["appended later"]);
  });

  it("ignores old files once standards.md exists, and doctor says to delete them", () => {
    const dir = mkdtempSync(join(tmpdir(), "std-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "standards.md"), "# Standards\n\n## Rules\n\n- from standards\n");
    writeFileSync(join(dir, ".factory", "checklist.md"), "- from checklist\n");
    writeFileSync(join(dir, ".factory", "review-rules.md"), "- from old review rules\n");
    const resolved = readRepoStandards(dir, globalRules);
    expect(resolved.source).toBe("standards.md");
    expect(resolved.deprecated).toBeUndefined();
    expect(resolved.unmarked.map((i) => i.text)).toEqual(["from standards"]);
    expect(resolved.reviewRules).not.toContain("from old review rules");
    expect(standardsDoctorNotes(dir, [])).toEqual([
      { name: "standards", status: "warn", detail: standardsOldIgnored([".factory/checklist.md", ".factory/review-rules.md"]) },
    ]);
    expect(standardsDoctorNotes(dir, [])[0]!.detail).toMatch(/ignored\. Delete them/);
  });

  it("a marker removal needs the file listed and the check named; a rule needs its text", () => {
    const marker = { kind: "marker" as const, text: "tests pass", check: "unit" };
    expect(standardsRemovalDeclared("remove the unit marker", marker, ["src/a.py"])).toBe(false);
    expect(standardsRemovalDeclared("drop check: unit", marker, [])).toBe(false);
    expect(standardsRemovalDeclared("no mention", marker, [".factory/standards.md"])).toBe(false);
    expect(standardsRemovalDeclared("remove the unit marker", marker, [".factory/standards.md"])).toBe(true);
    expect(standardsRemovalDeclared("Remove the rule no console.log", { kind: "rule", text: "no console.log" }, [])).toBe(true);

    const afterSeverity = "# Standards\n\n## Severity\n\n- sev\n\n## Rules\n\n- keep\n- tests pass <!-- check: unit -->\n";
    expect(standardsRemovals(afterSeverity, afterSeverity.replace("- keep\n", ""))).toEqual([{ kind: "rule", text: "keep" }]);
    const markerInSeverity = "# Standards\n\n## Severity\n\n- tests pass <!-- check: unit -->\n\n## Rules\n\n- keep\n";
    expect(standardsRemovals(markerInSeverity, markerInSeverity.replace(" <!-- check: unit -->", ""))).toEqual([]);
  });
});
