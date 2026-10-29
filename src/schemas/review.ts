import { z } from "zod";

export const ReviewerSchema = z.enum(["plan", "simplicity", "security", "checklist", "evaluator"]);
export type Reviewer = z.infer<typeof ReviewerSchema>;

export const SeveritySchema = z.enum(["bug", "suggestion", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().default(""),
  line: z.number().int().min(0).default(0),
  claim: z.string().min(1),
  evidence: z.string().default(""),
  fix: z.string().default(""),
  checkable: z.enum(["lint", "test", "script", "no"]).default("no"),
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
