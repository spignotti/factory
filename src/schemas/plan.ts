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
 * change; such a run is high risk (auto-merge stays off) and its gates keep the base commit's config.
 */
export const ProtectedChangeSchema = z.object({
  file: z.string().min(1),
  change: z.string().min(1),
  reason: z.string().min(1),
});
export type ProtectedChange = z.infer<typeof ProtectedChangeSchema>;

/**
 * One `out_of_scope` item: a string. Models often write the `protected_changes` shape instead
 * (`{"file", "change", "reason"?}`, e.g. adopt's "put such changes in out_of_scope with the exact
 * change"); such an object is folded into `"<file>: <change> (<reason>)"` rather than rejecting the plan.
 */
export const OutOfScopeItemSchema = z.preprocess((v) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const x = o[k];
      if (typeof x === "string" && x.trim()) return x.trim();
    }
    return undefined;
  };
  const change = str("change", "description", "text", "item");
  if (!change) return v; // nothing to fold: still rejected as "expected string"
  const file = str("file", "path");
  const reason = str("reason");
  return `${file ? `${file}: ` : ""}${change}${reason ? ` (${reason})` : ""}`;
}, z.string());

/** Manual commands on the production host. Omit the key when the change needs none. */
export const HostStepsSchema = z.object({
  commands: z.array(z.string().trim().min(1)).min(1).max(40),
  verify: z.string().trim().min(1),
  rollback: z.string().trim().min(1),
});
export type HostSteps = z.infer<typeof HostStepsSchema>;

export const PlanSchema = z.object({
  version: z.literal(1),
  type: z.enum(["feature", "bug", "chore"]),
  goal: z.string().min(1),
  context: z.string().default(""),
  packages: z.array(PackageSchema).min(1),
  acceptance: z.array(AcceptanceSchema).min(1),
  out_of_scope: z.array(OutOfScopeItemSchema).default([]),
  resolves_findings: z.array(z.string()).default([]),
  protected_changes: z.array(ProtectedChangeSchema).default([]),
  /** Present only when the change needs copy-paste commands on the production host. */
  host_steps: HostStepsSchema.optional(),
  /**
   * `not_applicable` skips the red-on-base proof. A loosening: `red_green_reason` is required.
   * Omit (or `required`) for a normal bug. The issue label `factory:red-green-not-applicable`
   * is the same opt-in and also needs `red_green_reason`.
   */
  red_green: z.enum(["required", "not_applicable"]).optional(),
  red_green_reason: z.string().trim().min(1).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Issue label that opts a bug out of the red-on-base proof. The plan must still state `red_green_reason`. */
export const RED_GREEN_NA_LABEL = "factory:red-green-not-applicable";

export const RED_GREEN_NEEDS_REASON = "red_green exemption is a loosening and needs red_green_reason";

export type RedGreenDecision =
  | { kind: "required" }
  | { kind: "exempt"; reason: string }
  | { kind: "missing_reason" };

/**
 * Opt-in only. `red_green: required` keeps the proof even when the issue is labeled.
 * A label or `not_applicable` without `red_green_reason` is a loosening that is not yet justified.
 */
export function redGreenDecision(plan: Pick<Plan, "red_green" | "red_green_reason">, labels: string[] = []): RedGreenDecision {
  if (plan.red_green === "required") return { kind: "required" };
  const optedIn = plan.red_green === "not_applicable" || labels.includes(RED_GREEN_NA_LABEL);
  if (!optedIn) return { kind: "required" };
  const reason = plan.red_green_reason?.trim() ?? "";
  if (!reason) return { kind: "missing_reason" };
  return { kind: "exempt", reason };
}

/** Config-guard view of the same decision: a missing reason fails; a stated reason is a visible loosening. */
export function redGreenLoosening(plan: Pick<Plan, "red_green" | "red_green_reason">, labels: string[] = []): { fail?: string; note?: string } {
  const d = redGreenDecision(plan, labels);
  if (d.kind === "missing_reason") return { fail: RED_GREEN_NEEDS_REASON };
  if (d.kind === "exempt") return { note: `loosening: red_green not_applicable — ${d.reason}` };
  return {};
}

/** Gate-result line when the proof is skipped. The `EXEMPT` prefix is what the PR body keeps. */
export function redGreenExemptDetail(reason: string): string {
  return `EXEMPT not_applicable (loosening): ${reason}`;
}

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
  /** Issue labels. `factory:red-green-not-applicable` opts into the red-green exemption and needs a reason. */
  labels?: string[];
}

export type PlanValidation = { ok: true; plan: Plan } | { ok: false; errors: string[] };

function dropNullHostSteps(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("host_steps" in raw)) return raw;
  if ((raw as { host_steps?: unknown }).host_steps !== null) return raw;
  const { host_steps: _drop, ...rest } = raw as { host_steps?: unknown };
  return rest;
}

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
  const input = dropNullHostSteps(raw);
  const parsed = PlanSchema.safeParse(input);
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

  if (redGreenDecision(plan, ctx.labels ?? []).kind === "missing_reason") errors.push(RED_GREEN_NEEDS_REASON);

  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

const ONLY_FILLER = "in|under|within|to|the|a|an|file|files|path|paths|touch|touching|change|changing|edit|editing|modify|modifying|update|updating";
const ONLY_EXT = "py|js|jsx|ts|tsx|mjs|cjs|go|rs|java|rb|php|cs|json|ya?ml|toml|md|sql|sh|css|html|vue|svelte";

/** Paths an "only <path>" restriction names. Filler words between `only` and the path stay limited so "only when" is not a restriction. */
function onlyPaths(text: string): string[] {
  const re = new RegExp(
    `\\bonly\\b(?:\\s+(?:${ONLY_FILLER}))*\\s+\`?((?:[A-Za-z0-9_@][\\w.@+-]*\\/)+[\\w.@+-]+|[A-Za-z0-9_@][\\w@+-]*\\.(?:${ONLY_EXT}))\`?`,
    "gi",
  );
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const path = m[1]?.replace(/[.,;:)]+$/g, "");
    if (path) out.push(path);
  }
  return out;
}

/**
 * "only <path>" restrictions in the plan that the task text does not state.
 * A warning for the plan reviewer, not a validation error: the plan may still be used.
 */
export function scopeNarrowingWarnings(plan: Plan, taskText: string): string[] {
  const allowed = new Set(onlyPaths(taskText).map((p) => p.toLowerCase()));
  const warnings: string[] = [];
  const seen = new Set<string>();
  const consider = (where: string, text: string) => {
    for (const path of onlyPaths(text)) {
      const key = `${where}\0${path.toLowerCase()}`;
      if (seen.has(key) || allowed.has(path.toLowerCase())) continue;
      seen.add(key);
      warnings.push(`${where}: restricts to only ${path}, which the task text does not say`);
    }
  };
  for (const p of plan.packages) consider(p.id, `${p.title}\n${p.description}`);
  for (const a of plan.acceptance) consider(a.id, a.text);
  plan.out_of_scope.forEach((item, i) => consider(`out_of_scope[${i}]`, item));
  return warnings;
}

/** Notes handed to the plan reviewer: scope warnings and a red-green loosening, when either is present. */
export function planReviewNotes(plan: Plan, taskText: string, labels: string[] = []): string {
  const lines: string[] = [];
  const warnings = scopeNarrowingWarnings(plan, taskText);
  if (warnings.length) {
    lines.push("Plan scope warnings (not a gate failure). Report a bug when a warning is correct: the plan is stricter than the task.");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  const d = redGreenDecision(plan, labels);
  if (d.kind === "exempt") {
    lines.push(`red_green loosening: not_applicable. Stated reason: ${d.reason}. Report a bug unless the task is test-stabilization and this reason justifies skipping the red-on-base proof.`);
  } else if (d.kind === "missing_reason") {
    lines.push(`red_green loosening requested without a stated reason. ${RED_GREEN_NEEDS_REASON}. Report a bug.`);
  }
  return lines.join("\n");
}

const CLAIM_PATH = /[A-Za-z0-9_@][\w.@+-]*(?:\/[\w.@+-]+)+/g;

/** File paths named in a review claim. Globs and bare words are not paths. */
export function pathsInText(text: string): string[] {
  return [...text.matchAll(CLAIM_PATH)].map((m) => m[0]);
}

function stripOnly(text: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\bonly\\b(?:\\s+(?:${ONLY_FILLER}))*\\s+\`?${escaped}\`?`, "gi");
  return text.replace(re, " ").replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/**
 * Drops invented `only <path>` restrictions the task does not state.
 * An acceptance line that was only that restriction becomes the plan goal, which is the released task.
 * Nothing is added.
 */
export function correctInventedRestrictions(plan: Plan, taskText: string): { plan: Plan; notes: string[] } {
  const warnings = scopeNarrowingWarnings(plan, taskText);
  if (!warnings.length) return { plan, notes: [] };
  const next = structuredClone(plan);
  const notes: string[] = [];
  const dropScope: number[] = [];
  for (const warning of warnings) {
    const parsed = warning.match(/^(.*?): restricts to only ([^,\s]+),/);
    if (!parsed) continue;
    const where = parsed[1]!;
    const path = parsed[2]!;
    const note = `removed invented restriction only ${path} from ${where}`;
    if (where.startsWith("out_of_scope[")) {
      const i = Number(where.slice("out_of_scope[".length, -1));
      const before = next.out_of_scope[i];
      if (before === undefined) continue;
      const after = stripOnly(before, path).trim();
      if (after === before) continue;
      if (after) next.out_of_scope[i] = after;
      else dropScope.push(i);
      notes.push(note);
      continue;
    }
    const acceptance = next.acceptance.find((a) => a.id === where);
    if (acceptance) {
      const after = stripOnly(acceptance.text, path).trim() || next.goal;
      if (after === acceptance.text) continue;
      acceptance.text = after;
      notes.push(note);
      continue;
    }
    const pkg = next.packages.find((p) => p.id === where);
    if (!pkg) continue;
    const description = stripOnly(pkg.description, path).trim();
    const title = stripOnly(pkg.title, path).trim();
    let changed = false;
    if (description !== pkg.description) {
      pkg.description = description;
      changed = true;
    }
    if (title && title !== pkg.title) {
      pkg.title = title;
      changed = true;
    }
    if (changed) notes.push(note);
  }
  if (dropScope.length) {
    const drop = new Set(dropScope);
    next.out_of_scope = next.out_of_scope.filter((_, i) => !drop.has(i));
  }
  return { plan: next, notes };
}

/**
 * Removes a plan file the reviewer called stale when the tree does not have it and the task does not name it.
 * The package keeps at least one file: emptying it would invent a replacement path.
 */
export function dropStalePlanPaths(
  plan: Plan,
  taskText: string,
  exists: (file: string) => boolean,
  claimText: string,
): { plan: Plan; notes: string[] } {
  const named = new Set(pathsInText(claimText));
  const task = taskText.toLowerCase();
  const next = structuredClone(plan);
  const notes: string[] = [];
  for (const pkg of next.packages) {
    const stale = pkg.files.filter((file) => named.has(file) && !file.includes("*") && !exists(file) && !task.includes(file.toLowerCase()));
    if (!stale.length) continue;
    const kept = pkg.files.filter((file) => !stale.includes(file));
    if (!kept.length) continue;
    pkg.files = kept;
    notes.push(`dropped stale path ${stale.join(", ")} from ${pkg.id}`);
  }
  return { plan: next, notes };
}

let planJsonSchema: Record<string, unknown> | undefined;

function planSchemaRoot(): Record<string, unknown> {
  planJsonSchema ??= z.toJSONSchema(PlanSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return planJsonSchema;
}

/**
 * JSON schema node for a zod path such as `acceptance.0` or `packages.0.id`.
 * Array indexes select `items`. Undefined when the path is not a schema field
 * (a code check like `A2: source_quote …`).
 */
export function planFieldSchema(path: string): unknown | undefined {
  const parts = path.split(".").filter(Boolean);
  let node: unknown = planSchemaRoot();
  for (const part of parts) {
    if (!node || typeof node !== "object") return undefined;
    const o = node as { properties?: Record<string, unknown>; items?: unknown };
    if (/^\d+$/.test(part)) {
      if (!o.items) return undefined;
      node = o.items;
      continue;
    }
    if (o.properties && part in o.properties) {
      node = o.properties[part];
      continue;
    }
    const items = o.items as { properties?: Record<string, unknown> } | undefined;
    if (items?.properties && part in items.properties) {
      node = items.properties[part];
      continue;
    }
    return undefined;
  }
  return node;
}

/**
 * Second `plan_normalize` attempt. The first prompt only names "plan schema shape", so a fast model
 * invents strings for `acceptance` and omits ids (runs 20261104-124243-50c0b0 and 20261104-140835-5be6cd).
 * Repeating the zod sentence did not show the object those paths require, so the retry came back invalid too.
 */
export function normalizeRetryNote(errors: string[]): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const path = error.split(":")[0]?.trim() ?? "";
    const schema = planFieldSchema(path);
    if (schema === undefined) continue;
    const key = path.replace(/\.\d+(?=\.|$)/g, "[]");
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(`${key}:\n${JSON.stringify(schema)}`);
  }
  return [
    "Your previous output was rejected. Return only one ```json block and no other text.",
    `Zod errors (path: message):\n${errors.map((e) => `- ${e}`).join("\n")}`,
    blocks.length ? `JSON schema for the failing fields:\n${blocks.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
