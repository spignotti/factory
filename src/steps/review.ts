import { extractJson } from "../agents/runner.js";
import { InvalidOutputError } from "../agents/models.js";
import { diffText, git, stageAll } from "../git.js";
import { callAgent, type RunContext, writeJson, writeRunFile } from "../pipeline/context.js";
import type { TrackedFinding } from "../pipeline/merge.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { type Reviewer, type ReviewOutput, ReviewOutputSchema } from "../schemas/review.js";
import type { GateReport } from "./gates.js";

/** Reviewers active in M1 (security/checklist are M2). */
export const M1_REVIEWERS: Reviewer[] = ["plan", "simplicity"];

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

function reviewPrompt(ctx: RunContext, reviewer: Reviewer, input: ReviewInput, diff: string, rules: string): string {
  const shape = REVIEW_SHAPE.replace("<name>", reviewer);
  if (input.round === 1 || !input.lastReviewedSha) {
    return [
      asData("plan", JSON.stringify(ctx.plan, null, 2)),
      asData("diff", diff),
      asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
      asData("gate_results", JSON.stringify({ checks: input.gates.checks.map((c) => ({ name: c.name, status: c.status })), scope_report: input.gates.scope_report }, null, 2)),
      `Review rules:\n${rules}`,
      shape,
    ].join("\n\n");
  }
  const prior = input.findings
    .filter((f) => f.reviewer === reviewer && f.status === "open")
    .map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, claim: f.claim, response: f.response ?? null }));
  return [
    `Round ${input.round}. Give a verdict for every prior finding below and report only new findings.`,
    asData("prior_findings_with_responses", JSON.stringify(prior, null, 2)),
    asData("incremental_diff", diff),
    asData("gate_results", JSON.stringify({ scope_report: input.gates.scope_report }, null, 2)),
    shape,
  ].join("\n\n");
}

async function runReviewer(ctx: RunContext, reviewer: Reviewer, input: ReviewInput, diff: string, rules: string): Promise<ReviewOutput> {
  const role = `review_${reviewer}`;
  const system = `${rolePrompt(`review-${reviewer}`)}\n\n${rolePrompt("review-common")}`;
  let prompt = reviewPrompt(ctx, reviewer, input, diff, rules);
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callAgent(ctx, "review", {
      role,
      cwd: ctx.worktree,
      tools: "read_only",
      system,
      prompt,
      sessionKey: `${ctx.runId}-review-${reviewer}`,
    });
    const parsed = ReviewOutputSchema.safeParse(extractJson(res.text));
    if (parsed.success && parsed.data.reviewer === reviewer) {
      writeJson(ctx, `review-${input.round}-${reviewer}.json`, parsed.data);
      return parsed.data;
    }
    errors = parsed.success ? [`reviewer must be ${reviewer}`] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    prompt = `Your review output was invalid:\n- ${errors.join("\n- ")}\n\n${REVIEW_SHAPE.replace("<name>", reviewer)}`;
  }
  throw new InvalidOutputError(`review_${reviewer} output invalid: ${errors.join("; ")}`);
}

/** One review round: `plan` and `simplicity` in parallel sessions (mode `full`). */
export async function reviewRound(ctx: RunContext, input: ReviewInput): Promise<ReviewOutput[]> {
  ctx.events.emit({ step: "review", event: "step_started", data: { round: input.round, reviewers: M1_REVIEWERS } });
  // Stage and diff once: parallel reviewers must not touch the git index concurrently.
  await stageAll(ctx.worktree);
  const since = input.round === 1 || !input.lastReviewedSha ? ctx.baseSha : input.lastReviewedSha;
  const diff = await diffText(ctx.worktree, since, ctx.repo.review.skip_paths);
  writeRunFile(ctx, `diff-${input.round}.patch`, diff);
  const rules = await reviewRules(ctx);
  // allSettled: a failing reviewer must not leave its sibling running after the run has finished.
  const settled = await Promise.allSettled(M1_REVIEWERS.map((r) => runReviewer(ctx, r, input, diff, rules)));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  const outputs = settled.map((s) => (s as PromiseFulfilledResult<ReviewOutput>).value);
  ctx.events.emit({ step: "review", event: "step_finished", data: { round: input.round } });
  return outputs;
}
