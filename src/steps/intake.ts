import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractJson } from "../agents/runner.js";
import type { GitHub } from "../gh.js";
import { type AgentCall, callAgent, type RunContext, type Task } from "../pipeline/context.js";
import { asData, rolePrompt } from "../prompts.js";
import { type Plan, QuestionsSchema, validatePlan } from "../schemas/plan.js";
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

/** Reads the task from an issue, a plan file or a plain-text file. */
export async function readTask(input: TaskInput, repoDir: string, github: GitHub): Promise<Task> {
  if (input.issue !== undefined) {
    const issue = await github.getIssue(repoDir, input.issue);
    return { ref: `#${issue.number}`, issue: issue.number, title: issue.title, text: `# ${issue.title}\n\n${issue.body}`, labels: issue.labels };
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

type IntakeContext = Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "task" | "repoDir">;

/** `plan_normalize`: translate the text without adding content. Every quote is checked in code. */
async function normalize(ctx: IntakeContext): Promise<PlanOutcome | { kind: "invalid"; errors: string[] }> {
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const call: AgentCall = {
      role: "plan_normalize",
      cwd: ctx.repoDir,
      tools: "none",
      system: rolePrompt("plan_normalize"),
      prompt: [
        asData("task", ctx.task.text),
        "Return only plan.json (SPEC §7.1 shape) or {\"version\":1,\"questions\":[...]} as a ```json block.",
        errors.length ? `Your previous output was rejected:\n- ${errors.join("\n- ")}` : "",
      ].filter(Boolean).join("\n\n"),
    };
    const res = await callAgent(ctx, "intake", call);
    const json = extractJson(res.text);
    const questions = QuestionsSchema.safeParse(json);
    if (questions.success) return { kind: "needs_input", questions: questions.data.questions };
    const v = validatePlan(json, { repo: ctx.repo, sourceText: ctx.task.text });
    if (v.ok) return { kind: "plan", plan: v.plan, source: "plan_normalize" };
    errors = json === undefined ? ["no JSON object in output"] : v.errors;
    ctx.events.emit({ step: "intake", event: "progress", role: "plan_normalize", data: { rejected: errors } });
  }
  return { kind: "invalid", errors };
}

/** Intake steps 3–5: plan block, normalize (effort none), else plan step. */
export async function obtainPlan(ctx: IntakeContext, effort: PlanEffort): Promise<PlanOutcome> {
  const block = extractPlanBlock(ctx.task.text);
  if (block !== undefined) {
    const v = validatePlan(block, { repo: ctx.repo });
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
