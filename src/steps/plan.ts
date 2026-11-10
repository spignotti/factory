import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../agents/runner.js";
import { git } from "../git.js";
import { callAgent, type RunContext } from "../pipeline/context.js";
import { asData, asset, rolePrompt } from "../prompts.js";
import { readRepoStandards } from "../standards.js";
import { QuestionsSchema, validatePlan } from "../schemas/plan.js";
import type { PlanOutcome } from "./intake.js";

type PlanContext = Pick<RunContext, "deps" | "repo" | "agentHome" | "events" | "task" | "repoDir" | "deadline">;

export const PLAN_SHAPE = `plan.json shape:
{"version":1,"type":"feature|bug|chore","goal":"","context":"",
 "packages":[{"id":"P1","title":"","description":"","files":[],"depends_on":[],"changes_flows":[]}],
 "acceptance":[{"id":"A1","package":"P1","text":"","verify":"test|check|evaluator|review","kind":"behavior|edge_case|repro","risk":false}],
 "out_of_scope":[],"protected_changes":[]}
Optional, only when the change needs manual production-host commands (launchd, restic, Docker Desktop, files outside the repo): "host_steps":{"commands":["exact command"],"verify":"how to check","rollback":"how to undo"}. Omit host_steps otherwise.
Optional, only for test-stabilization or the issue label factory:red-green-not-applicable: "red_green":"not_applicable","red_green_reason":"why the repro cannot fail on base". That loosens the red-green proof. Omit both for a normal bug.
or {"version":1,"questions":["..."]}. Return it as a single \`\`\`json block.`;

async function planInput(ctx: PlanContext): Promise<string> {
  const files = (await git(ctx.repoDir, ["ls-files"])).split("\n").filter(Boolean);
  const tree = files.slice(0, 400).join("\n") + (files.length > 400 ? `\n… ${files.length - 400} more` : "");
  const standards = ctx.repo.review.checklist ? readRepoStandards(ctx.repoDir, asset("standards/review-rules.md")) : undefined;
  if (standards?.deprecated) ctx.events.emit({ step: "plan", event: "progress", data: { standards_deprecated: standards.deprecated } });
  const unmarked = standards?.unmarked ?? [];
  const areas = ctx.repo.verify.areas.map((a) => `- ${a.name}: ${a.paths.join(", ")}`).join("\n") || "(none)";
  return [
    asData("task", ctx.task.text),
    `Repo tree:\n${tree}`,
    // AGENTS.md is not pasted here: the agent session carries the base worktree's AGENTS.md as context.
    existsSync(join(ctx.repoDir, "AGENTS.md")) ? "" : "AGENTS.md: (none)",
    `Verify areas:\n${areas}`,
    unmarked.length ? `Standards rules (the standards reviewer checks the diff against them; plan for the relevant ones):\n${asData("standards_items", unmarked.map((i) => `- ${i.text}`).join("\n"))}` : "",
    `sensitive_paths: ${JSON.stringify(ctx.repo.sensitive_paths)}; human_only_paths: ${JSON.stringify(ctx.repo.human_only_paths)}; ui: ${ctx.repo.ui ? "yes" : "no"}`,
    ctx.task.labels.length ? `Issue labels: ${ctx.task.labels.join(", ")}` : "",
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
    const v = validatePlan(json, { repo: ctx.repo, labels: ctx.task.labels });
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
