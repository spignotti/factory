import picomatch from "picomatch";
import { z } from "zod";
import { topoOrder } from "../pipeline/dag.js";
import type { RepoConfig } from "./repo.js";

export const PackageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  files: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  changes_flows: z.array(z.string()).default([]),
  source_quote: z.string().optional(),
});
export type Package = z.infer<typeof PackageSchema>;

export const AcceptanceSchema = z.object({
  id: z.string().min(1),
  package: z.string().min(1),
  text: z.string().min(1),
  verify: z.enum(["test", "check", "evaluator", "review"]),
  kind: z.enum(["behavior", "edge_case", "repro"]).default("behavior"),
  risk: z.boolean().default(false),
  source_quote: z.string().optional(),
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

/**
 * A declared change to a `human_only_paths` file (CI workflows, `.factory/`). Only declared files may
 * change; such a run always ends with human review and its gates keep the base commit's config.
 */
export const ProtectedChangeSchema = z.object({
  file: z.string().min(1),
  change: z.string().min(1),
  reason: z.string().min(1),
});
export type ProtectedChange = z.infer<typeof ProtectedChangeSchema>;

export const PlanSchema = z.object({
  version: z.literal(1),
  type: z.enum(["feature", "bug", "chore"]),
  goal: z.string().min(1),
  context: z.string().default(""),
  packages: z.array(PackageSchema).min(1),
  acceptance: z.array(AcceptanceSchema).min(1),
  out_of_scope: z.array(z.string()).default([]),
  resolves_findings: z.array(z.string()).default([]),
  protected_changes: z.array(ProtectedChangeSchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const QuestionsSchema = z.object({
  version: z.literal(1),
  questions: z.array(z.string().min(1)).min(1),
});
export type Questions = z.infer<typeof QuestionsSchema>;

export const MAX_PACKAGES = 8;
export const MAX_FILES_PER_PACKAGE = 8;

export interface PlanValidationContext {
  repo: RepoConfig;
  /** Raw task text. When set, every package and criterion needs a `source_quote` found in it (plan_normalize output). */
  sourceText?: string;
}

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; errors: string[] };

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Verbatim check, tolerant only of whitespace differences (line wrapping). */
export function quoteOccursIn(quote: string, text: string): boolean {
  const q = normalizeWs(quote);
  return q.length > 0 && normalizeWs(text).includes(q);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.length > 0 && picomatch(globs, { dot: true })(file);
}

/** Verify guides and flows evolve with the app: never protected, even under a `.factory/**` glob. */
export const NEVER_PROTECTED = [".factory/verify/**"];

/** Whether `file` is protected config (`human_only_paths`, minus verify guides). */
export function isProtected(file: string, humanOnly: string[]): boolean {
  return matchesAny(file, humanOnly) && !matchesAny(file, NEVER_PROTECTED);
}

export function validatePlan(raw: unknown, ctx: PlanValidationContext): PlanValidation {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
  }
  const plan = parsed.data;
  const errors: string[] = [];

  const pkgIds = new Set<string>();
  for (const p of plan.packages) {
    if (pkgIds.has(p.id)) errors.push(`duplicate package id ${p.id}`);
    pkgIds.add(p.id);
    if (p.files.length > MAX_FILES_PER_PACKAGE) errors.push(`${p.id}: more than ${MAX_FILES_PER_PACKAGE} files`);
    for (const d of p.depends_on) if (!plan.packages.some((q) => q.id === d)) errors.push(`${p.id}: depends_on unknown ${d}`);
  }
  if (plan.packages.length > MAX_PACKAGES) errors.push(`more than ${MAX_PACKAGES} packages`);

  let ordered = plan.packages;
  if (errors.length === 0) {
    try {
      ordered = topoOrder(plan.packages);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  const accIds = new Set<string>();
  for (const a of plan.acceptance) {
    if (accIds.has(a.id)) errors.push(`duplicate acceptance id ${a.id}`);
    accIds.add(a.id);
    if (!pkgIds.has(a.package)) errors.push(`${a.id}: unknown package ${a.package}`);
    if (a.verify === "evaluator" && !ctx.repo.ui) errors.push(`${a.id}: verify:evaluator requires ui in repo.yaml`);
  }
  for (const p of plan.packages) {
    if (!plan.acceptance.some((a) => a.package === p.id)) errors.push(`${p.id}: no acceptance criterion`);
  }

  const areas = new Set(ctx.repo.verify.areas.map((a) => a.name));
  for (const p of plan.packages) {
    for (const flow of p.changes_flows) {
      if (!areas.has(flow)) errors.push(`${p.id}: changes_flows names unknown verify area ${flow}`);
    }
  }

  if (plan.type === "bug") {
    const first = ordered[0];
    const hasRepro =
      first !== undefined &&
      plan.acceptance.some((a) => a.package === first.id && a.kind === "repro" && a.verify === "test");
    if (!hasRepro) errors.push(`type bug: first package needs a kind:repro, verify:test criterion`);
  }

  for (const p of plan.packages) {
    if (!p.files.some((f) => matchesAny(f, ctx.repo.sensitive_paths))) continue;
    const hasRisk = plan.acceptance.some(
      (a) => a.package === p.id && a.kind === "edge_case" && a.verify === "test" && a.risk,
    );
    if (!hasRisk) errors.push(`${p.id}: touches sensitive_paths, needs a kind:edge_case, verify:test, risk:true criterion`);
  }

  const human = ctx.repo.human_only_paths;
  const declared = new Set<string>();
  for (const c of plan.protected_changes) {
    if (declared.has(c.file)) errors.push(`protected_changes: ${c.file} declared twice`);
    declared.add(c.file);
    if (/[*?[\]{}]/.test(c.file)) errors.push(`protected_changes: ${c.file} must be a file path, not a glob`);
    else if (!isProtected(c.file, human)) errors.push(`protected_changes: ${c.file} is not under human_only_paths (plan it as a normal file)`);
    if (!plan.packages.some((p) => p.files.includes(c.file))) errors.push(`protected_changes: ${c.file} is in no package's files`);
  }
  for (const p of plan.packages) {
    for (const f of p.files) {
      if (isProtected(f, human) && !declared.has(f)) errors.push(`${p.id}: ${f} is under human_only_paths; declare it in protected_changes (file, change, reason) or drop it`);
    }
  }

  if (ctx.sourceText !== undefined) {
    const text = ctx.sourceText;
    for (const item of [...plan.packages, ...plan.acceptance]) {
      if (!item.source_quote) errors.push(`${item.id}: source_quote missing`);
      else if (!quoteOccursIn(item.source_quote, text)) errors.push(`${item.id}: source_quote not found in task text`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan };
}
