import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChecklist, unmarkedItems } from "../checklist.js";
import { CI_STUB_PATH, pinnedRefs } from "../ci.js";
import type { CiRun } from "../gh.js";
import { git } from "../git.js";
import type { MemoryFile } from "../memory.js";
import type { RunRecord } from "../runs.js";
import type { RepoConfig } from "../schemas/repo.js";
import type { StatsPeriod } from "../commands/stats.js";

/** Harden signals, all computed in code. */

export const WINDOW_DAYS = 30;
export const SLOW_CHECK_SECONDS = 120;
/** Fewest runs before "never failed" means something. */
export const NEVER_FAILED_MIN_RUNS = 5;
export const STALE_GUIDE_COMMITS = 10;
export const STALE_GUIDE_LINES = 300;
/** A page verified by the evaluator in this many runs is a recorded-flow candidate. */
export const EVALUATOR_REPEAT_RUNS = 2;

export interface FindingSignal {
  key: string;
  text: string;
  reviewer: string;
  count: number;
  checkable: string;
  check_sketch: string;
  flaky: boolean;
}

/** `open` entries seen at least twice or checkable, plus flaky checks. */
export function findingSignals(mem: MemoryFile): FindingSignal[] {
  return mem.entries
    .filter((e) => e.status === "open" && (e.count >= 2 || e.checkable !== "no" || e.key.startsWith("flaky:")))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((e) => ({ key: e.key, text: e.text, reviewer: e.reviewer, count: e.count, checkable: e.checkable, check_sketch: e.check_sketch, flaky: e.key.startsWith("flaky:") }));
}

/** Checklist items without a `<!-- check: … -->` marker. */
export function checklistSignals(repoDir: string, repo: RepoConfig): string[] {
  const path = join(repoDir, ".factory", "checklist.md");
  if (!repo.review.checklist || !existsSync(path)) return [];
  return unmarkedItems(parseChecklist(readFileSync(path, "utf8"))).map((i) => i.text);
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export interface CheckAudit {
  name: string;
  workflow: string;
  runs: number;
  failures: number;
  failure_rate: number;
  flaky: number;
  flaky_rate: number;
  median_s: number | null;
  p90_s: number | null;
}

export interface CiAudit {
  window_days: number;
  runs: number;
  minutes_per_week: number;
  flaky_rate: number | null;
  checks: CheckAudit[];
  never_failed: string[];
  slow_without_paths: string[];
  stub: { pinned: string | null; latest: string | null; behind: boolean };
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const FAILED = new Set(["failure", "timed_out"]);

/** The factory stub's matrix jobs are `check (<name>)`; other workflows' jobs keep their name. */
function checkName(job: string): string {
  return /^check \((.+)\)$/.exec(job)?.[1] ?? job;
}

/**
 * Per check: runs, failure rate, flaky (red and green on the same commit), median/p90 duration; CI
 * minutes per week; checks that never failed; slow checks without `paths`; stub ref vs the newest tag.
 */
export function ciAudit(runs: CiRun[], repo: RepoConfig, stubText: string | undefined, latest: string | null): CiAudit {
  const byCheck = new Map<string, { workflow: string; secs: number[]; failures: number; total: number; perSha: Map<string, Set<string>> }>();
  let seconds = 0;
  for (const run of runs) {
    for (const job of run.jobs) {
      seconds += job.seconds ?? 0;
      if (!job.conclusion || job.conclusion === "skipped") continue;
      const name = checkName(job.name);
      const key = `${run.workflow}\u0000${name}`;
      const c = byCheck.get(key) ?? { workflow: run.workflow, secs: [] as number[], failures: 0, total: 0, perSha: new Map<string, Set<string>>() };
      c.total += 1;
      if (FAILED.has(job.conclusion)) c.failures += 1;
      if (job.seconds != null) c.secs.push(job.seconds);
      const set = c.perSha.get(run.sha) ?? new Set();
      set.add(job.conclusion);
      c.perSha.set(run.sha, set);
      byCheck.set(key, c);
    }
  }
  let pairs = 0;
  let flakyPairs = 0;
  const checks: CheckAudit[] = [...byCheck.entries()].map(([key, c]) => {
    const flaky = [...c.perSha.values()].filter((s) => s.has("success") && [...s].some((x) => FAILED.has(x))).length;
    pairs += c.perSha.size;
    flakyPairs += flaky;
    return {
      name: key.split("\u0000")[1]!,
      workflow: c.workflow,
      runs: c.total,
      failures: c.failures,
      failure_rate: round(c.failures / c.total),
      flaky,
      flaky_rate: round(flaky / c.perSha.size),
      median_s: quantile(c.secs, 0.5),
      p90_s: quantile(c.secs, 0.9),
    };
  });
  checks.sort((a, b) => a.workflow.localeCompare(b.workflow) || a.name.localeCompare(b.name));
  const repoChecks = new Map(repo.checks.map((c) => [c.name, c]));
  const pinned = stubText ? (pinnedRefs(stubText)[0] ?? null) : null;
  return {
    window_days: WINDOW_DAYS,
    runs: runs.length,
    minutes_per_week: round(seconds / 60 / (WINDOW_DAYS / 7), 1),
    flaky_rate: pairs ? round(flakyPairs / pairs) : null,
    checks,
    never_failed: checks.filter((c) => c.runs >= NEVER_FAILED_MIN_RUNS && c.failures === 0).map((c) => c.name),
    slow_without_paths: checks.filter((c) => (c.median_s ?? 0) > SLOW_CHECK_SECONDS && repoChecks.has(c.name) && !repoChecks.get(c.name)!.paths?.length).map((c) => c.name),
    stub: { pinned, latest, behind: !!pinned && !!latest && pinned !== latest },
  };
}

export interface StaleGuide {
  area: string;
  guide: string;
  commits: number;
  lines: number;
  reason: string;
}

/** Verify areas whose `paths` changed a lot since their guide was last committed (or with no guide yet). */
export async function staleGuides(repoDir: string, repo: RepoConfig, base: string): Promise<StaleGuide[]> {
  const out: StaleGuide[] = [];
  for (const area of repo.verify.areas) {
    if (!area.guide || !area.paths.length) continue;
    const last = (await git(repoDir, ["log", "-1", "--format=%H", base, "--", area.guide]).catch(() => "")).trim();
    if (!last) {
      out.push({ area: area.name, guide: area.guide, commits: 0, lines: 0, reason: "guide missing on the base branch" });
      continue;
    }
    const pathspec = area.paths.map((p) => `:(glob)${p}`);
    const commits = Number((await git(repoDir, ["rev-list", "--count", `${last}..${base}`, "--", ...pathspec])).trim()) || 0;
    const stat = await git(repoDir, ["diff", "--shortstat", last, base, "--", ...pathspec]);
    const lines = [...stat.matchAll(/(\d+) (insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
    if (commits >= STALE_GUIDE_COMMITS || lines >= STALE_GUIDE_LINES) {
      out.push({ area: area.name, guide: area.guide, commits, lines, reason: `${commits} commits / ${lines} changed lines in its paths since the guide changed` });
    }
  }
  return out;
}

export interface Revert {
  sha: string;
  subject: string;
  pr: string;
}

/** Factory PR numbers (`…/pull/<n>`) of the given runs. */
export function factoryPrNumbers(runs: RunRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of runs) {
    const pr = r.result?.pr ?? null;
    const n = pr ? /\/pull\/(\d+)/.exec(pr)?.[1] : undefined;
    if (n && pr) out.set(n, pr);
  }
  return out;
}

/** `Revert "… (#n)"` commits on the base within the window whose `#n` is a factory PR. */
export async function reverts(repoDir: string, base: string, sinceIso: string, prs: Map<string, string>): Promise<Revert[]> {
  if (!prs.size) return [];
  const log = await git(repoDir, ["log", base, `--since=${sinceIso}`, "--format=%H%x1f%s"]).catch(() => "");
  const out: Revert[] = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\u001f") as [string, string];
    if (!/^Revert "/.test(subject)) continue;
    for (const m of subject.matchAll(/\(#(\d+)\)/g)) {
      const pr = prs.get(m[1]!);
      if (pr) out.push({ sha, subject, pr });
    }
  }
  return out;
}

/** Pathname of a goto target (relative or absolute). */
function pagePath(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    return new URL(url, "http://app.invalid").pathname;
  } catch {
    return undefined;
  }
}

/**
 * Evaluator signal: pages where the evaluator verified met criteria (via its browser tools) in
 * at least EVALUATOR_REPEAT_RUNS runs and no area with recorded flows lists the page. Reads each
 * run's last `evaluate-N.json` and its `evaluate-N-tools.json` call log.
 */
export function evaluatorSignals(runs: RunRecord[], repo: RepoConfig): string[] {
  const covered = new Set(repo.verify.areas.filter((a) => a.flows.length).flatMap((a) => a.pages));
  const byPage = new Map<string, { runs: Set<string>; criteria: string[] }>();
  for (const run of runs) {
    let files: string[];
    try {
      files = readdirSync(run.dir);
    } catch {
      continue;
    }
    const round = Math.max(0, ...files.map((f) => Number(/^evaluate-(\d+)\.json$/.exec(f)?.[1] ?? 0)));
    if (!round) continue;
    try {
      const report = JSON.parse(readFileSync(join(run.dir, `evaluate-${round}.json`), "utf8")) as { criteria?: { id: string; met: boolean }[] };
      const met = (report.criteria ?? []).filter((c) => c.met).map((c) => c.id);
      if (!met.length) continue;
      const calls = JSON.parse(readFileSync(join(run.dir, `evaluate-${round}-tools.json`), "utf8")) as { tool: string; args?: Record<string, unknown>; isError?: boolean }[];
      const pages = new Set(calls.filter((c) => c.tool === "goto" && !c.isError).map((c) => pagePath(c.args?.url)).filter((p): p is string => !!p));
      for (const page of pages) {
        if (covered.has(page)) continue;
        const e = byPage.get(page) ?? { runs: new Set(), criteria: [] };
        e.runs.add(run.run_id);
        e.criteria.push(...met.map((id) => `${run.run_id}/${id}`));
        byPage.set(page, e);
      }
    } catch {
      continue;
    }
  }
  return [...byPage.entries()]
    .filter(([, e]) => e.runs.size >= EVALUATOR_REPEAT_RUNS)
    .sort(([a, x], [b, y]) => y.runs.size - x.runs.size || a.localeCompare(b))
    .map(([page, e]) => `page ${page}: evaluator verified criteria in ${e.runs.size} runs (${e.criteria.slice(0, 5).join(", ")}); no recorded flow covers it`);
}

export interface Signals {
  findings: FindingSignal[];
  checklist: string[];
  ci: CiAudit | { error: string };
  runs: Pick<StatsPeriod, "runs" | "by_result" | "done_rate" | "rounds" | "gate_failures" | "flaky_checks" | "reasons" | "lane_escalations">;
  /** Pages the evaluator verified repeatedly without a recorded flow (recorded-flow candidates). */
  evaluator: string[];
  stale_guides: StaleGuide[];
  reverts: Revert[];
}

/** Something worth a proposal (otherwise harden makes no LLM call). */
export function hasSignals(s: Signals): boolean {
  const ci = "error" in s.ci ? null : s.ci;
  return (
    s.findings.length > 0 ||
    s.checklist.length > 0 ||
    s.evaluator.length > 0 ||
    s.stale_guides.length > 0 ||
    s.reverts.length > 0 ||
    Object.keys(s.runs.gate_failures).length > 0 ||
    (!!ci && (ci.checks.some((c) => c.failures > 0 || c.flaky > 0) || ci.slow_without_paths.length > 0 || ci.stub.behind))
  );
}

export const stubText = (repoDir: string) => (existsSync(join(repoDir, CI_STUB_PATH)) ? readFileSync(join(repoDir, CI_STUB_PATH), "utf8") : undefined);
