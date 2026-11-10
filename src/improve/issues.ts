import type { Issue, IssueWrite, LabelSpec } from "../gh.js";
import type { Plan } from "../schemas/plan.js";
import { IMPROVE_ASPECTS, type ImproveAspect } from "../schemas/repo.js";

/** Relabel to `factory-ready` to queue the issue. `factory queue add` does not accept this label. */
export const FACTORY_PROPOSAL_LABEL = "factory-proposal";

export const aspectLabel = (aspect: ImproveAspect): string => `improve:${aspect}`;

export function proposalLabels(aspect: ImproveAspect): LabelSpec[] {
  return [
    { name: FACTORY_PROPOSAL_LABEL, color: "1D76DB", description: "Factory improvement proposal; relabel factory-ready to queue it" },
    { name: aspectLabel(aspect), color: "5319E7", description: `improve aspect: ${aspect}` },
  ];
}

/** Stable issue identity. A later run with the same goal updates; overlapping findings match even if the goal moved. */
export function proposalKey(aspect: ImproveAspect, goal: string): string {
  const slug = goal.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${aspect}:${slug || "proposal"}`;
}

export function proposalIssueTitle(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 240);
}

const MARK = /<!-- factory-proposal key="([^"]*)" findings="([^"]*)" -->/;

export function proposalIssueBody(rationale: string, plan: Plan, key: string, findings: string[]): string {
  const safe = (s: string) => s.replace(/"/g, "");
  return `${rationale.trim()}\n\n\`\`\`factory-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\n<!-- factory-proposal key="${safe(key)}" findings="${findings.map(safe).join(",")}" -->\n`;
}

export function parseProposalIssue(issue: Pick<Issue, "body" | "labels">): { key: string; findings: string[]; aspect: ImproveAspect | null } | null {
  const m = MARK.exec(issue.body);
  if (!m) return null;
  const key = m[1] ?? "";
  const fromKey = IMPROVE_ASPECTS.find((aspect) => key.startsWith(`${aspect}:`));
  const fromLabel = IMPROVE_ASPECTS.find((aspect) => issue.labels.includes(aspectLabel(aspect)));
  const findings = (m[2] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return { key, findings, aspect: fromKey ?? fromLabel ?? null };
}

/** Open issue of this aspect with the same key or any of the same findings. */
export function matchingIssue(issues: readonly Issue[], aspect: ImproveAspect, key: string, findings: readonly string[]): Issue | undefined {
  return issues.find((issue) => {
    if ((issue.state ?? "open") !== "open") return false;
    if (!issue.labels.includes(FACTORY_PROPOSAL_LABEL)) return false;
    const parsed = parseProposalIssue(issue);
    if (!parsed || parsed.aspect !== aspect) return false;
    if (parsed.key === key) return true;
    return findings.some((f) => parsed.findings.includes(f));
  });
}

export function issueWrite(aspect: ImproveAspect, rationale: string, plan: Plan, findings: string[]): IssueWrite & { labels: string[]; key: string } {
  const key = proposalKey(aspect, plan.goal);
  return {
    key,
    title: proposalIssueTitle(plan.goal),
    body: proposalIssueBody(rationale, plan, key, findings),
    labels: proposalLabels(aspect).map((l) => l.name),
  };
}
