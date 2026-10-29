import { z } from "zod";

export const ResponseSchema = z.object({
  finding_id: z.string().min(1),
  status: z.enum(["fixed", "wontfix"]),
  response: z.string().default(""),
});
export type FindingResponse = z.infer<typeof ResponseSchema>;

export const HandoffSchema = z.object({
  package: z.string().min(1),
  done: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  deviations_from_plan: z.array(z.string()).default([]),
  skipped: z.array(z.string()).default([]),
  uncertain: z.array(z.string()).default([]),
  evidence: z
    .array(z.object({ acceptance_id: z.string().min(1), kind: z.enum(["test", "check"]), ref: z.string().min(1) }))
    .default([]),
  responses: z.array(ResponseSchema).default([]),
});
export type Handoff = z.infer<typeof HandoffSchema>;
