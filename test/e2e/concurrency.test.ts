import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import { FakeGitHub } from "../../src/gh.js";
import { activeHolders, acquireRepoLock, decidePathClaim } from "../../src/pipeline/lock.js";
import { runFactory } from "../../src/pipeline/run.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { createFixtureRepo, FIXTURES } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

function planWithFiles(output: unknown, files: string[]): unknown {
  if (!output || typeof output !== "object") return output;
  const plan = structuredClone(output) as { packages?: { files: string[] }[] };
  for (const pkg of plan.packages ?? []) pkg.files = files;
  return plan;
}

function growInto(steps: FakeStep[], planFile: string, extra: string): FakeStep[] {
  return steps.map((s) => {
    if (s.role === "plan_high") return { ...s, output: planWithFiles(s.output, [planFile]) };
    if (s.role === "implement") return { ...s, writes: { ...(s.writes ?? {}), [planFile]: "planned\n", [extra]: "shared\n" } };
    return s;
  });
}

class BlockingGitHub extends FakeGitHub {
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  private pushesStarted = 0;
  releasePush(): void {
    this.releaseGate();
  }
  override async push(repoDir: string, branch: string): Promise<void> {
    this.pushesStarted++;
    if (this.pushesStarted === 1) await this.gate;
    return super.push(repoDir, branch);
  }
}

async function finalizeWaiter(home: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const runs = join(home, "runs");
    if (existsSync(runs)) {
      for (const id of readdirSync(runs)) {
        const events = join(runs, id, "events.jsonl");
        if (!existsSync(events)) continue;
        const text = readFileSync(events, "utf8");
        if (text.includes('"step":"finalize"') && text.includes('"event":"queued"')) return id;
      }
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for a finalize path-claim wait");
}

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

  it("an open factory PR touching a.py locks a run that plans a.py; a run on b.py proceeds", async () => {
    const plant = (gh: FakeGitHub) => {
      gh.factoryPrs.push({ number: 12, branch: "factory/old-ticket", files: ["a.py"] });
    };
    const locked = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      github: plant,
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, output: planWithFiles(s.output, ["a.py"]) } : s)),
    });
    expect(locked.result.result).toBe("locked");
    expect(locked.result.reason).toContain("#12");
    expect(locked.result.reason).toContain("a.py");
    expect(locked.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
    expect(locked.github.pushes).toEqual([]);

    const proceeded = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      github: plant,
      steps: (steps) => steps.map((s) => (s.role === "plan_high" ? { ...s, output: planWithFiles(s.output, ["b.py"]) } : s)),
    });
    expect(proceeded.result.result).toBe("done");
    expect(proceeded.github.pushes.length).toBe(1);
  });

  it("an open factory PR locks before push when the diff grows into its files", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      github: (gh) => {
        gh.factoryPrs.push({ number: 12, branch: "factory/old-ticket", files: ["a.py"] });
      },
      steps: (steps) =>
        steps.map((s) => {
          if (s.role === "plan_high") return { ...s, output: planWithFiles(s.output, ["b.py"]) };
          if (s.role === "implement") return { ...s, writes: { ...(s.writes ?? {}), "a.py": "x = 1\n" } };
          return s;
        }),
    });
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toContain("#12");
    expect(r.github.pushes).toEqual([]);
    expect(r.runner.calls.some((c) => c.role === "implement")).toBe(true);
  });

  it("--wait on an open factory PR does not hold a slot while waiting", async () => {
    let home = "";
    let gh: FakeGitHub | undefined;
    let holdersWhileQueued: number | undefined;
    let stop = () => {};
    try {
      const r = await runScenario({
        script: "clean.json",
        options: { wait: true },
        deps: { lockPollMs: 250 },
        patch: (c) => void (c.concurrency = { max_runs: 2 }),
        before: (_repo, h) => {
          home = h;
          const timer = setInterval(() => {
            if (!home || !existsSync(join(home, "runs")) || !gh) return;
            for (const id of readdirSync(join(home, "runs"))) {
              const events = join(home, "runs", id, "events.jsonl");
              if (!existsSync(events)) continue;
              const text = readFileSync(events, "utf8");
              if (text.includes('"event":"queued"') && text.includes("#9")) {
                holdersWhileQueued = activeHolders(home).length;
                gh.factoryPrs.length = 0;
                clearInterval(timer);
              }
            }
          }, 15);
          stop = () => clearInterval(timer);
        },
        github: (g) => {
          gh = g;
          g.factoryPrs.push({ number: 9, branch: "factory/old-ticket", files: ["src/math.js"] });
        },
      });
      expect(holdersWhileQueued).toBe(0);
      expect(r.result.result).toBe("done");
      expect(r.events.some((e) => e.event === "queued" && JSON.stringify(e.data.overlap).includes("#9"))).toBe(true);
    } finally {
      stop();
    }
  });

  it("two runs that both grow into the same path at finalize do not both hold slots while waiting", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
    const github = new BlockingGitHub();
    const scripted = FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", "clean.json"), "utf8"))).steps;
    const profile = loadProfile(join(FIXTURES, "profile.yaml"));
    const start = (planFile: string) =>
      runFactory(
        { repo, textFile: join(FIXTURES, "tasks", "multiply.md"), wait: true },
        {
          runner: new FakeRunner(growInto(scripted, planFile, "shared.py")),
          github,
          profile,
          factoryHome,
          parentEnv: process.env,
          sleep: async () => {},
          lockPollMs: 250,
        },
      );
    const runs = Promise.all([start("left.txt"), start("right.txt")]);
    try {
      const waitingId = await finalizeWaiter(factoryHome);
      const holders = activeHolders(factoryHome);
      expect(holders.map((h) => h.runId)).not.toContain(waitingId);
      expect(holders).toHaveLength(1);
      github.releasePush();
      const results = await runs;
      expect(results.map((r) => r.result).sort()).toEqual(["done", "done"]);
    } finally {
      github.releasePush();
    }
  });

  it("needs_human before push when the diff adds a migration the plan omitted beside an exclusive run", async () => {
    let release: (() => void) | undefined;
    const migration = "supabase/migrations/001_add.sql";
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2, exclusive_paths: ["supabase/migrations/**"] }),
      before: (repo, home) => {
        const held = acquireRepoLock(home, repo, "migration-blocker", { maxRuns: 2 })!;
        expect(
          decidePathClaim(home, repo, held.slot, "migration-blocker", { paths: [migration], exclusive: true }).ok,
        ).toBe(true);
        release = held;
      },
      steps: (steps) =>
        steps.map((s) =>
          s.role === "implement"
            ? {
                ...s,
                writes: {
                  ...(s.writes as Record<string, string>),
                  [migration]: "alter table t add column c int;\n",
                },
              }
            : s,
        ),
    });
    release?.();
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/changed files overlap another factory run/);
    expect(r.github.pushes).toEqual([]);
    expect(r.runner.calls.some((c) => c.role === "implement")).toBe(true);
  });
});
