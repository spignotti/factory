import { describe, expect, it } from "vitest";
import { duplicateRules, staleClaudeMd, trimAgentsMd } from "../../src/adopt/agents-md.js";
import { classifyLegacy, operatorToolingRoots, withMigratedReviewRules } from "../../src/adopt/legacy.js";

const AGENTS = `# Agent rules

## Data and access

- Never read, print, log, or write secret values.
- Use synthetic data in tests.

## Git

- Work on a feature branch and open a PR against \`main\`.

## Cursor Cloud specific instructions

- Validate with \`uv run --locked nox\` (lint, typecheck, unit and service tests).
- Never run \`pytest -m integration\` or the seed scripts.
  Never connect a hosted Supabase project.
- Do not change \`.github/workflows/\` without an explicit task.
- Describe changed UI states in the PR.
- The cloud VM has a slow disk.
`;

describe("adopt: AGENTS.md trimming", () => {
  it("rules in a tool-named section move to Do not / Stack & commands; only workflow sections are proposed", () => {
    const r = trimAgentsMd(AGENTS);
    expect(r.moved.map((m) => [m.to, m.rule.slice(0, 20)])).toEqual([
      ["Stack & commands", "validate with `uv ru"],
      ["Do not", "never run `pytest -m"],
      ["Do not", "do not change `.gith"],
    ]);
    expect(r.text).toContain("## Do not\n\n- Never run `pytest -m integration` or the seed scripts.\n  Never connect a hosted Supabase project.\n- Do not change");
    expect(r.text).toContain("## Stack & commands\n\n- Validate with `uv run --locked nox`");
    // untouched sections keep their exact text; the PR-workflow item stays in the tool section
    expect(r.text).toContain("## Data and access\n\n- Never read, print, log, or write secret values.\n- Use synthetic data in tests.\n");
    expect(r.text).toMatch(/## Cursor Cloud specific instructions\n\n- Describe changed UI states in the PR\.\n- The cloud VM has a slow disk\./);
    expect(r.proposed.map((p) => p.title)).toEqual(["Git", "Cursor Cloud specific instructions"]);
    expect(r.warnings).toEqual([]);
  });

  it("an existing Do not section receives the rules; an emptied tool section disappears", () => {
    const r = trimAgentsMd("# A\n\n## Don't\n\n- Never touch prod.\n\n## Claude Code\n\n- Never edit `migrations/` by hand.\n");
    expect(r.text).toBe("# A\n\n## Don't\n\n- Never touch prod.\n- Never edit `migrations/` by hand.\n");
    expect(r.proposed).toEqual([]);
  });

  it("domain sections are never proposed, even when they mention a tool word or 'model'", () => {
    const r = trimAgentsMd("# A\n\n## Data model\n\n- Orders have a cursor column.\n");
    expect(r).toMatchObject({ moved: [], proposed: [] });
  });

  it("nothing to move leaves the text byte for byte", () => {
    const text = "# A\n\n## Rules\n\n* one rule here\n\n\n## Grok\n\nplain words only here\n";
    expect(trimAgentsMd(text).text).toBe(text);
  });

  it("warns about a rule stated twice", () => {
    expect(duplicateRules("# A\n\n## X\n\n- Never touch prod data.\n\n## Y\n\n- never  touch prod data\n")).toEqual(['AGENTS.md states a rule 2× (X, Y): "never touch prod data"']);
    // moving a rule next to its twin is reported too
    expect(trimAgentsMd("# A\n\n## Do not\n\n- Never run the seed scripts.\n\n## Cursor\n\n- Never run the seed scripts.\n").warnings).toHaveLength(1);
  });

  it("CLAUDE.md is stale when it has rules AGENTS.md lacks; a pointer file is fine", () => {
    expect(staleClaudeMd("@AGENTS.md\n", "# A\n")).toBeUndefined();
    expect(staleClaudeMd("- Never touch prod data.\n", "## X\n\n- Never touch prod data.\n")).toBeUndefined();
    expect(staleClaudeMd("# Claude\n\n- Never touch prod data.\n- Run `make check` before done.\n", "## X\n\n- Never touch prod data.\n")).toMatch(/1 rule\(s\) AGENTS\.md lacks.*make check/);
    expect(staleClaudeMd("- Run `make check` before done.\n", undefined)).toMatch(/1 rule/);
  });
});

describe("adopt: legacy safety", () => {
  const base = { workflows: [], checks: [], setup: "", keep: [] };

  it("agent-tool dirs with skills or scripts are operator tooling: proposed, never removed", () => {
    const files = [".grok/commands/maintain.md", ".grok/skills/ops/SKILL.md", ".grok/skills/ops/scripts/deploy.sh", ".claude/commands/fix.md", ".claude/settings.json", ".cursor/install.sh", ".cursor/rules/a.mdc"];
    expect([...operatorToolingRoots(files)]).toEqual([".grok"]);
    const r = classifyLegacy({ ...base, files });
    expect(r.removed.map((i) => i.path)).toEqual([".claude/commands/fix.md", ".claude/settings.json", ".cursor/rules/a.mdc"]);
    expect(r.proposed.filter((i) => i.path.startsWith(".grok/")).map((i) => i.reason)).toEqual(Array(3).fill(expect.stringMatching(/operator tooling/)));
    // a skills folder alone (no scripts) is enough
    expect([...operatorToolingRoots([".opencode/skill/x/SKILL.md"])]).toEqual([".opencode"]);
  });

  it("a review-bot config with instructions is proposed (migrate by hand), a plain switch file removed", () => {
    const files = [".cursor/config/bugbot.yaml", ".bugbot/config.json", ".cursor/BUGBOT.md"];
    const text: Record<string, string> = { ".cursor/config/bugbot.yaml": "version: 1\ninstructions: |\n  Flag RLS changes.\n", ".bugbot/config.json": '{"autofix": false}' };
    const r = classifyLegacy({ ...base, files, read: (p) => text[p] });
    expect(r.removed.map((i) => i.path)).toEqual([".bugbot/config.json", ".cursor/BUGBOT.md"]);
    expect(r.proposed).toEqual([{ path: ".cursor/config/bugbot.yaml", reason: expect.stringMatching(/review instructions: move them into \.factory\/review-rules\.md/) }]);
  });

  it("review-bot rules are appended to review-rules.md, headings demoted, duplicates of the standard skipped", () => {
    const std = "# Review rules\n\n- Style is never a `bug`.\n";
    const out = withMigratedReviewRules(std, [
      { path: ".cursor/BUGBOT.md", text: "# Bugbot review rules\n\n## Tenants\n\n- Flag service-role keys in the request path.\n- Style is never a `bug`.\n" },
      { path: "BUGBOT.md", text: "# Only a title\n" },
    ]);
    expect(out).toBe("# Review rules\n\n- Style is never a `bug`.\n\n## Repo rules (migrated from `.cursor/BUGBOT.md`)\n\n### Tenants\n\n- Flag service-role keys in the request path.\n");
  });
});
