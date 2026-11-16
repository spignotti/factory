import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractJson } from "../agents/runner.js";
import type { GitHub, IssueComment } from "../gh.js";
import { type AgentCall, callAgent, type RunContext, type Task } from "../pipeline/context.js";
import { asData, rolePrompt } from "../prompts.js";
import { normalizeRetryNote, type Plan, QuestionsSchema, validatePlan } from "../schemas/plan.js";
import { planStep } from "./plan.js";

export type PlanEffort = "none" | "medium" | "high";

export interface TaskInput {
  issue?: number;
  planFile?: string;
  textFile?: string;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "task").replace(/^#+\s*/, "").trim();
}

/** One comment longer than this is cut. */
export const MAX_COMMENT_CHARS = 4_000;
/** The comment section stays under this; the newest comments are kept because answers come last. */
export const MAX_COMMENTS_CHARS = 16_000;

/**
 * Issue comments for the planner, oldest first, under one heading. Hidden (minimized) and empty
 * comments are left out. The factory's own question comment stays in, so the answers have context.
 */
export function renderIssueComments(comments: IssueComment[]): string {
  const blocks = comments
    .filter((c) => !c.minimized && c.body.trim())
    .map((c) => {
      const body = c.body.trim();
      const text = body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS)}\n[comment truncated]` : body;
      return `### ${c.author}${c.association ? ` (${c.association.toLowerCase()})` : ""}, ${c.created_at}\n\n${text}`;
    });
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (size + block.length > MAX_COMMENTS_CHARS) break;
    kept.unshift(block);
    size += block.length;
  }
  if (!kept.length) return "";
  const omitted = blocks.length - kept.length;
  return ["## Issue comments (oldest first)", omitted ? `(${omitted} earlier comments omitted)` : "", ...kept].filter(Boolean).join("\n\n");
}

/** Reads the task from an issue, a plan file or a plain-text file. */
export async function readTask(input: TaskInput, repoDir: string, github: GitHub): Promise<Task> {
  if (input.issue !== undefined) {
    const issue = await github.getIssue(repoDir, input.issue);
    // A failed read throws: planning without the answers would only ask the same questions again.
    const comments = renderIssueComments(await github.issueComments(repoDir, input.issue));
    return {
      ref: `#${issue.number}`,
      issue: issue.number,
      title: issue.title,
      text: `# ${issue.title}\n\n${issue.body}`,
      labels: issue.labels,
      ...(comments ? { comments } : {}),
    };
  }
  const file = input.planFile ?? input.textFile;
  if (!file) throw new Error("one of --issue, --plan or --text is required");
  const text = readFileSync(file, "utf8");
  return { ref: resolve(file), title: firstLine(text), text, labels: [] };
}

/** CLI flag, else issue label `factory:plan-<effort>`, else `high`. */
export function resolvePlanEffort(flag: PlanEffort | undefined, labels: string[]): PlanEffort {
  if (flag) return flag;
  for (const effort of ["none", "medium", "high"] as const) if (labels.includes(`factory:plan-${effort}`)) return effort;
  return "high";
}

/** A fenced ```factory-plan block, if present. */
export function extractPlanBlock(text: string): unknown {
  const m = /```factory-plan\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1] ?? "");
  } catch {
    return undefined;
  }
}

export type PlanOutcome =
  | { kind: "plan"; plan: Plan; source: "block" | "plan_normalize" | "plan_medium" | "plan_high" }
  | { kind: "needs_input"; questions: string[] }
  | { kind: "failed"; reason: string };

type IntakeContext = Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "task" | "repoDir" | "deadline">;

type NormalizeAttempt = { n: number; ok: boolean; errors?: string[] };

/** `plan_normalize`: translate the text without adding content. Every quote is checked in code. One retry gets the schema errors; the event lists both attempts. */
async function normalize(ctx: IntakeContext): Promise<PlanOutcome | { kind: "invalid"; errors: string[] }> {
  const attempts: NormalizeAttempt[] = [];
  let errors: string[] = [];
  for (let n = 1; n <= 2; n++) {
    const call: AgentCall = {
      role: "plan_normalize",
      cwd: ctx.repoDir,
      tools: "none",
      system: rolePrompt("plan_normalize", ctx.deps.prompts),
      prompt: [
        asData("task", ctx.task.text),
        ctx.task.comments ? asData("issue_comments", ctx.task.comments) : "",
        ctx.task.labels.length ? `Issue labels: ${ctx.task.labels.join(", ")}` : "",
        errors.length
          ? normalizeRetryNote(errors)
          : "Return only plan.json (plan schema shape) or {\"version\":1,\"questions\":[...]} as a ```json block.",
      ].filter(Boolean).join("\n\n"),
    };
    const res = await callAgent(ctx, "intake", call);
    const json = extractJson(res.text);
    const questions = QuestionsSchema.safeParse(json);
    if (questions.success) return { kind: "needs_input", questions: questions.data.questions };
    const v = validatePlan(json, { repo: ctx.repo, sourceText: ctx.task.text, labels: ctx.task.labels });
    if (v.ok) {
      attempts.push({ n, ok: true });
      ctx.events.emit({ step: "intake", event: "progress", role: "plan_normalize", data: { attempts } });
      return { kind: "plan", plan: v.plan, source: "plan_normalize" };
    }
    errors = json === undefined ? ["no JSON object in output"] : v.errors;
    attempts.push({ n, ok: false, errors });
    ctx.events.emit({ step: "intake", event: "progress", role: "plan_normalize", data: { attempt: n, rejected: errors, attempts } });
  }
  return { kind: "invalid", errors };
}

/** Intake steps 3–5: plan block, normalize (effort none), else plan step. */
export async function obtainPlan(ctx: IntakeContext, effort: PlanEffort): Promise<PlanOutcome> {
  const block = extractPlanBlock(ctx.task.text);
  if (block !== undefined) {
    const v = validatePlan(block, { repo: ctx.repo, labels: ctx.task.labels });
    if (v.ok) return { kind: "plan", plan: v.plan, source: "block" };
  }
  let level: "medium" | "high" = effort === "medium" ? "medium" : "high";
  if (effort === "none") {
    const n = await normalize(ctx);
    if (n.kind !== "invalid") return n;
    level = "medium";
  }
  return planStep(ctx, level);
}
