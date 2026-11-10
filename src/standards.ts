import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type ChecklistItem, parseChecklist, unmarkedItems } from "./checklist.js";

/**
 * `.factory/standards.md`: the repo's rules as a list, plus an optional `## Severity` section
 * (the old `.factory/review-rules.md`). A rule with `<!-- check: name -->` is automated; the name
 * must be a repo.yaml check or a pull_request job. Unmarked rules are judged by the standards reviewer.
 * When `standards.md` is missing, readers fall back to `checklist.md` and `review-rules.md`.
 */

export const STANDARDS_REL = ".factory/standards.md";
export const CHECKLIST_REL = ".factory/checklist.md";
export const REVIEW_RULES_REL = ".factory/review-rules.md";

/** One line, shared by the read path and `factory doctor --repo`. */
export const STANDARDS_DEPRECATION =
  ".factory/standards.md is missing; .factory/checklist.md and .factory/review-rules.md are deprecated. Run: factory standards migrate --repo <path>";

const SEVERITY_HEADING = /^#{1,6}[ \t]+(severity|review rules)\b/i;

export interface ResolvedStandards {
  items: ChecklistItem[];
  unmarked: ChecklistItem[];
  /** Text given to every reviewer. Severity section, else the old file, else the global default. */
  reviewRules: string;
  /** Where the rules were read from. `none` = no rules file. */
  source: "standards.md" | "checklist.md" | "none";
  /** Set when an old file was used because `standards.md` is missing. */
  deprecated?: string;
}

export interface StandardsInput {
  /** Undefined = file missing. An empty string is a present, empty file (no fallback). */
  standards?: string;
  checklist?: string;
  reviewRules?: string;
  defaultReviewRules: string;
}

/** Rules are the list before the severity heading; that heading's body is review-rule guidance. */
export function splitStandards(text: string): { rules: string; severity?: string } {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => SEVERITY_HEADING.test(l));
  if (at < 0) return { rules: text };
  return { rules: lines.slice(0, at).join("\n"), severity: lines.slice(at + 1).join("\n") };
}

export function resolveStandards(src: StandardsInput): ResolvedStandards {
  if (src.standards !== undefined) {
    const split = splitStandards(src.standards);
    const items = parseChecklist(split.rules);
    const severity = split.severity?.trim();
    return {
      items,
      unmarked: unmarkedItems(items),
      reviewRules: severity ? severity : src.defaultReviewRules,
      source: "standards.md",
    };
  }
  const items = src.checklist !== undefined ? parseChecklist(src.checklist) : [];
  const usedOld = src.checklist !== undefined || (src.reviewRules !== undefined && src.reviewRules.trim() !== "");
  return {
    items,
    unmarked: unmarkedItems(items),
    reviewRules: src.reviewRules?.trim() ? src.reviewRules : src.defaultReviewRules,
    source: src.checklist !== undefined ? "checklist.md" : "none",
    ...(usedOld ? { deprecated: STANDARDS_DEPRECATION } : {}),
  };
}

export function readOptionalFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Working tree read: `standards.md`, else the deprecated files. */
export function readRepoStandards(repoDir: string, defaultReviewRules: string): ResolvedStandards {
  const standards = readOptionalFile(join(repoDir, STANDARDS_REL));
  return resolveStandards({
    standards,
    checklist: standards === undefined ? readOptionalFile(join(repoDir, CHECKLIST_REL)) : undefined,
    reviewRules: standards === undefined ? readOptionalFile(join(repoDir, REVIEW_RULES_REL)) : undefined,
    defaultReviewRules,
  });
}

/**
 * Unmarked rules for improve's findings aspect and harden: propose making each a check and cleaning
 * up existing violations. `standards.md` wins; `checklist.md` is the deprecated fallback.
 */
export function unmarkedStandardRules(repoDir: string): string[] {
  const standards = readOptionalFile(join(repoDir, STANDARDS_REL));
  if (standards !== undefined) return unmarkedItems(parseChecklist(splitStandards(standards).rules)).map((i) => i.text);
  const checklist = readOptionalFile(join(repoDir, CHECKLIST_REL));
  return checklist === undefined ? [] : unmarkedItems(parseChecklist(checklist)).map((i) => i.text);
}

function stripTitle(text: string): string {
  return text.replace(/^\uFEFF?/, "").replace(/^#[ \t]+[^\n]*\n+/, "");
}

/**
 * `standards.md` body from the old files. Undefined when both are missing. Does not delete them.
 * A leading H1 (`# Checklist`, `# Review rules`) is dropped so the new headings own the file.
 */
export function migrateStandards(input: { checklist?: string; reviewRules?: string }): string | undefined {
  if (input.checklist === undefined && input.reviewRules === undefined) return undefined;
  const rules = input.checklist !== undefined ? stripTitle(input.checklist).trim() : "";
  const severity = input.reviewRules !== undefined ? stripTitle(input.reviewRules).trim() : "";
  const parts = ["# Standards", ""];
  if (rules) parts.push(rules, "");
  if (severity) parts.push("## Severity", "", severity, "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export interface StandardsRemoval {
  kind: "rule" | "marker";
  text: string;
  check?: string;
}

/** Rules or check markers present in `before` and gone in `after`. A deleted file removes every rule. */
export function standardsRemovals(before: string | undefined, after: string | undefined): StandardsRemoval[] {
  if (before === undefined || before === after) return [];
  const prev = parseChecklist(splitStandards(before).rules);
  const next = after === undefined ? [] : parseChecklist(splitStandards(after).rules);
  const nextByText = new Map<string, ChecklistItem[]>();
  for (const item of next) {
    const list = nextByText.get(item.text) ?? [];
    list.push(item);
    nextByText.set(item.text, list);
  }
  const used = new Map<string, number>();
  const out: StandardsRemoval[] = [];
  for (const item of prev) {
    const list = nextByText.get(item.text) ?? [];
    const n = used.get(item.text) ?? 0;
    const match = list[n];
    if (!match) {
      out.push({ kind: "rule", text: item.text });
      continue;
    }
    used.set(item.text, n + 1);
    if (item.check && item.check !== match.check) out.push({ kind: "marker", text: item.text, check: item.check });
  }
  return out;
}

export function describeStandardsRemoval(r: StandardsRemoval): string {
  return r.kind === "rule" ? `rule removed: ${r.text}` : `check marker removed: ${r.check}`;
}

/** The plan declares a removal by naming the rule text, or `check: <name>` for a marker. */
export function standardsRemovalDeclared(planText: string, r: StandardsRemoval): boolean {
  const blob = planText.toLowerCase();
  if (r.kind === "rule") return blob.includes(r.text.toLowerCase());
  const name = (r.check ?? "").toLowerCase();
  return name !== "" && (blob.includes(`check: ${name}`) || blob.includes(`check:${name}`));
}

function triggersOf(doc: Record<string, unknown>): string[] {
  const on = doc.on ?? doc.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/** Job ids and `name:` values of workflows that run on pull_request (or pull_request_target). */
export function pullRequestJobNames(repoDir: string): string[] {
  const dir = join(repoDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    let doc: Record<string, unknown>;
    try {
      doc = (parse(readFileSync(join(dir, file), "utf8")) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    const triggers = triggersOf(doc);
    if (!triggers.some((t) => t === "pull_request" || t === "pull_request_target")) continue;
    const jobs = doc.jobs;
    if (!jobs || typeof jobs !== "object") continue;
    for (const [id, job] of Object.entries(jobs as Record<string, unknown>)) {
      names.push(id);
      if (job && typeof job === "object" && typeof (job as { name?: unknown }).name === "string") names.push((job as { name: string }).name);
    }
  }
  return names;
}

export function danglingMarkers(items: ChecklistItem[], known: ReadonlySet<string>): ChecklistItem[] {
  return items.filter((i) => i.check !== undefined && !known.has(i.check));
}

export interface StandardsDoctorNote {
  name: "standards";
  status: "warn" | "fail";
  detail: string;
}

/**
 * Doctor: a one-line migration hint when the old files are still in use, then a failure for each
 * dangling `<!-- check: name -->` (not a repo.yaml check and not a pull_request job).
 */
export function standardsDoctorNotes(repoDir: string, checkNames: readonly string[]): StandardsDoctorNote[] {
  const notes: StandardsDoctorNote[] = [];
  const hasStandards = existsSync(join(repoDir, STANDARDS_REL));
  const old = [existsSync(join(repoDir, CHECKLIST_REL)) ? CHECKLIST_REL : undefined, existsSync(join(repoDir, REVIEW_RULES_REL)) ? REVIEW_RULES_REL : undefined].filter((x): x is string => x !== undefined);
  if (!hasStandards && old.length) notes.push({ name: "standards", status: "warn", detail: STANDARDS_DEPRECATION });
  const text = hasStandards ? readFileSync(join(repoDir, STANDARDS_REL), "utf8") : old.includes(CHECKLIST_REL) ? readFileSync(join(repoDir, CHECKLIST_REL), "utf8") : "";
  if (!text) return notes;
  const items = hasStandards ? parseChecklist(splitStandards(text).rules) : parseChecklist(text);
  const known = new Set<string>([...checkNames, ...pullRequestJobNames(repoDir)]);
  const dangling = danglingMarkers(items, known);
  if (dangling.length) {
    const where = hasStandards ? "standards.md" : "checklist.md";
    notes.push({
      name: "standards",
      status: "fail",
      detail: `dangling check marker${dangling.length > 1 ? "s" : ""}: ${dangling.map((i) => `"${i.check}" (${where}:${i.line})`).join(", ")} (not a repo.yaml check or a pull_request job)`,
    });
  }
  return notes;
}
