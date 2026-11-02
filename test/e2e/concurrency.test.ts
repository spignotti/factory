import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { acquireRepoLock, decidePathClaim } from "../../src/pipeline/lock.js";
import { runScenario } from "../helpers/scenario.js";

function withHostSteps(steps: FakeStep[]): FakeStep[] {
  return steps.map((s) => {
    if (s.role !== "plan_high" || !s.output || typeof s.output !== "object") return s;
    return {
      ...s,
      output: {
        ...(s.output as object),
        host_steps: {
          commands: ["launchctl bootstrap gui/501 ~/Library/LaunchAgents/ops.plist", "restic snapshots"],
          verify: "launchctl print gui/501/ops shows the job",
          rollback: "launchctl bootout gui/501 ~/Library/LaunchAgents/ops.plist",
        },
      },
    };
  });
}

describe("parallel runs and host steps", () => {
  it("a non-overlapping plan proceeds beside another run and suffixes the branch with the slot", async () => {
    let release: (() => void) | undefined;
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      before: (repo, home) => {
        const held = acquireRepoLock(home, repo, "20261029-000000-bbbbbb", { maxRuns: 2 })!;
        expect(decidePathClaim(home, repo, held.slot, "20261029-000000-bbbbbb", { paths: ["docs/unrelated.md"], exclusive: false }).ok).toBe(true);
        release = held;
      },
    });
    release?.();
    expect(r.result.result).toBe("done");
    expect(r.github.prs[0]!.head).toMatch(/-s\d$/);
    expect(r.runner.calls.some((c) => c.role === "implement")).toBe(true);
  });

  it("an overlapping plan returns locked after planning", async () => {
    let release: (() => void) | undefined;
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      before: (repo, home) => {
        const held = acquireRepoLock(home, repo, "blocker", { maxRuns: 2 })!;
        expect(decidePathClaim(home, repo, held.slot, "blocker", { paths: ["src/math.js"], exclusive: false }).ok).toBe(true);
        release = held;
      },
    });
    release?.();
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toMatch(/overlap/);
    expect(r.result.reason).toContain("src/math.js");
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
    expect(r.result.worktree).toBeNull();
  });

  it("a plan that touches exclusive_paths is exclusive with another exclusive run", async () => {
    let release: (() => void) | undefined;
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2, exclusive_paths: ["src/**"] }),
      before: (repo, home) => {
        const held = acquireRepoLock(home, repo, "blocker", { maxRuns: 2 })!;
        expect(decidePathClaim(home, repo, held.slot, "blocker", { paths: ["README.md"], exclusive: true }).ok).toBe(true);
        release = held;
      },
    });
    release?.();
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toMatch(/overlap/);
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
  });

  it("--wait on an overlapping plan runs once the other claim is gone", async () => {
    const r = await runScenario({
      script: "clean.json",
      options: { wait: true },
      deps: { lockPollMs: 20 },
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      before: (repo, home) => {
        const held = acquireRepoLock(home, repo, "blocker", { maxRuns: 2 })!;
        expect(decidePathClaim(home, repo, held.slot, "blocker", { paths: ["src/math.js"], exclusive: false }).ok).toBe(true);
        setTimeout(held, 400);
      },
    });
    expect(r.result.result).toBe("done");
    expect(r.github.prs[0]!.head).toMatch(/-s\d$/);
    const queued = r.events.filter((e) => e.event === "queued" && Array.isArray(e.data.overlap));
    expect(queued.length).toBeGreaterThan(0);
    expect(JSON.stringify(queued[0]!.data.overlap)).toContain("src/math.js");
  });

  it("renders Mac install steps when the repo titles the section and the plan has host_steps", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.pr = { host_steps_section: "Mac install steps" }),
      steps: withHostSteps,
    });
    const body = r.github.prs[0]!.body;
    expect(body).toContain("## Mac install steps");
    expect(body).toContain("production Mac host");
    expect(body).toContain("launchctl bootstrap gui/501 ~/Library/LaunchAgents/ops.plist");
    expect(body).toContain("restic snapshots");
    expect(body).toContain("**Verify**");
    expect(body).toContain("launchctl print gui/501/ops shows the job");
    expect(body).toContain("**Roll back**");
    expect(body).toContain("launchctl bootout gui/501 ~/Library/LaunchAgents/ops.plist");
  });

  it("omits host steps when the repo does not title the section", async () => {
    const r = await runScenario({ script: "clean.json", steps: withHostSteps });
    expect(r.github.prs[0]!.body).not.toContain("Mac install steps");
    expect(r.github.prs[0]!.body).not.toContain("launchctl");
  });
});
