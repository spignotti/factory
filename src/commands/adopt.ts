import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OneShot, type OneShotDeps } from "../agents/oneshot.js";
import { extractJson } from "../agents/runner.js";
import { classifyLegacy, type LegacyReport } from "../adopt/legacy.js";
import { type Detection, detect } from "../adopt/detect.js";
import { type DraftCheck, draftChecks, draftRepoYaml, testStrategySection, withTestStrategy } from "../adopt/draft.js";
import { type MeasureResult, measureChecks } from "../adopt/measure.js";
import { CI_STUB_PATH, renderCiStub } from "../ci.js";
import type { Io } from "./gates.js";
import type { GitHub, RepoSettings } from "../gh.js";
import { baseRef, commitAll, git, gitOk, originUrl, remoteBranchExists, revParse, withBaseWorktree } from "../git.js";
import { canonicalRepoId } from "../memory.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { nextProposalId, proposalsDir, writeProposal } from "../proposals.js";
import { type Plan, validatePlan } from "../schemas/plan.js";
import { REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import { PLAN_SHAPE } from "../steps/plan.js";

export interface AdoptOptions {
  repo: string;
  ref: string;
  base?: string;
  keep: string[];
  measure: boolean;
  plan: boolean;
  pr: boolean;
  force: boolean;
}

export type AdoptDeps = OneShotDeps & { github: GitHub };

export interface AdoptReport {
  repo: string;
  branch: string;
  base_branch: string;
  commit: string | null;
  pr: string | null;
  written: string[];
  legacy: LegacyReport;
  detection: { stacks: string[]; setup: string; ui: string[]; db: string[]; cloud: string[]; special_jobs: string[] };
  checks: { name: string; tier: string; seconds: number | null; note: string | null }[];
  setup_seconds: number | null;
  proposal: { id: string; path: string; plan_path: string } | null;
  plan_error: string | null;
  hints: string[];
}

export const REVIEW_RULES_PATH = ".factory/review-rules.md";

async function defaultBranch(repoDir: string): Promise<string> {
  const head = await git(repoDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (head.trim().startsWith("origin/")) return head.trim().slice("origin/".length);
  return (await git(repoDir, ["branch", "--show-current"]).catch(() => "")).trim() || "main";
}

async function freeBranch(repoDir: string, stem: string): Promise<string> {
  const taken = async (b: string) => (await gitOk(repoDir, ["rev-parse", "--verify", `refs/heads/${b}`])) || (await remoteBranchExists(repoDir, b));
  if (!(await taken(stem))) return stem;
  for (let n = 2; ; n++) if (!(await taken(`${stem}-${n}`))) return `${stem}-${n}`;
}

/** Printed hints only: adopt never changes repository settings (no admin token, works without GitHub Pro). */
export function settingsHints(s: RepoSettings, base: string): string[] {
  const hints: string[] = [];
  const required = s.required_checks ?? [];
  if (s.branch_protected === false || (s.branch_protected && !required.includes("factory / done"))) {
    hints.push(
      `Protect ${base}: require the status check "factory / done" and dismiss stale approvals on new commits (Settings → Branches or Rulesets).` +
        (s.private ? " Private repos need GitHub Pro/Team for this; without it the factory's merge policy (human review) still applies." : ""),
    );
  }
  if (s.auto_merge_allowed === false) hints.push('Optional: enable "Allow auto-merge" (Settings → General) if repo.yaml merge.auto_merge_max_risk is raised above none.');
  if (s.error) hints.push(`Repository settings could not be read (${s.error}); check branch protection by hand.`);
  return hints;
}

function detectionSummary(d: Detection) {
  return {
    stacks: d.stacks,
    setup: d.setup,
    ui: d.ui.reasons,
    db: d.db.reasons,
    cloud: d.cloud.reasons,
    special_jobs: d.special_jobs.map((s) => `${s.workflow}#${s.job}: ${s.tool}`),
  };
}

async function baselinePlan(
  deps: AdoptDeps,
  wt: string,
  logDir: string,
  input: { detection: Detection; repoYaml: string; config: RepoConfig; legacy: LegacyReport; files: string[]; agentsMd: string },
): Promise<{ plan: Plan } | { error: string }> {
  const shot = new OneShot(deps, logDir, "adopt", input.config);
  try {
    const tree = input.files.slice(0, 400).join("\n") + (input.files.length > 400 ? `\n… ${input.files.length - 400} more` : "");
    const base = [
      asData("detection", JSON.stringify(detectionSummary(input.detection), null, 2)),
      asData("repo_yaml", input.repoYaml),
      asData("legacy", JSON.stringify(input.legacy, null, 2)),
      asData("agents_md", input.agentsMd),
      `Repo tree:\n${tree}`,
      PLAN_SHAPE,
    ].join("\n\n");
    let errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = errors.length ? `${base}\n\nYour previous plan was rejected:\n- ${errors.join("\n- ")}` : base;
      const res = await shot.call("adopt", { role: "plan_medium", cwd: wt, tools: "read_only", system: rolePrompt("adopt", deps.prompts), prompt });
      const json = extractJson(res.text);
      const v = validatePlan(json, { repo: input.config });
      if (v.ok) return { plan: v.plan };
      errors = json === undefined ? ["no JSON object in output"] : v.errors;
    }
    return { error: `baseline plan invalid after retry: ${errors.join("; ")}` };
  } catch (e) {
    return { error: `baseline plan failed: ${(e as Error).message.slice(0, 300)}` };
  } finally {
    shot.close();
  }
}

function prBody(r: AdoptReport, d: Detection): string {
  const list = (items: { path: string; reason: string }[]) => (items.length ? items.map((i) => `- \`${i.path}\`: ${i.reason}`).join("\n") : "- none");
  const checks = r.checks.map((c) => `| \`${c.name}\` | ${c.tier} | ${c.seconds ?? "–"} | ${c.note ?? ""} |`).join("\n");
  return [
    "Factory onboarding (`factory adopt`, SPEC §12). Review every file; nothing here changes repository settings.",
    "",
    `Detected: ${d.stacks.join(", ") || "no known stack"}. Setup: \`${d.setup || "(none)"}\`${r.setup_seconds != null ? ` (${r.setup_seconds}s)` : ""}.`,
    "",
    "### Written",
    r.written.map((f) => `- \`${f}\``).join("\n"),
    "",
    "### Checks (proposed tiers, measured once on the base branch)",
    "| check | tier | seconds | note |",
    "|---|---|---|---|",
    checks || "| – | | | |",
    "",
    "### Removed legacy setup",
    list(r.legacy.removed),
    "",
    "### Proposed removals (not deleted; decide by hand)",
    list(r.legacy.proposed),
    "",
    "### Kept (--keep)",
    list(r.legacy.kept),
    "",
    "### Baseline plan",
    r.proposal ? `Proposal \`${r.proposal.id}\`; run it after merging with \`factory run --repo <path> --plan ${r.proposal.plan_path}\`.` : `None: ${r.plan_error ?? "skipped (--no-plan)"}.`,
    "",
    "### Settings (by hand)",
    r.hints.length ? r.hints.map((h) => `- ${h}`).join("\n") : "- none",
  ].join("\n");
}

/** `factory adopt` (SPEC §12): detect, measure, draft, remove legacy setup, baseline plan, one PR. */
export async function adopt(opts: AdoptOptions, deps: AdoptDeps): Promise<AdoptReport> {
  const repoDir = resolve(opts.repo);
  const now = new Date((deps.now ?? Date.now)());
  const date = now.toISOString().slice(0, 10);
  const baseBranch = opts.base ?? (await defaultBranch(repoDir));
  const sha = await revParse(repoDir, await baseRef(repoDir, baseBranch));
  const ciStub = renderCiStub(opts.ref);
  if (!opts.force && (await gitOk(repoDir, ["cat-file", "-e", `${sha}:${REPO_CONFIG_PATH}`]))) {
    throw new Error(`${REPO_CONFIG_PATH} already exists on ${baseBranch}; the repo is adopted (use --force to draft again)`);
  }
  const repoId = canonicalRepoId(await originUrl(repoDir).catch(() => ""), repoDir);
  const branch = await freeBranch(repoDir, "factory/adopt");
  const work = join(deps.factoryHome, "adopt");
  mkdirSync(work, { recursive: true });
  const tmp = mkdtempSync(join(work, `${date}-`));
  const wt = join(tmp, "worktree");
  await git(repoDir, ["worktree", "add", "-q", "-b", branch, wt, sha]);
  try {
    const files = (await git(wt, ["ls-files"])).split("\n").filter(Boolean);
    const detection = detect(wt, files);
    let measured: MeasureResult | null = null;
    if (opts.measure && (detection.setup || detection.candidates.length)) {
      measured = await withBaseWorktree(repoDir, sha, join(tmp, "measure"), (dir) =>
        measureChecks(dir, detection.setup, detection.candidates, { sandbox: deps.sandbox, factoryHome: deps.factoryHome }),
      );
    }
    const checks: DraftCheck[] = draftChecks(detection, measured);
    const { text: repoYaml, config } = draftRepoYaml({ detection, checks, baseBranch, date });
    const agentsPath = join(wt, "AGENTS.md");
    const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : undefined;
    const legacy = classifyLegacy({ files, workflows: detection.workflows, checks, setup: detection.setup, agentsMd, keep: opts.keep });

    const written: string[] = [];
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), text);
      written.push(rel);
    };
    write(REPO_CONFIG_PATH, repoYaml);
    write(REVIEW_RULES_PATH, asset("standards/review-rules.md"));
    write(CI_STUB_PATH, ciStub);
    const agentsNext = withTestStrategy(agentsMd, testStrategySection(detection, checks));
    if (agentsNext !== undefined) write("AGENTS.md", agentsNext);
    for (const item of legacy.removed) await git(wt, ["rm", "-q", "-r", "--", item.path]);

    const settings = await deps.github.repoSettings(repoDir, baseBranch).catch((e: Error) => ({ private: null, auto_merge_allowed: null, branch_protected: null, required_checks: null, error: e.message }));
    const report: AdoptReport = {
      repo: repoId,
      branch,
      base_branch: baseBranch,
      commit: null,
      pr: null,
      written,
      legacy,
      detection: detectionSummary(detection),
      checks: checks.map((c) => ({ name: c.name, tier: c.tier, seconds: c.seconds, note: c.note ?? null })),
      setup_seconds: measured?.setup?.seconds ?? null,
      proposal: null,
      plan_error: null,
      hints: settingsHints(settings, baseBranch),
    };
    if (measured?.setup && !measured.setup.ok) report.hints.push(`setup failed on the base branch at adopt: ${measured.setup.detail.split("\n").pop()}`);
    if (opts.plan) {
      const res = await baselinePlan(deps, wt, join(tmp, "log"), { detection, repoYaml, config, legacy, files, agentsMd: agentsNext ?? agentsMd ?? "(none)" });
      if ("plan" in res) {
        const p = writeProposal(deps.factoryHome, {
          version: 1,
          kind: "adopt",
          id: nextProposalId(proposalsDir(deps.factoryHome, repoId), date, "adopt"),
          repo: repoId,
          created_at: now.toISOString(),
          status: "open",
          rationale: "Establish factory baseline (SPEC §12 step 3).",
          plan: res.plan,
          references: { findings: [], checklist: [] },
          signals: { detection: report.detection, legacy: { removed: legacy.removed.length, proposed: legacy.proposed.length, kept: legacy.kept.length } },
          metrics: null,
          resolution: null,
        });
        report.proposal = { id: p.id, path: p.plan_path.replace(/\.plan\.json$/, ".json"), plan_path: p.plan_path };
      } else report.plan_error = res.error;
    }
    const author = { name: config.git.author, email: config.git.email ?? `${config.git.author}@users.noreply.github.com` };
    if (await commitAll(wt, "chore: adopt the factory", author)) report.commit = (await git(wt, ["rev-parse", "HEAD"])).trim();
    if (opts.pr && report.commit) {
      await deps.github.push(wt, branch);
      report.pr = await deps.github.createPr({ repoDir: wt, head: branch, base: baseBranch, title: "chore: adopt the factory", body: prBody(report, detection), draft: false });
    }
    return report;
  } finally {
    await git(repoDir, ["worktree", "remove", "--force", wt]).catch(() => "");
    rmSync(tmp, { recursive: true, force: true });
    await gitOk(repoDir, ["worktree", "prune"]);
  }
}

export async function adoptCommand(opts: AdoptOptions & { json: boolean }, deps: AdoptDeps, io: Io): Promise<number> {
  const r = await adopt(opts, deps);
  if (opts.json) {
    io.out(JSON.stringify(r) + "\n");
    return 0;
  }
  io.out(`adopt: branch ${r.branch}${r.pr ? `, PR ${r.pr}` : r.commit ? " (committed, not pushed)" : ""}\n`);
  io.out(`written: ${r.written.join(", ")}\n`);
  io.out(`removed: ${r.legacy.removed.length}, proposed removals: ${r.legacy.proposed.length}, kept: ${r.legacy.kept.length}\n`);
  for (const c of r.checks) io.out(`  ${c.name} [${c.tier}] ${c.seconds ?? "–"}s${c.note ? ` (${c.note})` : ""}\n`);
  io.out(r.proposal ? `baseline plan: ${r.proposal.plan_path}\n` : `baseline plan: ${r.plan_error ?? "skipped"}\n`);
  for (const h of r.hints) io.out(`hint: ${h}\n`);
  return 0;
}
