import { appendFileSync, existsSync, globSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { buildAgentEnv, prepareAgentHome } from "../agents/env.js";
import type { AgentRunner } from "../agents/runner.js";
import { type Layer, loadLayers, resolveProfile } from "../config.js";
import type { FactoryEvent, RunResult } from "../events.js";
import { killRunningCommands, resetKilledCommands, sh, tail } from "../exec.js";
import { FakeGitHub, type GitHub } from "../gh.js";
import { git, gitOk, revParse, withBaseWorktree } from "../git.js";
import { Interrupted } from "../interrupt.js";
import type { TrackedFinding } from "../pipeline/merge.js";
import { runFactory } from "../pipeline/run.js";
import type { Context7Client } from "../docs/context7.js";
import { gitCommonDir, type Jail, type Sandbox } from "../sandbox/sandbox.js";
import { type EvalProfile, EvalProfileSchema, type EvalRecord, EvalRecordSchema, type EvalTask, EvalTaskSchema } from "../schemas/eval.js";
import type { Profile } from "../schemas/profile.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
import { runChecks } from "../steps/gates.js";

/** Shipped eval assets (`evals/tasks`, `profiles`), relative to the package root. */
export const EVAL_TASKS_DIR = new URL("../../evals/tasks/", import.meta.url);
const PROFILES_DIR = new URL("../../profiles/", import.meta.url);

const EVAL_AUTHOR = ["-c", "user.name=factory-eval", "-c", "user.email=factory-eval@localhost"];

export class EvalError extends Error {}

const formatIssues = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

export function parseTask(text: string, source: string): EvalTask {
  const r = EvalTaskSchema.safeParse(parse(text));
  if (!r.success) throw new EvalError(`eval task ${source} is invalid: ${formatIssues(r.error.issues)}`);
  return r.data;
}

/** Tasks from a glob (default: the shipped `evals/tasks/*.yaml`), sorted by id; ids must be unique. */
export function loadTasks(pattern?: string, cwd = process.cwd()): EvalTask[] {
  const files = pattern
    ? globSync(pattern, { cwd }).map((f) => resolve(cwd, f))
    : existsSync(EVAL_TASKS_DIR)
      ? readdirSync(EVAL_TASKS_DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(EVAL_TASKS_DIR.pathname, f))
      : [];
  if (!files.length) throw new EvalError(`no eval tasks match ${pattern ?? EVAL_TASKS_DIR.pathname}`);
  const tasks = files.sort().map((f) => {
    const t = parseTask(readFileSync(f, "utf8"), f);
    // A local repo path is relative to its task file (tests, private task sets).
    return /^[a-z+]+:\/\//.test(t.repo) || isAbsolute(t.repo) ? t : { ...t, repo: resolve(dirname(f), t.repo) };
  });
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new EvalError(`duplicate eval task id ${t.id}`);
    seen.add(t.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export interface LoadedEvalProfile {
  /** Name in records and verdicts: the shipped profile name or the file's base name. */
  name: string;
  source: string;
  data: EvalProfile;
  /** Prompt replacements, read from their files. */
  prompts: Record<string, string>;
  /** Experiment variants: the base profile this one is layered on. */
  under?: LoadedEvalProfile;
}

/**
 * A variant on top of its base (`factory experiment`): model layers base < variant, prompts and
 * flags merged key by key. A variant then only states what it changes.
 */
export function layerOn(variant: LoadedEvalProfile, base: LoadedEvalProfile): LoadedEvalProfile {
  const flags = { ...base.data.flags, ...variant.data.flags };
  return { ...variant, prompts: { ...base.prompts, ...variant.prompts }, data: { ...variant.data, flags }, under: base };
}

/** `baseline` → `profiles/baseline.yaml`; anything with a `/` or `.yaml` is a path. */
export function loadEvalProfile(nameOrPath: string, cwd = process.cwd()): LoadedEvalProfile {
  const isPath = nameOrPath.includes("/") || /\.ya?ml$/.test(nameOrPath);
  const source = isPath ? resolve(cwd, nameOrPath) : join(PROFILES_DIR.pathname, `${nameOrPath}.yaml`);
  if (!existsSync(source)) throw new EvalError(`eval profile ${nameOrPath} not found (${source})`);
  const r = EvalProfileSchema.safeParse(parse(readFileSync(source, "utf8")) ?? {});
  if (!r.success) throw new EvalError(`eval profile ${source} is invalid: ${formatIssues(r.error.issues)}`);
  const prompts: Record<string, string> = {};
  for (const [name, file] of Object.entries(r.data.prompts ?? {})) {
    const path = resolve(dirname(source), file!);
    if (!existsSync(path)) throw new EvalError(`eval profile ${source}: prompt ${name} file ${path} not found`);
    prompts[name] = readFileSync(path, "utf8");
  }
  const name = isPath ? source.replace(/^.*\//, "").replace(/\.ya?ml$/, "") : nameOrPath;
  return { name, source, data: r.data, prompts };
}

/** built-in < user profile < (an experiment's base) < the eval profile's model layer; validated like any run (Zen guard, families). */
export function resolveEvalProfile(p: LoadedEvalProfile, factoryHome: string): Profile {
  const layer = (q: LoadedEvalProfile): Layer => ({ name: "cli", source: q.source, data: { roles: q.data.roles, retry: q.data.retry, env: q.data.env } });
  return resolveProfile([...loadLayers({ factoryHome }), ...(p.under ? [layer(p.under)] : []), layer(p)]);
}

/** A fresh clone at `base` with the task's repo.yaml committed on the base branch. Hidden tests are not fetched yet. */
export async function prepareTaskRepo(task: EvalTask, dir: string): Promise<RepoConfig> {
  mkdirSync(dir, { recursive: true });
  const branch = (task.repo_config?.base_branch as string | undefined) ?? "main";
  await git(dir, ["init", "-q", "-b", branch]);
  await git(dir, ["fetch", "-q", "--depth", "1", "--no-tags", task.repo, task.base]);
  await git(dir, ["checkout", "-q", "-B", branch, task.base]);
  appendFileSync(join(dir, ".git", "info", "exclude"), task.exclude.map((p) => `${p}\n`).join(""));
  if (task.repo_config) {
    mkdirSync(join(dir, ".factory"), { recursive: true });
    writeFileSync(join(dir, ".factory", "repo.yaml"), stringify(task.repo_config));
    await git(dir, ["add", ".factory/repo.yaml"]);
    await git(dir, [...EVAL_AUTHOR, "commit", "-q", "--no-verify", "-m", "eval: factory repo config"]);
  } else if (!existsSync(join(dir, ".factory", "repo.yaml"))) {
    throw new EvalError(`task ${task.id}: the repo has no .factory/repo.yaml at ${task.base}; add repo_config to the task`);
  }
  return loadRepoConfig(dir);
}

/** Fetches `from_commit` (after the run) and checks the hidden paths out into `cwd`. */
async function fetchHidden(task: EvalTask, repoDir: string): Promise<void> {
  if (!(await gitOk(repoDir, ["cat-file", "-e", `${task.hidden.from_commit}^{commit}`]))) {
    await git(repoDir, ["fetch", "-q", "--depth", "1", "--no-tags", task.repo, task.hidden.from_commit]);
  }
}

async function copyHidden(task: EvalTask, repoDir: string, cwd: string): Promise<void> {
  await fetchHidden(task, repoDir);
  await git(cwd, ["checkout", task.hidden.from_commit, "--", ...task.hidden.paths]);
}

export interface EvalDeps {
  /** Agent runner for a profile (the CLI: Pi; tests: the fake runner). */
  runner: (profile: LoadedEvalProfile, task: EvalTask, repeat: number) => AgentRunner;
  /** User factory home: profile layers and Pi credentials. Runs get their own home under `workDir`. */
  factoryHome: string;
  workDir: string;
  sandbox?: Sandbox;
  github?: GitHub;
  parentEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Aborts the whole eval (SIGINT/SIGTERM); the current run ends as failed. */
  signal?: AbortSignal;
  /** Keep clones and run homes (debugging). */
  keep?: boolean;
  /** Context7 client for `docs_lookup` (the profile's `docs_lookup.roles` decides who gets it). */
  docs?: Context7Client;
}

interface Env {
  env: Record<string, string>;
  jail?: Jail;
  home: string;
}

function envFor(deps: EvalDeps, repo: RepoConfig, root: string, cwd: string): Env {
  const home = prepareAgentHome(join(root, "check"));
  const env = buildAgentEnv(deps.parentEnv ?? process.env, { home, extra: repo.agent_env });
  const sandbox = deps.sandbox;
  if (!sandbox || sandbox.mode === "off") return { env, home };
  const common = gitCommonDir(cwd);
  return { env, home, jail: { sandbox, rw: [cwd, home], ro: common ? [common] : [], hide: [deps.factoryHome, join(root, "home")] } };
}

async function runHidden(task: EvalTask, deps: EvalDeps, repo: RepoConfig, root: string, cwd: string): Promise<{ pass: boolean; output: string }> {
  const { env, jail } = envFor(deps, repo, root, cwd);
  const r = await sh(task.hidden.check, { cwd, env, jail, timeoutMs: task.timeout_min * 60_000 });
  return { pass: r.code === 0, output: tail(r.output, 30) };
}

function readEvents(runDir: string): FactoryEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as FactoryEvent];
      } catch {
        return [];
      }
    });
}

const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined);

/** Findings per review round (`merged-<n>.json`) and the fix responses (`handoff-fix-<n>.json`). */
function roundFiles(runDir: string): { round: number; findings: TrackedFinding[]; fixed: Set<string> }[] {
  return readdirSync(runDir)
    .flatMap((f) => {
      const m = /^merged-(\d+)\.json$/.exec(f);
      return m ? [Number(m[1])] : [];
    })
    .sort((a, b) => a - b)
    .map((round) => {
      const merged = readJson<{ findings?: TrackedFinding[] }>(join(runDir, `merged-${round}.json`));
      const handoff = readJson<{ responses?: { finding_id: string; status: string }[] }>(join(runDir, `handoff-fix-${round}.json`));
      return { round, findings: merged?.findings ?? [], fixed: new Set((handoff?.responses ?? []).filter((r) => r.status === "fixed").map((r) => r.finding_id)) };
    });
}

/**
 * Real findings: a `bug` finding the implementer answered `fixed` in round n's fix
 * session counts when a check that is red on the commit reviewed in round n is green on the commit
 * after that fix. Checks: the hidden check (hidden tests copied in) and the repo's fast and full
 * checks that need no services. Several bugs fixed in one session share the credit.
 */
async function realFindings(task: EvalTask, deps: EvalDeps, repo: RepoConfig, root: string, repoDir: string, result: RunResult, events: FactoryEvent[]): Promise<number> {
  const heads = new Map<number, string>();
  for (const e of events) if (e.event === "round_finished" && typeof e.data.head === "string") heads.set(Number(e.data.round), e.data.head);
  const rounds = roundFiles(result.run_dir);
  const finalHead = result.branch ? await revParse(repoDir, result.branch).catch(() => undefined) : undefined;
  const cache = new Map<string, Map<string, boolean>>();
  const checks = repo.checks.filter((c) => (c.tier === "fast" || c.tier === "full") && !c.services?.length);
  const verify = async (sha: string): Promise<Map<string, boolean>> => {
    const hit = cache.get(sha);
    if (hit) return hit;
    const out = new Map<string, boolean>();
    await withBaseWorktree(repoDir, sha, join(root, `verify-${sha.slice(0, 12)}`), async (wt) => {
      await copyHidden(task, repoDir, wt);
      const { env, jail } = envFor(deps, repo, root, wt);
      if (repo.setup) {
        const s = await sh(repo.setup, { cwd: wt, env, jail, timeoutMs: task.timeout_min * 60_000 });
        if (s.code !== 0) return; // nothing verifiable on this commit
      }
      out.set("hidden", (await runHidden(task, deps, repo, root, wt)).pass);
      for (const r of await runChecks(checks, { cwd: wt, env, envCommand: repo.env_command, jail })) out.set(`check:${r.name}`, r.status !== "fail");
    });
    cache.set(sha, out);
    return out;
  };
  let real = 0;
  for (const { round, findings, fixed } of rounds) {
    const bugs = findings.filter((f) => f.severity === "bug" && f.round <= round && fixed.has(f.id));
    if (!bugs.length) continue;
    const pre = heads.get(round);
    const post = heads.get(round + 1) ?? finalHead;
    if (!pre || !post || pre === post) continue;
    const [a, b] = [await verify(pre), await verify(post)];
    if ([...a].some(([name, ok]) => !ok && b.get(name) === true)) real += bugs.length;
  }
  return real;
}

function metrics(events: FactoryEvent[], runDir: string | undefined) {
  const usage = new Map<string, EvalRecord["usage"][number]>();
  let gateFailures = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  for (const e of events) {
    tokensIn += e.tokens_in;
    tokensOut += e.tokens_out;
    cost += e.cost_usd;
    if (e.event === "gate_result" && !e.data.base && e.data.status === "fail") gateFailures++;
    if ((e.event === "agent_finished" || e.event === "agent_error") && e.role && e.model) {
      const key = `${e.role}\0${e.model}`;
      const billing = e.data.billing === "subscription" ? "subscription" : "metered";
      const u = usage.get(key) ?? { role: e.role, model: e.model, calls: 0, errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, billing };
      u.calls++;
      if (e.event === "agent_error") u.errors++;
      u.tokens_in += e.tokens_in;
      u.tokens_out += e.tokens_out;
      u.cost_usd = Math.round((u.cost_usd + e.cost_usd) * 1e6) / 1e6;
      usage.set(key, u);
    }
  }
  const last = runDir ? roundFiles(runDir).at(-1) : undefined;
  const bugs = (last?.findings ?? []).filter((f) => f.severity === "bug").length;
  return { usage: [...usage.values()], gateFailures, tokensIn, tokensOut, cost: Math.round(cost * 1e6) / 1e6, bugs };
}

/** One task × profile × repeat: fresh clone at base → `run --no-pr` → hidden tests → metrics. */
export async function evalOne(task: EvalTask, profile: LoadedEvalProfile, repeat: number, deps: EvalDeps): Promise<EvalRecord> {
  const now = deps.now ?? Date.now;
  const started = now();
  const root = join(deps.workDir, `${task.id}--${profile.name}--${repeat}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const repoDir = join(root, "repo");
  const base = {
    version: 1 as const,
    started_at: new Date(started).toISOString(),
    task: task.id,
    profile: profile.name,
    repeat,
    run_id: null as string | null,
    hidden_pass: false,
    hidden_output: "",
    rounds: 0,
    gate_failures: 0,
    bug_findings: 0,
    real_findings: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    usage: [] as EvalRecord["usage"],
    timed_out: false,
  };
  const timeout = new AbortController();
  const onOuter = () => timeout.abort(deps.signal!.reason);
  deps.signal?.addEventListener("abort", onOuter, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const repo = await prepareTaskRepo(task, repoDir);
    const runProfile = resolveEvalProfile(profile, deps.factoryHome);
    const taskFile = join(root, "task.md");
    writeFileSync(taskFile, task.task);
    timer = setTimeout(() => {
      timedOut = true;
      killRunningCommands(`eval timeout after ${task.timeout_min} min`);
      timeout.abort(new Interrupted(`eval timeout (${task.timeout_min} min)`));
    }, task.timeout_min * 60_000);
    let result: RunResult;
    const runner = deps.runner(profile, task, repeat);
    try {
      result = await runFactory(
        { repo: repoDir, textFile: taskFile, lane: profile.data.flags?.lane ?? "standard", planEffort: profile.data.flags?.plan_effort ?? task.plan_effort, noPr: true },
        {
          runner,
          github: deps.github ?? new FakeGitHub(),
          profile: runProfile,
          factoryHome: join(root, "home"),
          parentEnv: deps.parentEnv,
          sandbox: deps.sandbox,
          signal: timeout.signal,
          prompts: profile.prompts,
          ...(deps.docs ? { docs: deps.docs } : {}),
        },
      );
    } finally {
      clearTimeout(timer);
      if (timedOut) resetKilledCommands();
      await runner.close?.().catch(() => undefined);
    }
    const events = readEvents(result.run_dir);
    const m = metrics(events, result.run_dir);
    let hidden = { pass: false, output: "no worktree: the run stopped before implementing" };
    if (result.worktree && existsSync(result.worktree) && !deps.signal?.aborted) {
      await copyHidden(task, repoDir, result.worktree);
      hidden = await runHidden(task, deps, repo, root, result.worktree);
    }
    const real = deps.signal?.aborted ? 0 : await realFindings(task, deps, repo, root, repoDir, result, events);
    return EvalRecordSchema.parse({
      ...base,
      run_id: result.run_id,
      result: result.result,
      reason: result.reason,
      hidden_pass: hidden.pass,
      hidden_output: hidden.output,
      rounds: result.rounds,
      gate_failures: m.gateFailures,
      bug_findings: m.bugs,
      real_findings: real,
      tokens_in: m.tokensIn,
      tokens_out: m.tokensOut,
      cost_usd: m.cost,
      usage: m.usage,
      wall_s: Math.round((now() - started) / 100) / 10,
      timed_out: timedOut,
    });
  } catch (e) {
    return EvalRecordSchema.parse({ ...base, result: "error", reason: String((e as Error).message ?? e).slice(0, 1000), wall_s: Math.round((now() - started) / 100) / 10, timed_out: timedOut });
  } finally {
    deps.signal?.removeEventListener("abort", onOuter);
    if (!deps.keep) {
      // Detached verify worktrees are removed by withBaseWorktree; the run worktree lives under root.
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export interface EvalPlan {
  tasks: EvalTask[];
  profiles: LoadedEvalProfile[];
  repeat: number;
}

/** Every task × repeat × profile, interleaved per task and repeat so drift (quota, provider load) hits all profiles alike. */
export async function runEval(plan: EvalPlan, deps: EvalDeps, onRecord?: (r: EvalRecord) => void): Promise<EvalRecord[]> {
  const records: EvalRecord[] = [];
  for (const task of plan.tasks) {
    for (let rep = 1; rep <= plan.repeat; rep++) {
      for (const profile of plan.profiles) {
        if (deps.signal?.aborted) return records;
        const r = await evalOne(task, profile, rep, deps);
        records.push(r);
        onRecord?.(r);
      }
    }
  }
  return records;
}

/** Appends records to `<dir>/<date>.jsonl` (UTC date of the first record). Returns the path. */
export function writeResults(dir: string, records: EvalRecord[], date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));
  return path;
}


export interface TaskValidation {
  task: string;
  ok: boolean;
  /** Hidden check on `base` with the hidden tests copied in: must fail (the task is not solved yet). */
  base_red: boolean;
  /** Hidden check on `from_commit` (the upstream fix): must pass. */
  fix_green: boolean;
  detail: string;
}

/**
 * `eval --validate`: no agents. Per task: clone at base, setup, hidden check with the hidden tests
 * copied in (red expected), then the same on `from_commit` (green expected). Catches broken setups,
 * wrong shas and checks before any model time is spent.
 */
export async function validateTask(task: EvalTask, deps: Pick<EvalDeps, "factoryHome" | "workDir" | "sandbox" | "parentEnv" | "keep">): Promise<TaskValidation> {
  const root = join(deps.workDir, `${task.id}--validate`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const repoDir = join(root, "repo");
  const d = deps as EvalDeps;
  try {
    const repo = await prepareTaskRepo(task, repoDir);
    // Bug plans need `tests.run` for the red-green proof; without it every bug run ends needs_human.
    if (!repo.tests.run) return { task: task.id, ok: false, base_red: false, fix_green: false, detail: "repo.yaml tests.run is missing: bug plans would stop with needs_human" };
    const at = async (sha: string, label: string) =>
      withBaseWorktree(repoDir, sha, join(root, label), async (wt) => {
        await copyHidden(task, repoDir, wt);
        const { env, jail } = envFor(d, repo, root, wt);
        if (repo.setup) {
          const s = await sh(repo.setup, { cwd: wt, env, jail, timeoutMs: task.timeout_min * 60_000 });
          if (s.code !== 0) return { pass: false, output: `setup failed: ${tail(s.output, 15)}` };
        }
        return runHidden(task, d, repo, root, wt);
      });
    const head = await revParse(repoDir, "HEAD");
    const onBase = await at(head, "base");
    await fetchHidden(task, repoDir);
    // The fix commit plus the eval repo config (the check may rely on repo.yaml setup only).
    const onFix = await at(task.hidden.from_commit, "fix");
    const ok = !onBase.pass && onFix.pass && !/^setup failed/.test(onBase.output);
    const detail = ok ? "base red, fix green" : `base ${onBase.pass ? "green (hidden tests do not detect the missing change)" : "red"}: ${onBase.output.slice(-600)}\nfix ${onFix.pass ? "green" : "red"}: ${onFix.output.slice(-600)}`;
    return { task: task.id, ok, base_red: !onBase.pass, fix_green: onFix.pass, detail };
  } catch (e) {
    return { task: task.id, ok: false, base_red: false, fix_green: false, detail: (e as Error).message.slice(0, 1000) };
  } finally {
    if (!deps.keep) rmSync(root, { recursive: true, force: true });
  }
}
