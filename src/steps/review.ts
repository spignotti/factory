import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { type ChecklistItem } from "../checklist.js";
import { InvalidOutputError } from "../agents/models.js";
import { changedFiles, diffText, git, stageAll } from "../git.js";
import { callAgent, type RunContext, writeJson, writeRunFile } from "../pipeline/context.js";
import type { TrackedFinding } from "../pipeline/merge.js";
import { asData, taskBlock, asset, rolePrompt } from "../prompts.js";
import { DEPENDENCY_GLOBS } from "../paths.js";
import { matchesAny, planReviewNotes } from "../schemas/plan.js";
import { type Reviewer, type ReviewOutput, ReviewOutputSchema } from "../schemas/review.js";
import { CHECKLIST_REL, resolveStandards, REVIEW_RULES_REL, rulesForReview, STANDARDS_REL, type ResolvedStandards } from "../standards.js";
import { skippedSecurityGates, type GateReport, visibleGateDetail } from "./gates.js";


export interface ReviewerPlan {
  reviewers: Reviewer[];
  /** Why `security` is active: matching changed files (empty = inactive). */
  security: string[];
  /** Unmarked standards rules given to `standards` (empty = inactive). */
  standards: ChecklistItem[];
  /** `standards.md` or the deprecated `checklist.md`, for citations. */
  standardsFile: string;
  /** Review rules from the base commit (severity section, old file, or the global default). */
  reviewRules: string;
  /** Set when the base still uses the deprecated files. */
  deprecated?: string;
}

async function showAt(cwd: string, sha: string, path: string): Promise<string | undefined> {
  try {
    return await git(cwd, ["show", `${sha}:${path}`]);
  } catch {
    return undefined;
  }
}

/** Standards and review rules from the base commit: the implementer must not rewrite its reviewers' rules. */
async function baseStandards(ctx: RunContext): Promise<ResolvedStandards> {
  const standards = await showAt(ctx.worktree, ctx.baseSha, STANDARDS_REL);
  const resolved = resolveStandards({
    standards,
    checklist: standards === undefined && ctx.repo.review.checklist ? await showAt(ctx.worktree, ctx.baseSha, CHECKLIST_REL) : undefined,
    reviewRules: standards === undefined ? await showAt(ctx.worktree, ctx.baseSha, REVIEW_RULES_REL) : undefined,
    defaultReviewRules: asset("standards/review-rules.md"),
  });
  if (!ctx.repo.review.checklist) return { ...resolved, items: [], unmarked: [] };
  return resolved;
}

/** Reviewers decided in code, on the whole change since base. */
export async function planReviewers(ctx: RunContext, round: number): Promise<ReviewerPlan> {
  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const security = changed.filter((f) => matchesAny(f, ctx.repo.sensitive_paths) || matchesAny(f, DEPENDENCY_GLOBS));
  const standards = await baseStandards(ctx);
  const visibleStandards = rulesForReview(standards.items, ctx.repo.checks);
  const reviewers: Reviewer[] = ["plan", "simplicity"];
  // A reviewer that ran once stays for the rest of the run: its open findings need its verdicts.
  if (security.length || reviewedBefore(ctx, "security", round)) reviewers.push("security");
  if (visibleStandards.length || reviewedBefore(ctx, "standards", round)) reviewers.push("standards");
  return {
    reviewers,
    security,
    standards: visibleStandards,
    standardsFile: standards.source === "checklist.md" ? "checklist.md" : "standards.md",
    reviewRules: standards.reviewRules,
    ...(standards.deprecated ? { deprecated: standards.deprecated } : {}),
  };
}

const REVIEW_SHAPE = `Reply with a single \`\`\`json block:
{"reviewer":"<name>","prior":[{"finding_id":"<id of a prior finding you were given>","verdict":"resolved|accept_wontfix|still_open|reject_wontfix"}],
 "findings":[{"severity":"bug|suggestion|nit","file":"","line":0,"claim":"","evidence":"","fix":"","checkable":"lint|test|script|no","check_sketch":""}]}`;

export interface ReviewInput {
  round: number;
  gates: GateReport;
  findings: TrackedFinding[];
  /** Diff base of the incremental diff for round >= 2 (HEAD reviewed last round). */
  lastReviewedSha?: string;
}

/** A reviewer that joins after round 1 (e.g. a fix touched a lockfile) gets the full round-1 input. */
function reviewedBefore(ctx: RunContext, reviewer: Reviewer, round: number): boolean {
  // `checklist` is the old reviewer id; a resumed run still owes that reviewer its verdicts.
  const names = reviewer === "standards" ? ["standards", "checklist"] : [reviewer];
  for (let n = 1; n < round; n++) {
    if (names.some((name) => existsSync(join(ctx.runDir, `review-${n}-${name}.json`)))) return true;
  }
  return false;
}

function reviewerExtras(ctx: RunContext, reviewer: Reviewer, plan: ReviewerPlan): string {
  if (reviewer === "security") return asData("security_trigger_files", plan.security.join("\n"));
  if (reviewer === "standards") {
    return asData("standards_items", plan.standards.map((i, n) => `S${n + 1} (${plan.standardsFile}:${i.line}): ${i.text}`).join("\n"));
  }
  if (reviewer === "plan") {
    const notes = planReviewNotes(ctx.plan, ctx.task.text, ctx.task.labels);
    return notes ? asData("plan_checks", notes) : "";
  }
  return "";
}

/** One reviewer, one session. */
interface ReviewSession {
  key: string;
  role: string;
  reviewer: Reviewer;
}

function sessionsFor(reviewers: Reviewer[]): ReviewSession[] {
  return reviewers.map((r) => ({ key: r, role: `review_${r}`, reviewer: r }));
}

const shapeOf = (s: ReviewSession): string =>
  `${REVIEW_SHAPE.replace("<name>", s.reviewer)}\nWithout prior findings, "prior" is [].`;

interface Diffs {
  /** Since base: round 1 and reviewers joining later. */
  full: () => Promise<string>;
  /** Since the HEAD reviewed last round. */
  incremental: string;
}

function gateResultsJson(gates: GateReport, continued: boolean): string {
  const skipped = skippedSecurityGates(gates.checks);
  const skippedField = skipped.length ? { skipped_gates: skipped } : {};
  if (continued) return JSON.stringify({ scope_report: gates.scope_report, ...skippedField }, null, 2);
  return JSON.stringify({
    checks: gates.checks.map((c) => {
      const detail = visibleGateDetail(c.output_tail);
      return { name: c.name, status: c.status, ...(detail ? { detail } : {}) };
    }),
    scope_report: gates.scope_report,
    ...skippedField,
  }, null, 2);
}

async function reviewPrompt(ctx: RunContext, s: ReviewSession, input: ReviewInput, diffs: Diffs, plan: ReviewerPlan): Promise<string> {
  const continued = input.round > 1 && input.lastReviewedSha && reviewedBefore(ctx, s.reviewer, input.round);
  if (!continued) {
    return [
      asData("plan", JSON.stringify(ctx.plan, null, 2)),
      taskBlock(ctx),
      asData("diff", await diffs.full()),
      asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
      asData("gate_results", gateResultsJson(input.gates, false)),
      `Review rules:\n${plan.reviewRules}`,
      reviewerExtras(ctx, s.reviewer, plan),
      ctx.briefing ? `Recurring findings in this repo (check whether this diff repeats them):\n${asData("findings_briefing", ctx.briefing)}` : "",
      // Prior findings of a reviewer joining late: open ones still need its verdict.
      input.round > 1 ? priorBlock(input, s) : "",
      shapeOf(s),
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Round ${input.round}. Give a verdict for every prior finding below and report only new findings.`,
    priorBlock(input, s),
    asData("incremental_diff", diffs.incremental),
    asData("gate_results", gateResultsJson(input.gates, true)),
    shapeOf(s),
  ].join("\n\n");
}

function priorBlock(input: ReviewInput, s: ReviewSession): string {
  const prior = input.findings
    .filter((f) => f.reviewer === s.reviewer && f.status === "open")
    .map((f) => ({ id: f.id, reviewer: f.reviewer, severity: f.severity, file: f.file, line: f.line, claim: f.claim, response: f.response ?? null }));
  return prior.length || input.round > 1 ? asData("prior_findings_with_responses", JSON.stringify(prior, null, 2)) : "";
}

function parseSession(s: ReviewSession, text: string): { ok: true; reviews: ReviewOutput[] } | { ok: false; errors: string[] } {
  const json = extractJson(text);
  const parsed = ReviewOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  return parsed.data.reviewer === s.reviewer ? { ok: true, reviews: [parsed.data] } : { ok: false, errors: [`reviewer must be ${s.reviewer}`] };
}

/**
 * Verdicts must name findings this session was shown. A verdict on an unknown id means the reviewer
 * answered another round's question (or invented ids); taking it as valid would silently drop its
 * real findings, so it is invalid output and gets the corrective retry.
 */
function checkPriorIds(out: ReturnType<typeof parseSession>, input: ReviewInput, s: ReviewSession): ReturnType<typeof parseSession> {
  if (!out.ok) return out;
  const known = new Set(input.findings.filter((f) => f.reviewer === s.reviewer).map((f) => f.id));
  const unknown = out.reviews.flatMap((r) => r.prior.map((p) => p.finding_id)).filter((id) => !known.has(id));
  if (!unknown.length) return out;
  return { ok: false, errors: [`prior verdicts name unknown finding ids: ${unknown.join(", ")} (judge only the prior findings you were given${known.size ? "" : "; there are none, so prior must be []"})`] };
}

async function runSession(ctx: RunContext, s: ReviewSession, input: ReviewInput, diffs: Diffs, plan: ReviewerPlan): Promise<ReviewOutput[]> {
  const system = [rolePrompt(`review-${s.reviewer}`, ctx.deps.prompts), rolePrompt("review-common", ctx.deps.prompts)].join("\n\n");
  let prompt = await reviewPrompt(ctx, s, input, diffs, plan);
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callAgent(ctx, "review", { role: s.role, cwd: ctx.worktree, tools: "read_only", system, prompt, sessionKey: `${ctx.runId}-review-${s.key}` });
    const out = checkPriorIds(parseSession(s, res.text), input, s);
    if (out.ok) {
      for (const r of out.reviews) writeJson(ctx, `review-${input.round}-${r.reviewer}.json`, r);
      return out.reviews;
    }
    errors = out.errors;
    ctx.events.emit({ step: "review", event: "progress", role: s.role, data: { rejected: errors } });
    prompt = `Your review output was invalid:\n- ${errors.join("\n- ")}\n\n${shapeOf(s)}`;
  }
  throw new InvalidOutputError(`${s.role} output invalid: ${errors.join("; ")}`);
}

/** One review round: every active reviewer in its own session. */
export async function reviewRound(ctx: RunContext, input: ReviewInput): Promise<ReviewOutput[]> {
  // Stage and diff once: parallel reviewers must not touch the git index concurrently.
  await stageAll(ctx.worktree);
  const plan = await planReviewers(ctx, input.round);
  const sessions = sessionsFor(plan.reviewers);
  const planChecks = planReviewNotes(ctx.plan, ctx.task.text, ctx.task.labels);
  ctx.events.emit({
    step: "review",
    event: "step_started",
    data: {
      round: input.round, reviewers: plan.reviewers,
      security_files: plan.security.length, checklist_items: plan.standards.length, standards_items: plan.standards.length,
      ...(plan.deprecated ? { standards_deprecated: plan.deprecated } : {}),
      ...(planChecks ? { plan_checks: planChecks } : {}),
    },
  });
  const skip = ctx.repo.review.skip_paths;
  const first = input.round === 1 || !input.lastReviewedSha;
  const incremental = await diffText(ctx.worktree, first ? ctx.baseSha : input.lastReviewedSha!, skip);
  let full: Promise<string> | undefined;
  const diffs: Diffs = { incremental, full: () => (full ??= first ? Promise.resolve(incremental) : diffText(ctx.worktree, ctx.baseSha, skip)) };
  writeRunFile(ctx, `diff-${input.round}.patch`, incremental);
  // allSettled: a failing reviewer must not leave its sibling running after the run has finished.
  const settled = await Promise.allSettled(sessions.map((s) => runSession(ctx, s, input, diffs, plan)));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  const outputs = settled.flatMap((s) => (s as PromiseFulfilledResult<ReviewOutput[]>).value);
  ctx.events.emit({ step: "review", event: "step_finished", data: { round: input.round } });
  return outputs;
}
