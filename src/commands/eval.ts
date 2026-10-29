import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { decide, DecisionError, markdownTable, summarize } from "../eval/report.js";
import { type EvalDeps, EvalError, layerOn, loadEvalProfile, loadTasks, runEval, validateTask, writeResults } from "../eval/eval.js";
import type { EvalRecord, Verdict } from "../schemas/eval.js";
import { VerdictSchema } from "../schemas/eval.js";

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface EvalCommandOptions {
  profiles: string[];
  tasks?: string;
  repeat: number;
  /** Results directory (default `evals/results` in the current directory). */
  out?: string;
  json?: boolean;
  cwd?: string;
}

function progress(io: Io) {
  return (r: EvalRecord) =>
    io.err(`eval ${r.task} × ${r.profile} #${r.repeat}: ${r.result}, hidden ${r.hidden_pass ? "pass" : "fail"}, ${r.wall_s}s${r.reason && r.result !== "done" ? ` (${r.reason.slice(0, 120)})` : ""}\n`);
}

/** Writes `<out>/<date>.jsonl` (appended) and `<out>/<date>.md` (a section per invocation). */
function persist(outDir: string, records: EvalRecord[], profiles: string[], heading: string, date: Date): { jsonl: string; md: string; table: string } {
  const jsonl = writeResults(outDir, records, date);
  const table = markdownTable(records, profiles);
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, `${date.toISOString().slice(0, 10)}.md`);
  appendFileSync(md, `## ${heading} (${date.toISOString()})\n\n${table}\n`);
  return { jsonl, md, table };
}

/** `factory eval --profile a [--profile b] [--tasks <glob>] [--repeat N]` (§13). */
export async function evalCommand(opts: EvalCommandOptions, deps: Omit<EvalDeps, "now">, io: Io): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    if (!opts.profiles.length) throw new EvalError("eval needs at least one --profile");
    if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new EvalError(`--repeat must be a positive integer (got ${opts.repeat})`);
    const profiles = opts.profiles.map((p) => loadEvalProfile(p, cwd));
    const names = profiles.map((p) => p.name);
    if (new Set(names).size !== names.length) throw new EvalError(`profile names must differ (${names.join(", ")})`);
    const tasks = loadTasks(opts.tasks, cwd);
    const date = new Date();
    const records = await runEval({ tasks, profiles, repeat: opts.repeat }, deps, progress(io));
    const files = persist(resolve(cwd, opts.out ?? "evals/results"), records, names, `eval ${names.join(" vs ")} × ${tasks.length} tasks × ${opts.repeat}`, date);
    const summaries = names.map((n) => summarize(n, records));
    if (opts.json) io.out(JSON.stringify({ results_file: files.jsonl, summaries, records }) + "\n");
    else io.out(`${files.table}\nresults: ${files.jsonl}\n`);
    return deps.signal?.aborted ? 130 : 0;
  } catch (e) {
    if (e instanceof EvalError) {
      io.err(`factory eval: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

export interface ExperimentOptions {
  base: string;
  variant: string;
  tasks?: string;
  repeat: number;
  out?: string;
  cwd?: string;
}

/**
 * `factory experiment --base <profile> --variant <profile>` (§13): eval of both, the decision rule,
 * a JSON verdict (schemas/verdict.schema.json) on stdout. Exit 0 for every verdict; 2 on bad input.
 */
export async function experimentCommand(opts: ExperimentOptions, deps: Omit<EvalDeps, "now">, io: Io): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  try {
    if (!Number.isInteger(opts.repeat) || opts.repeat < 2) throw new EvalError(`experiment needs --repeat ≥ 2 (got ${opts.repeat})`);
    const base = loadEvalProfile(opts.base, cwd);
    // The variant only states what it changes: it is layered on the base.
    const variant = layerOn(loadEvalProfile(opts.variant, cwd), base);
    if (base.name === variant.name) throw new EvalError(`base and variant have the same name (${base.name}); rename one file`);
    const tasks = loadTasks(opts.tasks, cwd);
    const date = new Date();
    const records = await runEval({ tasks, profiles: [base, variant], repeat: opts.repeat }, deps, progress(io));
    if (deps.signal?.aborted) {
      io.err("factory experiment: interrupted; no verdict\n");
      return 130;
    }
    const files = persist(resolve(cwd, opts.out ?? "evals/results"), records, [base.name, variant.name], `experiment ${base.name} vs ${variant.name}`, date);
    const summaries = { base: summarize(base.name, records), variant: summarize(variant.name, records) };
    const verdict: Verdict = VerdictSchema.parse({
      version: 1,
      base: base.name,
      variant: variant.name,
      tasks: tasks.map((t) => t.id),
      repeat: opts.repeat,
      ...decide(summaries.base, summaries.variant, opts.repeat),
      summaries,
      results_file: files.jsonl,
      table: files.table,
    });
    io.out(JSON.stringify(verdict) + "\n");
    return 0;
  } catch (e) {
    if (e instanceof EvalError || e instanceof DecisionError) {
      io.err(`factory experiment: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

/** `factory eval --validate [--tasks <glob>]`: hidden tests red on base, green on the upstream fix; no agents. */
export async function validateCommand(opts: { tasks?: string; json?: boolean; cwd?: string }, deps: Pick<EvalDeps, "factoryHome" | "workDir" | "sandbox" | "parentEnv" | "keep">, io: Io): Promise<number> {
  try {
    const tasks = loadTasks(opts.tasks, opts.cwd ?? process.cwd());
    const results = [];
    for (const t of tasks) {
      const v = await validateTask(t, deps);
      io.err(`validate ${t.id}: ${v.ok ? "ok" : "FAIL"}\n`);
      results.push(v);
    }
    if (opts.json) io.out(JSON.stringify({ tasks: results }) + "\n");
    else for (const v of results) io.out(`${v.ok ? "ok  " : "FAIL"} ${v.task}${v.ok ? "" : `\n${v.detail.replace(/^/gm, "     ")}`}\n`);
    return results.every((v) => v.ok) ? 0 : 1;
  } catch (e) {
    if (e instanceof EvalError) {
      io.err(`factory eval: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
