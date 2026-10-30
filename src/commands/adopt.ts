import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { OneShot, type OneShotDeps } from "../agents/oneshot.js";
import { extractJson } from "../agents/runner.js";
import { staleClaudeMd, trimAgentsMd } from "../adopt/agents-md.js";
import { classifyLegacy, isReviewFile, type LegacyReport, withMigratedReviewRules } from "../adopt/legacy.js";
import { type Detection, detect } from "../adopt/detect.js";
import { agentsTemplate, type DraftCheck, draftChecks, draftRepoYaml, dropMutating, projectPurpose, testStrategySection, withTestStrategy } from "../adopt/draft.js";
import { type MeasureResult, measureChecks } from "../adopt/measure.js";
import { CI_STUB_PATH, renderCiStub, REQUIRED_CHECK } from "../ci.js";
import { describeToolchains, detectToolchains } from "../toolchains.js";
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
  /** Candidates not drafted as checks (they change files, or duplicate another). */
  skipped_checks: { name: string; run: string; reason: string }[];
  /** Rules moved out of tool-named AGENTS.md sections. */
  agents_moved: { from: string; to: string; rule: string }[];
  /** Review-bot files whose rules were appended to `.factory/review-rules.md`. */
  review_rules_migrated: string[];
  warnings: string[];
  setup_seconds: number | null;
  proposal: { id: string; path: string; plan_path: string } | null;
  plan_error: string | null;
  hints: string[];
  /** What the CI stub installs for this repo (detected at CI time; `ci.toolchains` pins it). */
  ci_toolchains: string;
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
  if (s.branch_protected === false || (s.branch_protected && !required.includes(REQUIRED_CHECK))) {
    hints.push(
      `Protect ${base}: require the status check "${REQUIRED_CHECK}" (the CI stub's job name, as GitHub Actions reports it) and dismiss stale approvals on new commits (Settings → Branches or Rulesets).` +
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
    "Factory onboarding (`factory adopt`). Review every file; nothing here changes repository settings.",
    "",
    `Detected: ${d.stacks.join(", ") || "no known stack"}. Setup: \`${d.setup || "(none)"}\`${r.setup_seconds != null ? ` (${r.setup_seconds}s)` : ""}.`,
    "",
    `CI toolchains (the stub installs them before the checks; detected on every CI run, \`ci.toolchains\` in repo.yaml overrides): ${r.ci_toolchains}.`,
    "",
    "### Written",
    r.written.map((f) => `- \`${f}\``).join("\n"),
    "",
    "### Checks (proposed tiers, measured once on the base branch)",
    "| check | tier | seconds | note |",
    "|---|---|---|---|",
    checks || "| – | | | |",
    "",
    "### Not drafted as checks",
    r.skipped_checks.length ? r.skipped_checks.map((c) => `- \`${c.name}\` (\`${c.run}\`): ${c.reason}`).join("\n") : "- none",
    "",
    "### AGENTS.md",
    r.agents_moved.length ? r.agents_moved.map((m) => `- moved from "${m.from}" to "${m.to}": ${m.rule}`).join("\n") : "- no rules moved",
    ...r.review_rules_migrated.map((p) => `- review rules from \`${p}\` appended to \`${REVIEW_RULES_PATH}\``),
    "",
    "### Warnings",
    r.warnings.length ? r.warnings.map((w) => `- ${w}`).join("\n") : "- none",
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

/** `factory adopt`: detect, measure, draft, remove legacy setup, baseline plan, one PR. */
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
    dropMutating(detection, measured);
    const checks: DraftCheck[] = draftChecks(detection, measured);
    const toolchainNotes: string[] = [];
    const ciToolchains = describeToolchains(detectToolchains(wt, toolchainNotes));
    const { text: repoYaml, config } = draftRepoYaml({ detection, checks, baseBranch, date, repoName: basename(resolve(repoDir)), toolchains: ciToolchains });
    const agentsPath = join(wt, "AGENTS.md");
    const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : undefined;
    const read = (rel: string) => {
      try {
        return readFileSync(join(wt, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    const legacy = classifyLegacy({ files, workflows: detection.workflows, checks, setup: detection.setup, agentsMd, keep: opts.keep, read });
    const trim = agentsMd !== undefined && !legacy.kept.some((k) => k.path === "AGENTS.md") ? trimAgentsMd(agentsMd) : undefined;
    const warnings = [...(trim?.warnings ?? []), ...toolchainNotes.map((n) => `CI toolchains: ${n}`)];
    // Without AGENTS.md the root CLAUDE.md is carried into the new AGENTS.md, so it cannot go stale.
    for (const claude of legacy.removed.filter((i) => /(^|\/)CLAUDE\.md$/.test(i.path) && (agentsMd !== undefined || i.path !== "CLAUDE.md"))) {
      const w = staleClaudeMd(read(claude.path) ?? "", agentsMd);
      if (w) warnings.push(claude.path === "CLAUDE.md" ? w : w.replace("CLAUDE.md", claude.path));
    }
    const reviewSources = legacy.removed.filter((i) => isReviewFile(i.path) && i.path.endsWith(".md")).map((i) => ({ path: i.path, text: read(i.path) ?? "" }));

    const written: string[] = [];
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), text);
      written.push(rel);
    };
    write(REPO_CONFIG_PATH, repoYaml);
    write(REVIEW_RULES_PATH, withMigratedReviewRules(asset("standards/review-rules.md"), reviewSources));
    write(CI_STUB_PATH, ciStub);
    let agentsNext: string | undefined;
    if (agentsMd === undefined) {
      const claude = legacy.removed.some((i) => i.path === "CLAUDE.md") ? read("CLAUDE.md") : undefined;
      const topDirs = [...new Set(files.filter((f) => f.includes("/") && !f.startsWith(".")).map((f) => f.split("/")[0]!))].sort().slice(0, 15);
      agentsNext = agentsTemplate({ detection, checks, purpose: projectPurpose(wt), topDirs, extra: claude ? { from: "CLAUDE.md", text: claude } : undefined });
    } else {
      const agentsBase = trim?.text ?? agentsMd;
      agentsNext = withTestStrategy(agentsBase, testStrategySection(detection, checks)) ?? (agentsBase !== agentsMd ? agentsBase : undefined);
    }
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
      skipped_checks: detection.skipped.map((c) => ({ name: c.name, run: c.run, reason: c.reason })),
      agents_moved: trim?.moved ?? [],
      review_rules_migrated: reviewSources.filter((r) => r.text.trim()).map((r) => r.path),
      warnings,
      setup_seconds: measured?.setup?.seconds ?? null,
      proposal: null,
      plan_error: null,
      hints: settingsHints(settings, baseBranch),
      ci_toolchains: ciToolchains,
    };
    if (detection.tests.globs.length && !detection.tests.run) {
      report.hints.push("Tests were found but no runner for single test files: set tests.run in .factory/repo.yaml (bug plans stop with needs_human without it); the repo's bot can do it in a config PR.");
    }
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
          proposals: [{ status: "open", rationale: "Establish factory baseline.", plan: res.plan, references: { findings: [], checklist: [] }, resolution: null }],
          signals: { detection: report.detection, legacy: { removed: legacy.removed.length, proposed: legacy.proposed.length, kept: legacy.kept.length } },
          metrics: null,
        });
        report.proposal = { id: p.proposals[0]!.id, path: join(proposalsDir(deps.factoryHome, repoId), `${p.id}.json`), plan_path: p.proposals[0]!.plan_path };
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
  for (const c of r.skipped_checks) io.out(`  not a check: ${c.name} (${c.reason})\n`);
  for (const m of r.agents_moved) io.out(`AGENTS.md: moved from "${m.from}" to "${m.to}": ${m.rule}\n`);
  for (const p of r.review_rules_migrated) io.out(`review rules migrated from ${p}\n`);
  for (const w of r.warnings) io.out(`warning: ${w}\n`);
  io.out(r.proposal ? `baseline plan: ${r.proposal.plan_path}\n` : `baseline plan: ${r.plan_error ?? "skipped"}\n`);
  for (const h of r.hints) io.out(`hint: ${h}\n`);
  return 0;
}
