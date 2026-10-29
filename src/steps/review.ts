import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { type ChecklistItem, parseChecklist, unmarkedItems } from "../checklist.js";
import { InvalidOutputError } from "../agents/models.js";
import { changedFiles, diffText, git, stageAll } from "../git.js";
import { callAgent, type RunContext, writeJson, writeRunFile } from "../pipeline/context.js";
import type { TrackedFinding } from "../pipeline/merge.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { DEPENDENCY_GLOBS } from "../paths.js";
import { matchesAny } from "../schemas/plan.js";
import { type Reviewer, type ReviewOutput, ReviewOutputSchema, LeanOutputSchema } from "../schemas/review.js";
import type { GateReport } from "./gates.js";


export interface ReviewerPlan {
  reviewers: Reviewer[];
  /** Why `security` is active: matching changed files (empty = inactive). */
  security: string[];
  /** Unmarked checklist items given to `checklist` (empty = inactive). */
  checklist: ChecklistItem[];
}

/** Checklist from the base commit (like review rules: not editable by the implementer). */
async function baseChecklist(ctx: RunContext): Promise<ChecklistItem[]> {
  if (!ctx.repo.review.checklist) return [];
  const text = await git(ctx.worktree, ["show", `${ctx.baseSha}:.factory/checklist.md`]).catch(() => "");
  return unmarkedItems(parseChecklist(text));
}

/** Reviewers decided in code (§6.6), on the whole change since base. */
export async function planReviewers(ctx: RunContext, round: number): Promise<ReviewerPlan> {
  const changed = await changedFiles(ctx.worktree, ctx.baseSha);
  const security = changed.filter((f) => matchesAny(f, ctx.repo.sensitive_paths) || matchesAny(f, DEPENDENCY_GLOBS));
  const checklist = await baseChecklist(ctx);
  const reviewers: Reviewer[] = ["plan", "simplicity"];
  // A reviewer that ran once stays for the rest of the run: its open findings need its verdicts.
  if (security.length || reviewedBefore(ctx, "security", round)) reviewers.push("security");
  if (checklist.length || reviewedBefore(ctx, "checklist", round)) reviewers.push("checklist");
  return { reviewers, security, checklist };
}

const REVIEW_SHAPE = `Reply with a single \`\`\`json block:
{"reviewer":"<name>","prior":[{"finding_id":"R1-plan-1","verdict":"resolved|accept_wontfix|still_open|reject_wontfix"}],
 "findings":[{"severity":"bug|suggestion|nit","file":"","line":0,"claim":"","evidence":"","fix":"","checkable":"lint|test|script|no","check_sketch":""}]}`;

/** Rules from the base commit: the implementer must not be able to rewrite its reviewers' rules. */
async function reviewRules(ctx: RunContext): Promise<string> {
  return git(ctx.worktree, ["show", `${ctx.baseSha}:.factory/review-rules.md`]).catch(() => asset("standards/review-rules.md"));
}

export interface ReviewInput {
  round: number;
  gates: GateReport;
  findings: TrackedFinding[];
  /** Diff base of the incremental diff for round >= 2 (HEAD reviewed last round). */
  lastReviewedSha?: string;
}

/** A reviewer that joins after round 1 (e.g. a fix touched a lockfile) gets the full round-1 input. */
function reviewedBefore(ctx: RunContext, reviewer: Reviewer, round: number): boolean {
  for (let n = 1; n < round; n++) if (existsSync(join(ctx.runDir, `review-${n}-${reviewer}.json`))) return true;
  return false;
}

function reviewerExtras(reviewer: Reviewer, plan: ReviewerPlan): string {
  if (reviewer === "security") return asData("security_trigger_files", plan.security.join("\n"));
  if (reviewer === "checklist") {
    return asData("checklist_items", plan.checklist.map((i, n) => `C${n + 1} (checklist.md:${i.line}): ${i.text}`).join("\n"));
  }
  return "";
}

/** One reviewer session: a single reviewer (mode `full`) or `plan` + `simplicity` together (mode `lean`). */
interface ReviewSession {
  key: string;
  role: string;
  reviewers: Reviewer[];
}

function sessionsFor(ctx: RunContext, reviewers: Reviewer[]): ReviewSession[] {
  const single = (r: Reviewer): ReviewSession => ({ key: r, role: `review_${r}`, reviewers: [r] });
  if (ctx.lane !== "fast") return reviewers.map(single);
  const lean: Reviewer[] = ["plan", "simplicity"];
  return [{ key: "lean", role: "review_plan", reviewers: lean }, ...reviewers.filter((r) => !lean.includes(r)).map(single)];
}

const LEAN_SHAPE = `Reply with a single \`\`\`json block {"reviews":[<plan review>,<simplicity review>]}, each review shaped like:
{"reviewer":"plan|simplicity","prior":[{"finding_id":"R1-plan-1","verdict":"resolved|accept_wontfix|still_open|reject_wontfix"}],
 "findings":[{"severity":"bug|suggestion|nit","file":"","line":0,"claim":"","evidence":"","fix":"","checkable":"lint|test|script|no","check_sketch":""}]}
Give the verdict on a prior finding in the review of the reviewer that raised it.`;

const shapeOf = (s: ReviewSession): string => (s.reviewers.length > 1 ? LEAN_SHAPE : REVIEW_SHAPE.replace("<name>", s.reviewers[0]!));

interface Diffs {
  /** Since base: round 1 and reviewers joining later. */
  full: () => Promise<string>;
  /** Since the HEAD reviewed last round. */
  incremental: string;
}

async function reviewPrompt(ctx: RunContext, s: ReviewSession, input: ReviewInput, diffs: Diffs, rules: string, plan: ReviewerPlan): Promise<string> {
  const continued = input.round > 1 && input.lastReviewedSha && s.reviewers.every((r) => reviewedBefore(ctx, r, input.round));
  if (!continued) {
    return [
      asData("plan", JSON.stringify(ctx.plan, null, 2)),
      asData("diff", await diffs.full()),
      asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
      asData("gate_results", JSON.stringify({ checks: input.gates.checks.map((c) => ({ name: c.name, status: c.status })), scope_report: input.gates.scope_report }, null, 2)),
      `Review rules:\n${rules}`,
      ...s.reviewers.map((r) => reviewerExtras(r, plan)),
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
    asData("gate_results", JSON.stringify({ scope_report: input.gates.scope_report }, null, 2)),
    shapeOf(s),
  ].join("\n\n");
}

function priorBlock(input: ReviewInput, s: ReviewSession): string {
  const prior = input.findings
    .filter((f) => s.reviewers.includes(f.reviewer) && f.status === "open")
    .map((f) => ({ id: f.id, reviewer: f.reviewer, severity: f.severity, file: f.file, line: f.line, claim: f.claim, response: f.response ?? null }));
  return prior.length || input.round > 1 ? asData("prior_findings_with_responses", JSON.stringify(prior, null, 2)) : "";
}

function parseSession(s: ReviewSession, text: string): { ok: true; reviews: ReviewOutput[] } | { ok: false; errors: string[] } {
  const json = extractJson(text);
  if (s.reviewers.length === 1) {
    const parsed = ReviewOutputSchema.safeParse(json);
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    return parsed.data.reviewer === s.reviewers[0] ? { ok: true, reviews: [parsed.data] } : { ok: false, errors: [`reviewer must be ${s.reviewers[0]}`] };
  }
  const parsed = LeanOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const got = parsed.data.reviews.map((r) => r.reviewer);
  if (got.length !== s.reviewers.length || !s.reviewers.every((r) => got.includes(r))) {
    return { ok: false, errors: [`reviews must be exactly one each for ${s.reviewers.join(", ")}`] };
  }
  return { ok: true, reviews: s.reviewers.map((r) => parsed.data.reviews.find((x) => x.reviewer === r)!) };
}

async function runSession(ctx: RunContext, s: ReviewSession, input: ReviewInput, diffs: Diffs, rules: string, plan: ReviewerPlan): Promise<ReviewOutput[]> {
  const system = [...s.reviewers.map((r) => rolePrompt(`review-${r}`, ctx.deps.prompts)), rolePrompt("review-common", ctx.deps.prompts)].join("\n\n");
  let prompt = await reviewPrompt(ctx, s, input, diffs, rules, plan);
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callAgent(ctx, "review", { role: s.role, cwd: ctx.worktree, tools: "read_only", system, prompt, sessionKey: `${ctx.runId}-review-${s.key}` });
    const out = parseSession(s, res.text);
    if (out.ok) {
      for (const r of out.reviews) writeJson(ctx, `review-${input.round}-${r.reviewer}.json`, r);
      return out.reviews;
    }
    errors = out.errors;
    prompt = `Your review output was invalid:\n- ${errors.join("\n- ")}\n\n${shapeOf(s)}`;
  }
  throw new InvalidOutputError(`${s.key === "lean" ? "review (lean)" : s.role} output invalid: ${errors.join("; ")}`);
}

/** One review round: every active reviewer in parallel sessions (mode `full`; fast lane `lean`). */
export async function reviewRound(ctx: RunContext, input: ReviewInput): Promise<ReviewOutput[]> {
  // Stage and diff once: parallel reviewers must not touch the git index concurrently.
  await stageAll(ctx.worktree);
  const plan = await planReviewers(ctx, input.round);
  const sessions = sessionsFor(ctx, plan.reviewers);
  ctx.events.emit({
    step: "review",
    event: "step_started",
    data: {
      round: input.round, reviewers: plan.reviewers, mode: ctx.lane === "fast" ? "lean" : "full",
      security_files: plan.security.length, checklist_items: plan.checklist.length,
    },
  });
  const skip = ctx.repo.review.skip_paths;
  const first = input.round === 1 || !input.lastReviewedSha;
  const incremental = await diffText(ctx.worktree, first ? ctx.baseSha : input.lastReviewedSha!, skip);
  let full: Promise<string> | undefined;
  const diffs: Diffs = { incremental, full: () => (full ??= first ? Promise.resolve(incremental) : diffText(ctx.worktree, ctx.baseSha, skip)) };
  writeRunFile(ctx, `diff-${input.round}.patch`, incremental);
  const rules = await reviewRules(ctx);
  // allSettled: a failing reviewer must not leave its sibling running after the run has finished.
  const settled = await Promise.allSettled(sessions.map((s) => runSession(ctx, s, input, diffs, rules, plan)));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  const outputs = settled.flatMap((s) => (s as PromiseFulfilledResult<ReviewOutput[]>).value);
  ctx.events.emit({ step: "review", event: "step_finished", data: { round: input.round } });
  return outputs;
}
