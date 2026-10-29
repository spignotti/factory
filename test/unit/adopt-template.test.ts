import { describe, expect, it } from "vitest";
import { detect } from "../../src/adopt/detect.js";
import { agentsTemplate, draftChecks, projectPurpose } from "../../src/adopt/draft.js";
import { gitIn } from "../helpers/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";

const files = (dir: string) => gitIn(dir, "ls-files").split("\n").filter(Boolean);
const SECTIONS = ["Purpose", "Stack & commands", "Test strategy", "Architecture", "Conventions", "Domain knowledge", "Data & secrets", "Do not", "Verify"];

describe("adopt: AGENTS.md template", () => {
  const pkg = { name: "a", description: "Plans delivery tours for small bakeries.", scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" }, dependencies: { pg: "1" } };

  it("has the factory's sections in order, detected values filled in, TODOs only where a human must answer", () => {
    const dir = makeRepo({ "package.json": JSON.stringify(pkg), "pnpm-lock.yaml": "", "src/a.ts": "", "src/a.test.ts": "", "docs/x.md": "" });
    const d = detect(dir, files(dir));
    const text = agentsTemplate({ detection: d, checks: draftChecks(d, null), purpose: projectPurpose(dir), topDirs: ["docs", "src"] });
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(SECTIONS);
    expect(text).toContain("## Purpose\n\nPlans delivery tours for small bakeries.\n");
    expect(text).toContain("- Stack: node (pnpm).\n- Setup: `pnpm install --frozen-lockfile`.\n- typecheck: `pnpm run typecheck`");
    expect(text).toContain("## Data & secrets\n\n- Database: dependency/compose: pg.\n");
    expect(text).toContain("- Top-level directories: `docs/`, `src/`.");
    expect(text).toMatch(/## Verify\n\n- Before calling a change done: the fast checks \(`typecheck`, `lint`, `test`\) pass/);
    for (const s of ["Purpose", "Stack & commands", "Verify"]) expect(text.split(`## ${s}\n`)[1]!.split("\n## ")[0]).not.toContain("TODO");
    expect(text.split("\n").length).toBeLessThan(150);
  });

  it("purpose falls back to the README's first paragraph, else a TODO; a replaced CLAUDE.md is kept as its own section", () => {
    const dir = makeRepo({ "README.md": "# Tool\n\n[![ci](x)](y)\n\nSyncs the  shop\ncatalogue nightly.\n\n## Use\n" });
    expect(projectPurpose(dir)).toBe("Syncs the shop catalogue nightly.");
    const bare = makeRepo({ "x.txt": "" });
    const d = detect(bare, files(bare));
    const text = agentsTemplate({ detection: d, checks: [], topDirs: [], extra: { from: "CLAUDE.md", text: "# Claude\n\n## Rules\n\n- Never run the seed scripts.\n" } });
    expect(text).toContain("## Purpose\n\nTODO:");
    expect(text).toMatch(/## Migrated from CLAUDE\.md\n\nTODO: move these[^\n]*\n\n### Rules\n\n- Never run the seed scripts\.\n$/);
  });
});
