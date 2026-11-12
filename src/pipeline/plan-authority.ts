import type { Plan } from "../schemas/plan.js";
import { correctInventedRestrictions, dropStalePlanPaths, pathsInText, scopeNarrowingWarnings } from "../schemas/plan.js";

/** Open plan-reviewer finding the settlement looks at. Other reviewers are left alone. */
export interface DisputeFinding {
  id: string;
  reviewer: string;
  severity: string;
  status: string;
  claim: string;
}

export interface PlanSettlement {
  plan: Plan;
  resolvedIds: string[];
  notes: string[];
  /** A real scope expansion, or a dispute the correction could not change. The plan is unchanged. */
  decision?: string;
}

const EXPANSION = /\b(scope expansion|beyond the task|also add|also implement)\b/i;
const RESTRICTION = /\b(stricter than the task|invented restriction|task text does not say)\b/i;
const STALE = /\b(stale path|not in the tree|does not exist)\b/i;

/**
 * The released task outranks the plan. A reviewer bug that names an invented restriction or a stale
 * path is corrected here, once. A request to add scope the task does not state is a decision.
 * The same text is not sent around again: a correction that changes nothing stops.
 */
export function settlePlanDispute(
  plan: Plan,
  taskText: string,
  findings: DisputeFinding[],
  exists: (file: string) => boolean,
): PlanSettlement {
  const openPlan = findings.filter((f) => f.reviewer === "plan" && f.severity === "bug" && f.status === "open");
  const expansion = openPlan.find((f) => EXPANSION.test(f.claim));
  if (expansion) {
    return { plan, resolvedIds: [], notes: [], decision: `scope expansion needs a decision: ${expansion.claim}` };
  }
  const warnings = scopeNarrowingWarnings(plan, taskText);
  const restriction = openPlan.filter((f) => RESTRICTION.test(f.claim) || warnings.some((w) => {
    const path = w.match(/only ([^,\s]+)/)?.[1];
    return !!path && f.claim.includes(path);
  }));
  const stale = openPlan.filter((f) => STALE.test(f.claim));
  let next = plan;
  const notes: string[] = [];
  const resolved: string[] = [];
  if (restriction.length) {
    const edited = correctInventedRestrictions(next, taskText);
    if (!edited.notes.length) {
      return { plan, resolvedIds: [], notes: [], decision: `unchanged plan dispute: ${restriction[0]!.claim}` };
    }
    next = edited.plan;
    notes.push(...edited.notes);
    resolved.push(...restriction.map((f) => f.id));
  }
  if (stale.length) {
    const edited = dropStalePlanPaths(next, taskText, exists, stale.map((f) => f.claim).join("\n"));
    const dropped = new Set(edited.notes.flatMap((note) => pathsInText(note)));
    if (edited.notes.length) {
      next = edited.plan;
      notes.push(...edited.notes);
      resolved.push(...stale.filter((f) => pathsInText(f.claim).some((p) => dropped.has(p))).map((f) => f.id));
    } else if (!notes.length) {
      return { plan, resolvedIds: [], notes: [], decision: `unchanged plan dispute: ${stale[0]!.claim}` };
    }
  }
  return { plan: next, resolvedIds: [...new Set(resolved)], notes };
}
