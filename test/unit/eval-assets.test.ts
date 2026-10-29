import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalProfile, loadTasks, resolveEvalProfile } from "../../src/eval/eval.js";

describe("shipped eval assets", () => {
  it("shipped tasks and profiles parse; tasks carry license and source; ids match file names", () => {
    const tasks = loadTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    for (const t of tasks) {
      expect(t.repo).toMatch(/^https:\/\/github\.com\//);
      expect(t.license).toMatch(/^(MIT|BSD-3-Clause|Apache-2\.0)$/);
      // bug plans need tests.run (red-green proof)
      expect((t.repo_config!.tests as { run?: string }).run).toContain("{files}");
    }
    expect(tasks.filter((t) => t.id.startsWith("unjs__")).length).toBeGreaterThanOrEqual(3);
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const baseline = loadEvalProfile("baseline");
    expect(resolveEvalProfile(baseline, home).roles.implement[0]!.model).toBe("opencode-go/deepseek-v4.1-flash");
    const variant = loadEvalProfile(join(import.meta.dirname, "..", "..", "evals", "profiles", "example-variant.yaml"));
    expect(variant.name).toBe("example-variant");
    expect(variant.prompts.implement).toContain("Variant note");
  });

});
