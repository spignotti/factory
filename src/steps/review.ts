import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { InvalidOutputError } from "../agents/models.js";
import { diffText, stageAll } from "../git.js";
import { callAgent, type RunContext, writeJson } from "../pipeline/context.js";
import type { TrackedFinding } from "../pipeline/merge.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { type Reviewer, type ReviewOutput, ReviewOutputSchema } from "../schemas/review.js";
import type { GateReport } from "./gates.js";

/** Reviewers active in M1 (security/checklist are M2). */
export const M1_REVIEWERS: Reviewer[] = ["plan", "simplicity"];

const REVIEW_SHAPE = `Reply with a single \`\`\`json block:
{"reviewer":"<name>","prior":[{"finding_id":"R1-plan-1","verdict":"resolved|accept_wontfix|still_open|reject_wontfix"}],
 "findings":[{"severity":"bug|suggestion|nit","file":"","line":0,"claim":"","evidence":"","fix":"","checkable":"lint|test|script|no","check_sketch":""}]}`;

function reviewRules(ctx: RunContext): string {
  const repoRules = join(ctx.worktree, ".factory", "review-rules.md");
  return existsSync(repoRules) ? readFileSync(repoRules, "utf8") : asset("standards/review-rules.md");
}

export interface ReviewInput {
  round: number;
  gates: GateReport;
  findings: TrackedFinding[];
  /** Diff base of the incremental diff for round >= 2 (HEAD reviewed last round). */
  lastReviewedSha?: string;
}

async function reviewPrompt(ctx: RunContext, reviewer: Reviewer, input: ReviewInput): Promise<string> {
  await stageAll(ctx.worktree);
  const skip = ctx.repo.review.skip_paths;
  const shape = REVIEW_SHAPE.replace("<name>", reviewer);
  if (input.round === 1 || !input.lastReviewedSha) {
    const diff = await diffText(ctx.worktree, ctx.baseSha, skip);
    writeFileSync(join(ctx.runDir, `diff-${input.round}.patch`), diff);
    return [
      asData("plan", JSON.stringify(ctx.plan, null, 2)),
      asData("diff", diff),
      asData("handoffs", JSON.stringify(ctx.handoffs, null, 2)),
      asData("gate_results", JSON.stringify({ checks: input.gates.checks.map((c) => ({ name: c.name, status: c.status })), scope_report: input.gates.scope_report }, null, 2)),
      `Review rules:\n${reviewRules(ctx)}`,
      shape,
    ].join("\n\n");
  }
  const diff = await diffText(ctx.worktree, input.lastReviewedSha, skip);
  writeFileSync(join(ctx.runDir, `diff-${input.round}.patch`), diff);
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

async function runReviewer(ctx: RunContext, reviewer: Reviewer, input: ReviewInput): Promise<ReviewOutput> {
  const role = `review_${reviewer}`;
  const system = `${rolePrompt(`review-${reviewer}`)}\n\n${rolePrompt("review-common")}`;
  let prompt = await reviewPrompt(ctx, reviewer, input);
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
  const outputs = await Promise.all(M1_REVIEWERS.map((r) => runReviewer(ctx, r, input)));
  ctx.events.emit({ step: "review", event: "step_finished", data: { round: input.round } });
  return outputs;
}
