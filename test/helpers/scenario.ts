import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRunner, FakeScriptSchema, type FakeStep } from "../../src/agents/fake-runner.js";
import type { AgentRequest, AgentRunner } from "../../src/agents/runner.js";
import type { FactoryEvent, RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import type { RunDeps } from "../../src/pipeline/context.js";
import { resumeFactory, type RunOptions, runFactory } from "../../src/pipeline/run.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { createFixtureRepo, FIXTURES } from "./repo.js";

export const SECRET = "fake-foo-token-value-0123456789";

export interface Scenario {
  script: string;
  task?: string;
  patch?: (cfg: Record<string, unknown>) => void;
  /** Fixture repo under test/fixtures (default `repo`; `ui-repo` has a web app). */
  fixture?: string;
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
  factoryHome: string;
  runId: string;
  slept: number[];
  file: (name: string) => string;
}

export async function runScenario(s: Scenario): Promise<ScenarioRun> {
  const repo = createFixtureRepo(s.patch, s.fixture);
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
  return collect(result, repo, factoryHome, runId!, runner, github, slept);
}

function collect(result: RunResult, repo: string, factoryHome: string, runId: string, runner: FakeRunner, github: FakeGitHub, slept: number[]): ScenarioRun {
  const runDir = join(factoryHome, "runs", runId);
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
    factoryHome,
    runId,
    slept,
    file: (name) => readFileSync(join(runDir, name), "utf8"),
  };
}

export interface ResumeScenario {
  /** Scripted steps for the resumed run (taken from `script`, optionally filtered by `steps`). */
  script: string;
  steps?: (steps: FakeStep[]) => FakeStep[];
  options?: { wait?: boolean; noPr?: boolean };
  deps?: Partial<RunDeps>;
}

/** Resumes a previous scenario run with the same repo, factory home and (fake) GitHub. */
export async function resumeScenario(prev: ScenarioRun, s: ResumeScenario): Promise<ScenarioRun> {
  const scripted = FakeScriptSchema.parse(JSON.parse(readFileSync(join(FIXTURES, "scripts", s.script), "utf8"))).steps;
  const runner = new FakeRunner(s.steps ? s.steps(scripted) : scripted);
  const slept: number[] = [];
  const result = await resumeFactory(prev.runId, s.options ?? {}, {
    runner,
    github: prev.github,
    profile: loadProfile(join(FIXTURES, "profile.yaml")),
    factoryHome: prev.factoryHome,
    parentEnv: { ...process.env, FOO_TOKEN: SECRET },
    sleep: async (ms) => void slept.push(ms),
    ...s.deps,
  });
  return collect(result, prev.repo, prev.factoryHome, prev.runId, runner, prev.github, slept);
}
