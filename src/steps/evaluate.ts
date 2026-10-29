import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { InvalidOutputError } from "../agents/models.js";
import { extractJson } from "../agents/runner.js";
import { browsersPath, type ConsoleEntry, EvalBrowser, findHeadlessShell, INSTALL_HINT, knownDevice, type NetworkEntry } from "../evaluate/browser.js";
import { videoToGif } from "../evaluate/gif.js";
import { diffPngs } from "../evaluate/pixeldiff.js";
import { BrowserSession } from "../evaluate/tools.js";
import { sh, tail } from "../exec.js";
import { changedFiles, withBaseWorktree } from "../git.js";
import { agentEnv, callAgent, jailFor, type RunContext, runServices, writeJson } from "../pipeline/context.js";
import { findingKey, type TrackedFinding } from "../pipeline/merge.js";
import { asData, rolePrompt } from "../prompts.js";
import { matchesAny } from "../schemas/plan.js";
import type { RepoConfig } from "../schemas/repo.js";
import { type Finding, FindingSchema, type ReviewOutput } from "../schemas/review.js";
import { shellQuote } from "../sandbox/sandbox.js";
import { EnvMissing, Services } from "../services.js";

/**
 * Evaluate (§6.5, Amendment x): code first (app start, recorded flows, console/network capture, pixel
 * diff base vs HEAD), then the `evaluate` LLM session for `verify: evaluator` criteria. Output is a
 * review (`reviewer: evaluator`); every code finding has a stable claim so it dedupes across rounds.
 * Artifacts land in `runs/<id>/evidence/` and are listed in `evaluate-<round>.json`.
 */

export type Area = RepoConfig["verify"]["areas"][number];

export interface FlowResult {
  area: string;
  files: string[];
  status: "pass" | "fail" | "skipped";
  /** A package of the plan declares `changes_flows` for this area. */
  changes_flows: boolean;
  output?: string;
}

export interface PageCheck {
  device: string;
  page: string;
  head: string;
  base?: string;
  diff?: string;
  diff_ratio?: number;
  new_console: ConsoleEntry[];
  new_network: NetworkEntry[];
}

export interface CriterionResult {
  id: string;
  met: boolean;
  screenshot?: string;
  note: string;
}

export interface EvidenceItem {
  kind: "screenshot" | "diff" | "gif" | "video";
  file: string;
  label: string;
}

export interface EvaluateReport {
  round: number;
  url: string;
  devices: string[];
  areas: string[];
  flows: FlowResult[];
  pages: PageCheck[];
  base_error?: string;
  criteria: CriterionResult[];
  evidence: EvidenceItem[];
  notes: string[];
  review: ReviewOutput;
}

/** True when the run has a ui and the change touches `ui.paths` (none declared = any change). */
export function evaluateApplies(repo: RepoConfig, changed: string[]): boolean {
  if (!repo.ui) return false;
  return repo.ui.paths.length === 0 ? changed.length > 0 : changed.some((f) => matchesAny(f, repo.ui!.paths));
}

/** Areas whose paths the change touches. */
export function affectedAreas(repo: RepoConfig, changed: string[]): Area[] {
  return repo.verify.areas.filter((a) => changed.some((f) => matchesAny(f, a.paths)));
}

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

/** Console/network entries comparable across base and HEAD (other ports, hashes, positions). */
export function normalizeEntry(text: string, origin: string): string {
  return text
    .split(origin).join("")
    .replace(/https?:\/\/(localhost|127\.0\.0\.1):\d+/g, "")
    .replace(/\?[^\s"']*/g, "")
    .replace(/:\d+:\d+/g, "")
    .replace(/\b[0-9a-f]{8,}\b/g, "#")
    .trim();
}

const consoleKey = (e: ConsoleEntry, origin: string) => `${e.kind}:${normalizeEntry(e.text, origin)}`;
const networkKey = (e: NetworkEntry, origin: string) => `${e.method} ${normalizeEntry(e.url, origin)} ${e.status ?? e.failure}`;

/** Flow findings: a red flow is a bug; the claim says whether it is a regression (§6.5 step 2). */
export function flowFindings(flows: FlowResult[]): Finding[] {
  return flows
    .filter((f) => f.status === "fail")
    .map((f) => ({
      severity: "bug" as const,
      file: f.files[0] ?? "",
      line: 0,
      claim: f.changes_flows
        ? `recorded flow of area ${f.area} fails after the planned flow change (update the flow and the guide)`
        : `regression: recorded flow of area ${f.area} fails (no package changes its flows)`,
      evidence: f.output ?? "",
      fix: "",
      checkable: "test" as const,
      check_sketch: "",
    }));
}

/** New console errors and failed requests on HEAD: bugs without LLM judgment (§6.5 step 3). */
export function pageFindings(pages: PageCheck[]): Finding[] {
  const out: Finding[] = [];
  for (const p of pages) {
    for (const e of p.new_console)
      out.push({ severity: "bug", file: "", line: 0, claim: `new ${e.kind === "pageerror" ? "uncaught page error" : "console error"} on ${p.page} (${p.device}): ${e.text.slice(0, 200)}`, evidence: e.url, fix: "", checkable: "test", check_sketch: "" });
    for (const e of p.new_network)
      out.push({ severity: "bug", file: "", line: 0, claim: `new failed request on ${p.page} (${p.device}): ${e.method} ${new URL(e.url).pathname} → ${e.status ?? e.failure}`, evidence: e.url, fix: "", checkable: "test", check_sketch: "" });
  }
  return out;
}

const CriterionSchema = z.object({ id: z.string().min(1), met: z.boolean(), screenshot: z.string().default(""), note: z.string().default("") });
export const EvaluatorOutputSchema = z.object({ criteria: z.array(CriterionSchema).default([]), findings: z.array(FindingSchema).default([]) });

const OUTPUT_SHAPE = `Reply with a single \`\`\`json block:
{"criteria":[{"id":"A1","met":true,"screenshot":"A1","note":"what you did and saw"}],
 "findings":[{"severity":"bug|suggestion|nit","file":"","line":0,"claim":"","evidence":"","fix":""}]}`;

/** Every criterion answered once, with a screenshot the session really took. */
export function validateCriteria(out: z.infer<typeof EvaluatorOutputSchema>, ids: string[], shots: Map<string, string>): string[] {
  const errors: string[] = [];
  for (const id of ids) {
    const c = out.criteria.filter((x) => x.id === id);
    if (c.length !== 1) errors.push(`criterion ${id}: answer it exactly once`);
    else if (!shots.has(c[0]!.screenshot)) errors.push(`criterion ${id}: screenshot "${c[0]!.screenshot}" was not taken (call screenshot with that name)`);
  }
  for (const c of out.criteria) if (!ids.includes(c.id)) errors.push(`unknown criterion ${c.id}`);
  return errors;
}

/** Unmet criteria → bugs with a stable claim (the model's note is the evidence). */
export function criteriaFindings(criteria: CriterionResult[]): Finding[] {
  return criteria
    .filter((c) => !c.met)
    .map((c) => ({ severity: "bug" as const, file: "", line: 0, claim: `acceptance criterion ${c.id} is not met in the running app`, evidence: c.note, fix: "", checkable: "no" as const, check_sketch: "" }));
}

/** Verdicts on the evaluator's prior open findings, in code: found again → still open, else resolved. */
export function priorVerdicts(prior: TrackedFinding[], findings: Finding[]): ReviewOutput["prior"] {
  const now = new Set(findings.map(findingKey));
  return prior
    .filter((f) => f.reviewer === "evaluator" && f.status === "open")
    .map((f) => ({
      finding_id: f.id,
      verdict: now.has(findingKey(f)) ? (f.response?.status === "wontfix" ? ("reject_wontfix" as const) : ("still_open" as const)) : ("resolved" as const),
    }));
}

interface Capture {
  shot: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/** Screenshots and console/network of every device × page, one browser per device. */
async function capturePages(
  ctx: RunContext,
  opts: { url: string; reach: number[]; devices: string[]; pages: string[]; dir: string; prefix: string; cwd: string },
): Promise<Map<string, Capture>> {
  const out = new Map<string, Capture>();
  for (const device of opts.devices) {
    const b = await EvalBrowser.launch({ jail: jailFor(ctx, opts.cwd), reach: opts.reach, device, env: agentEnv(ctx) });
    try {
      for (const page of opts.pages) {
        const c0 = b.console.length;
        const n0 = b.network.length;
        const shot = `${opts.prefix}-${slug(device)}-${slug(page)}.png`;
        try {
          await b.page.goto(new URL(page, opts.url).href, { waitUntil: "load" });
          await b.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
          writeFileSync(join(opts.dir, shot), await b.page.screenshot({ fullPage: true }));
        } catch (e) {
          b.network.push({ method: "GET", url: new URL(page, opts.url).href, status: null, failure: (e as Error).message.split("\n")[0] });
        }
        out.set(`${device}|${page}`, { shot: existsSync(join(opts.dir, shot)) ? shot : "", console: b.console.slice(c0), network: b.network.slice(n0) });
      }
    } finally {
      await b.close();
    }
  }
  return out;
}

/** Base captures: once per run, from a base worktree with its own services and port slot. */
async function baseCaptures(ctx: RunContext, devices: string[], pages: string[], dir: string): Promise<{ captures: Map<string, Capture>; origin: string } | { error: string }> {
  const cacheFile = join(dir, "base-captures.json");
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { origin: string; captures: [string, Capture][] } | { error: string };
    if ("error" in cached) return cached;
    const captures = new Map(cached.captures);
    if (devices.every((d) => pages.every((p) => captures.has(`${d}|${p}`)))) return { captures, origin: cached.origin };
  }
  const ui = ctx.repo.ui!;
  const result = await withBaseWorktree(ctx.repoDir, ctx.baseSha, join(ctx.runDir, "eval-base"), async (wt) => {
    const env = agentEnv(ctx);
    const jail = jailFor(ctx, wt);
    if (ctx.repo.setup) {
      const s = await sh(ctx.repo.setup, { cwd: wt, env, jail, timeoutMs: 30 * 60_000 });
      if (s.code !== 0) return { error: `setup failed on base (exit ${s.code}): ${tail(s.output, 5)}` };
    }
    const services = new Services(ctx.repo, {
      runId: `${ctx.runId}-base`,
      logDir: join(ctx.runDir, "services-base"),
      cwd: wt,
      env,
      factoryHome: ctx.deps.factoryHome,
      jail,
      onEvent: (action, data) => void ctx.events.emit({ step: "evaluate", event: "service", data: { action, base: true, ...data } }),
    });
    try {
      const names = [...ui.services, "ui"];
      await services.ensure(names);
      const url = await services.expand(ui.url);
      const captures = await capturePages(ctx, { url, reach: services.reachOf(names), devices, pages, dir, prefix: "base", cwd: wt });
      return { captures, origin: new URL(url).origin };
    } catch (e) {
      return { error: `base app: ${(e as Error).message.split("\n")[0]}` };
    } finally {
      await services.stopAll();
    }
  });
  writeFileSync(cacheFile, JSON.stringify("error" in result ? result : { origin: result.origin, captures: [...result.captures] }));
  return result;
}

/** Recorded flows of the affected areas, jailed, reaching the app (§6.5 step 2). */
async function runFlows(ctx: RunContext, services: Services, areas: Area[], url: string, reach: number[], notes: string[]): Promise<FlowResult[]> {
  const run = ctx.repo.verify.run ?? ctx.repo.tests.run;
  const changes = new Set(ctx.plan.packages.flatMap((p) => p.changes_flows));
  const out: FlowResult[] = [];
  for (const area of areas) {
    if (!area.flows.length) continue;
    const base = { area: area.name, files: area.flows, changes_flows: changes.has(area.name) };
    if (!run) {
      notes.push(`flows of ${area.name} not run: no verify.run or tests.run`);
      out.push({ ...base, status: "skipped" });
      continue;
    }
    const cmd = (await services.expand(run)).replaceAll("{files}", area.flows.map(shellQuote).join(" "));
    const browsers = browsersPath();
    const env = { ...agentEnv(ctx), ...(await services.envOf([...(ctx.repo.ui?.services ?? []), "ui"])), BASE_URL: url, PLAYWRIGHT_BROWSERS_PATH: browsers };
    const jail = services.jailWith({ reach });
    const r = await sh(cmd, { cwd: ctx.worktree, env, jail: jail ? { ...jail, ro: [...jail.ro, browsers, "/etc/fonts"] } : undefined, timeoutMs: 15 * 60_000 });
    out.push({ ...base, status: r.code === 0 ? "pass" : "fail", ...(r.code === 0 ? {} : { output: tail(r.output, 30) }) });
    ctx.events.emit({ step: "evaluate", event: "progress", data: { flow: area.name, status: r.code === 0 ? "pass" : "fail" } });
  }
  return out;
}

/** The LLM session over the `verify: evaluator` criteria, with browser tools and a video. */
async function llmSession(
  ctx: RunContext,
  input: { round: number; url: string; reach: number[]; areas: Area[]; device: string; dir: string; prior: TrackedFinding[] },
  evidence: EvidenceItem[],
  notes: string[],
): Promise<{ criteria: CriterionResult[]; findings: Finding[] }> {
  const criteria = ctx.plan.acceptance.filter((a) => a.verify === "evaluator");
  if (!criteria.length) return { criteria: [], findings: [] };
  const videoDir = join(input.dir, `video-${input.round}`);
  const b = await EvalBrowser.launch({ jail: jailFor(ctx, ctx.worktree), reach: input.reach, device: input.device, env: agentEnv(ctx), videoDir });
  const session = new BrowserSession(b, { baseUrl: input.url, evidenceDir: input.dir, prefix: `r${input.round}` });
  const areas = input.areas.length ? input.areas : ctx.repo.verify.areas;
  const guides = areas
    .filter((a) => a.guide && existsSync(join(ctx.worktree, a.guide)))
    .map((a) => asData(`guide_${slug(a.name)}`, readFileSync(join(ctx.worktree, a.guide!), "utf8")));
  const prior = input.prior.filter((f) => f.reviewer === "evaluator" && f.status === "open").map(({ id, claim, response }) => ({ id, claim, response: response ?? null }));
  let prompt = [
    `The app runs at ${input.url} (device: ${input.device}).`,
    asData("criteria", JSON.stringify(criteria.map(({ id, text, package: pkg }) => ({ id, package: pkg, text })), null, 2)),
    ...guides,
    prior.length ? asData("prior_evaluator_findings", JSON.stringify(prior, null, 2)) : "",
    OUTPUT_SHAPE,
  ].filter(Boolean).join("\n\n");
  let errors: string[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await callAgent(ctx, "evaluate", {
        role: "evaluate",
        cwd: ctx.worktree,
        tools: "read_only",
        system: rolePrompt("evaluate", ctx.deps.prompts),
        prompt,
        browser: session,
        sessionKey: `${ctx.runId}-evaluate-${input.round}`,
      });
      const parsed = EvaluatorOutputSchema.safeParse(extractJson(res.text));
      if (parsed.success) {
        errors = validateCriteria(parsed.data, criteria.map((c) => c.id), session.screenshots);
        if (!errors.length) {
          const results = parsed.data.criteria.map((c) => ({ id: c.id, met: c.met, note: c.note, screenshot: session.screenshots.get(c.screenshot) }));
          for (const c of results) if (c.screenshot) evidence.push({ kind: "screenshot", file: c.screenshot, label: c.id });
          return { criteria: results, findings: parsed.data.findings };
        }
      } else errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      prompt = `Your evaluation output was invalid:\n- ${errors.join("\n- ")}\n\n${OUTPUT_SHAPE}`;
    }
    throw new InvalidOutputError(`evaluate output invalid: ${errors.join("; ")}`);
  } finally {
    const videos = await b.close();
    writeJson(ctx, `evaluate-${input.round}-tools.json`, session.calls);
    for (const [i, v] of videos.entries()) {
      const name = `r${input.round}-session${i ? `-${i + 1}` : ""}`;
      renameSync(v, join(input.dir, `${name}.webm`));
      evidence.push({ kind: "video", file: `${name}.webm`, label: `session ${input.device}` });
      const err = await videoToGif(join(input.dir, `${name}.webm`), join(input.dir, `${name}.gif`), { env: agentEnv(ctx), jail: jailFor(ctx, input.dir) });
      if (err) notes.push(`gif: ${err}`);
      else evidence.push({ kind: "gif", file: `${name}.gif`, label: `session ${input.device}` });
    }
  }
}

/**
 * One evaluate round. Returns undefined when it does not apply (no ui, or `ui.paths` untouched).
 * Service failures throw EnvMissing (→ needs_human, like a check that needs a service).
 */
export async function evaluateRound(ctx: RunContext, round: number, prior: TrackedFinding[]): Promise<EvaluateReport | undefined> {
  const ui = ctx.repo.ui;
  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  if (!ui || !evaluateApplies(ctx.repo, changed)) return undefined;
  const unknown = ui.devices.filter((d) => !knownDevice(d));
  if (unknown.length) throw new EnvMissing(`ui.devices: unknown Playwright device ${unknown.join(", ")}`);
  if (!findHeadlessShell()) throw new EnvMissing(`no Chromium headless shell under ${browsersPath()} (install: ${INSTALL_HINT})`);
  ctx.events.emit({ step: "evaluate", event: "step_started", data: { round } });
  const dir = join(ctx.runDir, "evidence");
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const evidence: EvidenceItem[] = [];

  ctx.services ??= runServices(ctx);
  const names = [...ui.services, "ui"];
  await ctx.services.ensure(names);
  const url = await ctx.services.expand(ui.url);
  const reach = ctx.services.reachOf(names);
  const origin = new URL(url).origin;
  const areas = affectedAreas(ctx.repo, changed);

  const flows = await runFlows(ctx, ctx.services, areas, url, reach, notes);

  const pages = [...new Set([...ui.pages, ...areas.flatMap((a) => a.pages)])];
  const head = await capturePages(ctx, { url, reach, devices: ui.devices, pages, dir, prefix: `r${round}`, cwd: ctx.worktree });
  const base = await baseCaptures(ctx, ui.devices, pages, dir);
  if ("error" in base) notes.push(`no base comparison: ${base.error}`);
  const checks: PageCheck[] = [];
  for (const device of ui.devices) {
    for (const page of pages) {
      const h = head.get(`${device}|${page}`)!;
      const b = "error" in base ? undefined : base.captures.get(`${device}|${page}`);
      const seenC = new Set((b?.console ?? []).map((e) => consoleKey(e, "error" in base ? origin : base.origin)));
      const seenN = new Set((b?.network ?? []).map((e) => networkKey(e, "error" in base ? origin : base.origin)));
      const check: PageCheck = {
        device,
        page,
        head: h.shot,
        new_console: h.console.filter((e) => !seenC.has(consoleKey(e, origin))),
        new_network: h.network.filter((e) => !seenN.has(networkKey(e, origin))),
      };
      if (h.shot) evidence.push({ kind: "screenshot", file: h.shot, label: `${page} (${device})` });
      if (b?.shot && h.shot) {
        const d = diffPngs(readFileSync(join(dir, b.shot)), readFileSync(join(dir, h.shot)));
        check.base = b.shot;
        check.diff_ratio = Number(d.ratio.toFixed(4));
        if (d.pixels > 0) {
          check.diff = `r${round}-diff-${slug(device)}-${slug(page)}.png`;
          writeFileSync(join(dir, check.diff), d.png);
          evidence.push({ kind: "diff", file: check.diff, label: `${page} (${device}): ${(d.ratio * 100).toFixed(1)}% changed` });
        }
      }
      checks.push(check);
    }
  }

  const llm = await llmSession(ctx, { round, url, reach, areas, device: ui.devices[0]!, dir, prior }, evidence, notes);
  const findings = [...flowFindings(flows), ...pageFindings(checks), ...criteriaFindings(llm.criteria), ...llm.findings];
  const review: ReviewOutput = { reviewer: "evaluator", prior: priorVerdicts(prior, findings), findings };
  const report: EvaluateReport = { round, url, devices: ui.devices, areas: areas.map((a) => a.name), flows, pages: checks, ...("error" in base ? { base_error: base.error } : {}), criteria: llm.criteria, evidence, notes, review };
  writeJson(ctx, `evaluate-${round}.json`, report);
  writeJson(ctx, `review-${round}-evaluator.json`, review);
  ctx.events.emit({
    step: "evaluate",
    event: "step_finished",
    data: { round, flows_failed: flows.filter((f) => f.status === "fail").length, bugs: findings.filter((f) => f.severity === "bug").length, evidence: evidence.length },
  });
  return report;
}

/** Latest evaluate report of a run (finalize embeds its evidence). */
export function latestEvaluateReport(runDir: string): EvaluateReport | undefined {
  const rounds = readdirSync(runDir)
    .map((f) => /^evaluate-(\d+)\.json$/.exec(f)?.[1])
    .filter((n): n is string => !!n)
    .map(Number)
    .sort((a, b) => b - a);
  return rounds.length ? (JSON.parse(readFileSync(join(runDir, `evaluate-${rounds[0]}.json`), "utf8")) as EvaluateReport) : undefined;
}

export const evidenceDir = (runDir: string): string => join(runDir, "evidence");
export const isImage = (file: string): boolean => /\.(png|gif)$/.test(basename(file));
