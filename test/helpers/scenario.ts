import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import type { AgentRequest, AgentRunner } from "../../src/agents/runner.js";
import type { FactoryEvent, RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import type { RunDeps } from "../../src/pipeline/context.js";
import { type RunOptions, runFactory } from "../../src/pipeline/run.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { createFixtureRepo, FIXTURES } from "./repo.js";

export const SECRET = "fake-foo-token-value-0123456789";

export interface Scenario {
  script: string;
  task?: string;
  patch?: (cfg: Record<string, unknown>) => void;
  options?: Partial<RunOptions>;
  github?: (gh: FakeGitHub) => void;
  /** Extra/overridden run deps (e.g. an abort signal). */
  deps?: Partial<RunDeps>;
  /** Called before every agent call (after the fake runner recorded nothing yet). */
  onCall?: (req: AgentRequest, repo: string) => void;
  /** Called with the fixture repo and factory home right before the run starts. */
  before?: (repo: string, factoryHome: string) => void;
  /** Prepares the fixture repo before the run (e.g. adds an origin). */
  setup?: (repo: string) => void;
  /** Rewrites the scripted steps before the run (e.g. to inject values). */
  steps?: (steps: FakeStep[]) => FakeStep[];
}

export interface ScenarioRun {
  result: RunResult;
  resultFile: RunResult;
  repo: string;
  runDir: string;
  events: FactoryEvent[];
  eventsText: string;
  runner: FakeRunner;
  github: FakeGitHub;
  slept: number[];
  file: (name: string) => string;
}

export async function runScenario(s: Scenario): Promise<ScenarioRun> {
  const repo = createFixtureRepo(s.patch);
  s.setup?.(repo);
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  s.before?.(repo, factoryHome);
  const scripted = FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", s.script), "utf8"))).steps;
  const runner = new FakeRunner(s.steps ? s.steps(scripted) : scripted);
  const agent: AgentRunner = { run: (req) => (s.onCall?.(req, repo), runner.run(req)) };
  const github = new FakeGitHub();
  s.github?.(github);
  const slept: number[] = [];
  const result = await runFactory(
    { repo, textFile: join(FIXTURES, "tasks", s.task ?? "multiply.md"), ...s.options },
    {
      runner: s.onCall ? agent : runner,
      github,
      profile: loadProfile(join(FIXTURES, "profile.yaml")),
      factoryHome,
      parentEnv: { ...process.env, FOO_TOKEN: SECRET },
      sleep: async (ms) => void slept.push(ms),
      ...s.deps,
    },
  );
  const [runId] = readdirSync(join(factoryHome, "runs"));
  const runDir = join(factoryHome, "runs", runId!);
  const eventsText = readFileSync(join(runDir, "events.jsonl"), "utf8");
  return {
    result,
    resultFile: JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as RunResult,
    repo,
    runDir,
    events: eventsText.trim().split("\n").map((l) => JSON.parse(l) as FactoryEvent),
    eventsText,
    runner,
    github,
    slept,
    file: (name) => readFileSync(join(runDir, name), "utf8"),
  };
}
