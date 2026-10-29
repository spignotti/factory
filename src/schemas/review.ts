import { z } from "zod";

export const ReviewerSchema = z.enum(["plan", "simplicity", "security", "checklist", "evaluator"]);
export type Reviewer = z.infer<typeof ReviewerSchema>;

export const SeveritySchema = z.enum(["bug", "suggestion", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CHECKABLE = ["lint", "test", "script", "no"] as const;

/**
 * Models often answer `checkable` loosely ("yes", true, "unit test"). A loose value used to make the
 * whole review invalid; the retry then cost a session and could drop the finding. Normalized instead:
 * a negation (no/not/none/false) is `no`, else a known kind named in the text wins, a plain yes/true or
 * "check" is `script` (checkable, kind unknown), anything else (null, numbers, unclear text) is `no`.
 */
export function normalizeCheckable(v: unknown): unknown {
  if (v === undefined) return v;
  if (v === true) return "script";
  if (typeof v !== "string") return "no";
  const t = v.trim().toLowerCase();
  if ((CHECKABLE as readonly string[]).includes(t)) return t;
  if (/\b(no|not|none|false|n\/a)\b/.test(t)) return "no";
  if (/\blint/.test(t)) return "lint";
  if (/\btest/.test(t)) return "test";
  if (/\bscript|\bcheck/.test(t) || /^(yes|y|true)$/.test(t)) return "script";
  return "no";
}

export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().default(""),
  line: z.number().int().min(0).default(0),
  claim: z.string().min(1),
  evidence: z.string().default(""),
  fix: z.string().default(""),
  checkable: z.preprocess(normalizeCheckable, z.enum(CHECKABLE).default("no")),
  check_sketch: z.string().default(""),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictSchema = z.enum(["resolved", "accept_wontfix", "still_open", "reject_wontfix"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ReviewOutputSchema = z.object({
  reviewer: ReviewerSchema,
  prior: z.array(z.object({ finding_id: z.string().min(1), verdict: VerdictSchema })).default([]),
  findings: z.array(FindingSchema).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** Fast lane `lean` review: plan and simplicity in one session. */
export const LeanOutputSchema = z.object({ reviews: z.array(ReviewOutputSchema) });
