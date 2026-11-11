import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("factory's own CI workflow", () => {
  const wf = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
    on: { pull_request: unknown; push: { tags?: string[]; branches?: string[] } };
    permissions: Record<string, string>;
    concurrency: Record<string, unknown>;
    jobs: Record<string, { steps: { run?: string; if?: string }[] }>;
  };

  it("runs on pull requests, release tags and by hand, not on pushes to main", () => {
    expect(wf.on).toHaveProperty("pull_request");
    expect(wf.on.push).toEqual({ tags: ["v*"] });
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("the required `check` job always reports and runs install, the headless-shell install, typecheck, lint and test unless skipped", () => {
    expect(Object.keys(wf.jobs)).toEqual(["check"]);
    const steps = wf.jobs.check!.steps;
    const gated = steps.filter((s) => s.if === "steps.scope.outputs.skip != 'true'");
    expect(gated.length).toBe(steps.length - 2); // all but checkout and the scope step
    const runs = gated.map((s) => s.run).filter((r): r is string => Boolean(r) && !r!.includes("GITHUB_OUTPUT"));
    expect(runs).toHaveLength(6);
    expect(runs[0]).toBe("pnpm install --frozen-lockfile");
    // The headless shell downloads without apt; apt deps and ffmpeg are best effort (mirror outages must not fail the job).
    expect(runs[1]).toContain("pnpm exec playwright-core install --only-shell chromium");
    expect(runs[1]).toMatch(/install-deps chromium-headless-shell \|\| echo "::warning::/);
    expect(runs[2]).toMatch(/^command -v ffmpeg \|\| .*apt-get install .*ffmpeg.*\|\| echo "::warning::/);
    expect(runs.slice(3)).toEqual(["pnpm typecheck", "pnpm lint", "pnpm test"]);
  });
});
