import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("factory's own CI workflow", () => {
  it("runs install, the headless-shell install, typecheck, lint and test on pull requests and pushes to main", () => {
    const wf = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
      on: { pull_request: unknown; push: { branches: string[] } };
      permissions: Record<string, string>;
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    expect(wf.on).toHaveProperty("pull_request");
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run).filter(Boolean));
    expect(runs).toEqual(["pnpm install --frozen-lockfile", "pnpm exec playwright-core install --with-deps --only-shell chromium", "pnpm typecheck", "pnpm lint", "pnpm test"]);
  });
});
