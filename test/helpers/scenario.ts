import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import type { FactoryEvent, RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
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
  const factoryHome = mkdtempSync(join(tmpdir(), "factory-home-"));
  const runner = FakeRunner.fromFile(join(FIXTURES, "scripts", s.script));
  const github = new FakeGitHub();
  s.github?.(github);
  const slept: number[] = [];
  const result = await runFactory(
    { repo, textFile: join(FIXTURES, "tasks", s.task ?? "multiply.md"), ...s.options },
    {
      runner,
      github,
      profile: loadProfile(join(FIXTURES, "profile.yaml")),
      factoryHome,
      parentEnv: { ...process.env, FOO_TOKEN: SECRET },
      sleep: async (ms) => void slept.push(ms),
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
