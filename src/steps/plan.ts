import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { parseChecklist, unmarkedItems } from "../checklist.js";
import { git } from "../git.js";
import { callAgent, type RunContext } from "../pipeline/context.js";
import { asData, rolePrompt } from "../prompts.js";
import { QuestionsSchema, validatePlan } from "../schemas/plan.js";
import type { PlanOutcome } from "./intake.js";

type PlanContext = Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "task" | "repoDir" | "deadline">;

const PLAN_SHAPE = `plan.json shape:
{"version":1,"type":"feature|bug|chore","goal":"","context":"",
 "packages":[{"id":"P1","title":"","description":"","files":[],"depends_on":[],"changes_flows":[]}],
 "acceptance":[{"id":"A1","package":"P1","text":"","verify":"test|check|evaluator|review","kind":"behavior|edge_case|repro","risk":false}],
 "out_of_scope":[]}
or {"version":1,"questions":["..."]}. Return it as a single \`\`\`json block.`;

async function planInput(ctx: PlanContext): Promise<string> {
  const files = (await git(ctx.repoDir, ["ls-files"])).split("\n").filter(Boolean);
  const tree = files.slice(0, 400).join("\n") + (files.length > 400 ? `\n… ${files.length - 400} more` : "");
  const agentsPath = join(ctx.repoDir, "AGENTS.md");
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "(none)";
  const checklistPath = join(ctx.repoDir, ".factory", "checklist.md");
  const checklist = ctx.repo.review.checklist && existsSync(checklistPath) ? unmarkedItems(parseChecklist(readFileSync(checklistPath, "utf8"))) : [];
  const areas = ctx.repo.verify.areas.map((a) => `- ${a.name}: ${a.paths.join(", ")}`).join("\n") || "(none)";
  return [
    asData("task", ctx.task.text),
    `Repo tree:\n${tree}`,
    `AGENTS.md:\n${agents}`,
    `Verify areas:\n${areas}`,
    checklist.length ? `Checklist items (the checklist reviewer checks the diff against them; plan for the relevant ones):\n${asData("checklist_items", checklist.map((i) => `- ${i.text}`).join("\n"))}` : "",
    `sensitive_paths: ${JSON.stringify(ctx.repo.sensitive_paths)}; ui: ${ctx.repo.ui ? "yes" : "no"}`,
    PLAN_SHAPE,
  ].filter(Boolean).join("\n\n");
}

/** Plan step (`plan_high` / `plan_medium`): invalid output gets one retry with the errors. */
export async function planStep(ctx: PlanContext, level: "medium" | "high"): Promise<PlanOutcome> {
  const role = level === "high" ? "plan_high" : "plan_medium";
  ctx.events.emit({ step: "plan", event: "step_started", role, data: { level } });
  const base = await planInput(ctx);
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = errors.length ? `${base}\n\nYour previous plan was rejected:\n- ${errors.join("\n- ")}` : base;
    const res = await callAgent(ctx, "plan", { role, cwd: ctx.repoDir, tools: "read_only", system: rolePrompt("plan", ctx.deps.prompts), prompt });
    const json = extractJson(res.text);
    const questions = QuestionsSchema.safeParse(json);
    if (questions.success) {
      ctx.events.emit({ step: "plan", event: "step_finished", role, data: { outcome: "needs_input" } });
      return { kind: "needs_input", questions: questions.data.questions };
    }
    const v = validatePlan(json, { repo: ctx.repo });
    if (v.ok) {
      ctx.events.emit({ step: "plan", event: "step_finished", role, data: { outcome: "plan" } });
      return { kind: "plan", plan: v.plan, source: role };
    }
    errors = json === undefined ? ["no JSON object in output"] : v.errors;
    ctx.events.emit({ step: "plan", event: "progress", role, data: { rejected: errors } });
  }
  ctx.events.emit({ step: "plan", event: "step_finished", role, data: { outcome: "invalid" } });
  return { kind: "failed", reason: `plan invalid after retry: ${errors.join("; ")}` };
}
