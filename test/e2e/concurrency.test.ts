import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import { FakeGitHub, IncompletePrListError } from "../../src/gh.js";
import { activeHolders, acquireRepoLock, decidePathClaim } from "../../src/pipeline/lock.js";
import { runFactory } from "../../src/pipeline/run.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { createFixtureRepo, FIXTURES } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

function planWithFiles(output: unknown, files: string[]): unknown {
  if (!output || typeof output !== "object") return output;
  const plan = structuredClone(output) as { packages?: { files: string[] }[] };
  // The plan keeps the task's real files and adds the path-claim file, so scope repair does not see
  // the implementation itself as out of scope.
  for (const pkg of plan.packages ?? []) pkg.files = [...(pkg.files ?? []), ...files];
  return plan;
}

function growInto(steps: FakeStep[], planFile: string, extra: string): FakeStep[] {
  return steps.map((s) => {
    if (s.role === "plan_high") return { ...s, output: planWithFiles(s.output, [planFile]) };
    if (s.role === "implement") return { ...s, writes: { ...(s.writes ?? {}), [planFile]: "planned\n", [extra]: "shared\n" } };
    return s;
  });
}

/** A run whose plan owns one unique file and whose diff grows into `extra`, with no shared task files. */
function growScript(planFile: string, extra: string): FakeStep[] {
  return [
    {
      role: "plan_high",
      output: {
        version: 1,
        type: "feature",
        goal: `add ${planFile}`,
        context: "",
        packages: [{ id: "P1", title: planFile, description: `add ${planFile}`, files: [planFile], depends_on: [], changes_flows: [], source_quote: "" }],
        acceptance: [{ id: "A1", package: "P1", text: `${planFile} is present`, verify: "review", kind: "behavior", risk: false, source_quote: "" }],
        out_of_scope: [],
      },
      usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
    },
    {
      role: "implement",
      writes: { [planFile]: "planned\n", [extra]: "shared\n" },
      output: { package: "P1", done: [`added ${planFile}`], decisions: [], deviations_from_plan: [], skipped: [], uncertain: [], evidence: [], responses: [] },
      usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
    },
    { role: "review_plan", output: { reviewer: "plan", prior: [], findings: [] } },
    { role: "review_simplicity", output: { reviewer: "simplicity", prior: [], findings: [] } },
    { role: "pr_writer", raw: `adds ${planFile}` },
  ];
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

function publishedClaimPaths(home: string): string[] {
  const locks = join(home, "locks");
  if (!existsSync(locks)) return [];
  const out: string[] = [];
  for (const name of readdirSync(locks)) {
    if (!name.endsWith(".paths")) continue;
    try {
      const stored = JSON.parse(readFileSync(join(locks, name), "utf8")) as { paths?: unknown };
      if (Array.isArray(stored.paths)) for (const p of stored.paths) if (typeof p === "string") out.push(p);
    } catch {
      // a claim file mid-write is not published yet
    }
  }
  return out;
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

async function prOverlapQueued(home: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const runs = join(home, "runs");
    if (existsSync(runs)) {
      for (const id of readdirSync(runs)) {
        const events = join(runs, id, "events.jsonl");
        if (!existsSync(events)) continue;
        const text = readFileSync(events, "utf8");
        if (text.includes('"event":"queued"') && text.includes("shared.py") && /#\d+/.test(text)) return;
      }
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for an open-PR overlap queue");
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
  it("a repo without concurrency starts beside one other run and locks when both slots are held", async () => {
    let one: (() => void) | undefined;
    const beside = await runScenario({
      script: "clean.json",
      before: (repo, home) => {
        one = acquireRepoLock(home, repo, "slot-a", { maxRuns: 2 })!;
      },
    });
    one?.();
    expect(beside.result.result).toBe("done");
    expect(beside.github.prs[0]!.head).toMatch(/-s\d$/);

    let both: Array<() => void> = [];
    const full = await runScenario({
      script: "clean.json",
      before: (repo, home) => {
        both = [acquireRepoLock(home, repo, "slot-a", { maxRuns: 2 })!, acquireRepoLock(home, repo, "slot-b", { maxRuns: 2 })!];
      },
    });
    both.forEach((release) => release());
    expect(full.result.result).toBe("locked");
    expect(full.runner.calls).toEqual([]);

    const waited = await runScenario({
      script: "clean.json",
      options: { wait: true },
      deps: { lockPollMs: 20 },
      before: (repo, home) => {
        const a = acquireRepoLock(home, repo, "slot-a", { maxRuns: 2 })!;
        const b = acquireRepoLock(home, repo, "slot-b", { maxRuns: 2 })!;
        setTimeout(() => {
          a();
          b();
        }, 80);
      },
    });
    expect(waited.result.result).toBe("done");
  });

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

  it("publishes the planned claim before listing open factory PRs", async () => {
    let home = "";
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      before: (_repo, h) => {
        home = h;
      },
      github: (gh) => {
        // The overlapping PR becomes visible only once this run's claim is already published.
        // A list that runs first returns empty, and the later claim check would also miss.
        gh.openFactoryPrFiles = async () => {
          if (!publishedClaimPaths(home).includes("src/math.js")) return [];
          return [{ number: 77, branch: "factory/handover", files: ["src/math.js"] }];
        };
      },
    });
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toContain("#77");
    expect(r.github.pushes).toEqual([]);
    expect(r.runner.calls.map((c) => c.role)).toEqual(["plan_high"]);
  });

  it("publishes the changed-file claim before listing open factory PRs", async () => {
    let home = "";
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      before: (_repo, h) => {
        home = h;
      },
      github: (gh) => {
        gh.openFactoryPrFiles = async () => {
          if (!publishedClaimPaths(home).includes("a.py")) return [];
          return [{ number: 77, branch: "factory/handover", files: ["a.py"] }];
        };
      },
      steps: (steps) =>
        steps.map((s) => {
          if (s.role === "plan_high") return { ...s, output: planWithFiles(s.output, ["b.py"]) };
          if (s.role === "implement") return { ...s, writes: { ...(s.writes ?? {}), "a.py": "x = 1\n" } };
          return s;
        }),
    });
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toContain("#77");
    expect(r.result.reason).toContain("a.py");
    expect(r.github.pushes).toEqual([]);
    expect(r.runner.calls.some((c) => c.role === "implement")).toBe(true);
  });

  it("a factory PR list that hits the limit blocks before push", async () => {
    let calls = 0;
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      github: (gh) => {
        gh.openFactoryPrFiles = async () => {
          calls++;
          if (calls === 1) return [];
          throw new IncompletePrListError(1000);
        };
      },
    });
    expect(r.result.result).toBe("locked");
    expect(r.result.reason).toMatch(/hit the limit \(1000\)/);
    expect(r.github.pushes).toEqual([]);
  });

  it("a failing factory PR list at finalize is a resumable PR-step failure", async () => {
    let calls = 0;
    const r = await runScenario({
      script: "clean.json",
      patch: (c) => void (c.concurrency = { max_runs: 2 }),
      github: (gh) => {
        gh.openFactoryPrFiles = async () => {
          calls++;
          if (calls === 1) return [];
          throw new Error("gh: HTTP 502");
        };
      },
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/PR step failed: gh: HTTP 502/);
    expect(r.github.pushes).toEqual([]);
    expect(r.file("pr.md").length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.step === "finalize" && typeof e.data.pr_error === "string")).toBe(true);
    expect(JSON.parse(r.file("state.json")).step).not.toBe("finished");
  });

  it("reacquiring a slot at finalize stops at max_wall_minutes", async () => {
    const repo = createFixtureRepo((c) => {
      c.concurrency = { max_runs: 2 };
      (c.limits as Record<string, unknown>).max_wall_minutes = 0.25;
    });
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
    const blocker = acquireRepoLock(factoryHome, repo, "blocker", { maxRuns: 2 })!;
    expect(decidePathClaim(factoryHome, repo, blocker.slot, "blocker", { paths: ["shared.py"], exclusive: false }).ok).toBe(true);
    const scripted = FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", "clean.json"), "utf8"))).steps;
    const profile = loadProfile(join(FIXTURES, "profile.yaml"));
    let snatched: (() => void) | undefined;
    const run = runFactory(
      { repo, textFile: join(FIXTURES, "tasks", "multiply.md"), wait: true },
      {
        runner: new FakeRunner(growInto(scripted, "left.txt", "shared.py")),
        github: new FakeGitHub(),
        profile,
        factoryHome,
        parentEnv: process.env,
        sleep: async () => {},
        lockPollMs: 400,
      },
    );
    try {
      await finalizeWaiter(factoryHome);
      const until = Date.now() + 3_000;
      while (!snatched && Date.now() < until) {
        snatched = acquireRepoLock(factoryHome, repo, "snatcher", { maxRuns: 2 });
        if (!snatched) await new Promise((r) => setTimeout(r, 10));
      }
      expect(snatched).toBeTypeOf("function");
      const result = await Promise.race([
        run,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reacquire ignored the wall deadline")), 20_000)),
      ]);
      expect(result.result).toBe("needs_human");
      expect(result.reason).toMatch(/max_wall_minutes/);
    } finally {
      snatched?.();
      blocker();
      await run.catch(() => undefined);
    }
  });

  it("two runs that both grow into the same path at finalize do not both hold slots while waiting", async () => {
    const repo = createFixtureRepo((c) => void (c.concurrency = { max_runs: 2 }));
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
    const github = new BlockingGitHub();
    const profile = loadProfile(join(FIXTURES, "profile.yaml"));
    const start = (planFile: string) =>
      runFactory(
        { repo, textFile: join(FIXTURES, "tasks", "multiply.md"), wait: true },
        {
          runner: new FakeRunner(growScript(planFile, "shared.py")),
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
      await prOverlapQueued(factoryHome);
      expect(github.pushes).toHaveLength(1);
      expect(github.factoryPrs.some((p) => p.files.includes("shared.py"))).toBe(true);
      github.factoryPrs.length = 0;
      const results = await runs;
      expect(results.map((r) => r.result).sort()).toEqual(["done", "done"]);
    } finally {
      github.factoryPrs.length = 0;
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
    expect(r.result.result, r.file("state.json")).toBe("needs_human");
    expect(r.result.reason).toMatch(/changed files overlap another factory run/);
    expect(r.github.pushes).toEqual([]);
    expect(r.runner.calls.some((c) => c.role === "implement")).toBe(true);
  });
});
