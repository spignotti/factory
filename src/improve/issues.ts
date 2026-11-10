import { createHash } from "node:crypto";
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

/**
 * Identity of a proposal, independent of the goal text.
 * Resolves findings: `<aspect>:<sorted keys>`. Otherwise `<aspect>:` plus the sha256 of the sorted
 * file paths the plan changes (64 hex; a finding key is shorter, so the two forms do not collide).
 */
export function proposalKey(aspect: ImproveAspect, plan: Pick<Plan, "resolves_findings" | "packages" | "protected_changes">): string {
  const findings = [...new Set((plan.resolves_findings ?? []).map((k) => k.trim()).filter(Boolean))].sort();
  if (findings.length) return `${aspect}:${findings.join(",")}`;
  const files = [
    ...new Set(
      [...plan.packages.flatMap((p) => p.files), ...(plan.protected_changes ?? []).map((c) => c.file)]
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  ].sort();
  return `${aspect}:${createHash("sha256").update(files.join("\n")).digest("hex")}`;
}

/** First proposal with a key wins. Later ones with that key are dropped and listed; nothing is overwritten. */
export function dedupeProposals<T extends { plan: Pick<Plan, "goal" | "resolves_findings" | "packages" | "protected_changes"> }>(
  aspect: ImproveAspect,
  items: readonly T[],
): { kept: T[]; dropped: string[] } {
  const kept: T[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const item of items) {
    const key = proposalKey(aspect, item.plan);
    if (seen.has(key)) {
      dropped.push(`dropped duplicate proposal key ${key}: ${item.plan.goal}`);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return { kept, dropped };
}

export function proposalIssueTitle(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Hidden marker. Dedup matches this, not the labels, so a relabel to `factory-ready` stays the same proposal. */
export function proposalMarker(key: string): string {
  return `<!-- factory-proposal: ${key} -->`;
}

const MARK = /<!-- factory-proposal: ([a-z]+:[0-9a-f,]+) -->/;

export function proposalKeyFromBody(body: string): string | null {
  return MARK.exec(body)?.[1] ?? null;
}

/** Finding keys carried in a proposal key. A 64-hex payload is a path hash, not a finding. */
export function findingsInKey(key: string): string[] {
  const rest = key.slice(key.indexOf(":") + 1);
  if (/^[0-9a-f]{64}$/.test(rest)) return [];
  return rest.split(",").map((k) => k.trim()).filter(Boolean);
}

export function proposalIssueBody(rationale: string, plan: Plan, key: string): string {
  return `${rationale.trim()}\n\n\`\`\`factory-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\n${proposalMarker(key)}\n`;
}

export function parseProposalIssue(issue: Pick<Issue, "body" | "labels">): { key: string; findings: string[]; aspect: ImproveAspect | null } | null {
  const key = proposalKeyFromBody(issue.body);
  if (!key) return null;
  const fromKey = IMPROVE_ASPECTS.find((aspect) => key.startsWith(`${aspect}:`));
  const fromLabel = IMPROVE_ASPECTS.find((aspect) => issue.labels.includes(aspectLabel(aspect)));
  return { key, findings: findingsInKey(key), aspect: fromKey ?? fromLabel ?? null };
}

/** Open issue whose body carries this proposal's marker, whatever its labels. */
export function matchingIssue(issues: readonly Issue[], key: string): Issue | undefined {
  const marker = proposalMarker(key);
  return issues.find((issue) => (issue.state ?? "open") === "open" && issue.body.includes(marker));
}

export function issueWrite(aspect: ImproveAspect, rationale: string, plan: Plan): IssueWrite & { labels: string[]; key: string } {
  const key = proposalKey(aspect, plan);
  return {
    key,
    title: proposalIssueTitle(plan.goal),
    body: proposalIssueBody(rationale, plan, key),
    labels: proposalLabels(aspect).map((l) => l.name),
  };
}
