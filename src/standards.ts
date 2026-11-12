import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { type ChecklistItem, parseChecklist, unmarkedItems } from "./checklist.js";
import { matchesAny } from "./schemas/plan.js";
import { parseRepoConfig, type Check } from "./schemas/repo.js";

/**
 * `.factory/standards.md`: repo rules are the list items in every section except `## Severity`
 * and the legacy `## Review rules`. A `<!-- check: name -->` marker hides a rule from review only
 * when that check exists, blocks, runs on a path the rule names (or has no path filter), and can
 * fail. A workflow job name does not. When `standards.md` is missing, readers fall back to
 * `checklist.md` and `review-rules.md`. Once `standards.md` exists those old files are ignored.
 */

export const STANDARDS_REL = ".factory/standards.md";
export const CHECKLIST_REL = ".factory/checklist.md";
export const REVIEW_RULES_REL = ".factory/review-rules.md";

/** One line, shared by the read path and `factory doctor --repo`. */
export const STANDARDS_DEPRECATION =
  ".factory/standards.md is missing; .factory/checklist.md and .factory/review-rules.md are deprecated. Run: factory standards migrate --repo <path>";

/** Doctor warning: `standards.md` wins, so a leftover old file is dead config. */
export function standardsOldIgnored(paths: readonly string[]): string {
  const listed = paths.join(" and ");
  const verb = paths.length > 1 ? "are" : "is";
  const them = paths.length > 1 ? "them" : "it";
  return `${STANDARDS_REL} is in use; ${listed} ${verb} ignored. Delete ${them}.`;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const EXCLUDED_SECTION = /^(severity|review rules)\b/i;

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

/**
 * Rules are list items in every section except `## Severity` and `## Review rules`.
 * A section runs until the next heading of the same or higher level, so a subsection stays inside it.
 * Line numbers in `rules` match the file: excluded lines are blanked, not dropped, so a rule
 * appended under `## Rules` stays visible.
 */
export function splitStandards(text: string): { rules: string; severity?: string } {
  const lines = text.split("\n");
  let excludedLevel: number | undefined;
  const rules: string[] = [];
  const severity: string[] = [];
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.replace(/\s+#*\s*$/, "").trim();
      if (excludedLevel !== undefined && level <= excludedLevel) excludedLevel = undefined;
      if (excludedLevel === undefined && EXCLUDED_SECTION.test(title)) excludedLevel = level;
    }
    if (excludedLevel !== undefined) {
      if (!heading) severity.push(line);
      rules.push("");
    } else {
      rules.push(line);
    }
  }
  const severityText = severity.join("\n").trim();
  return severityText ? { rules: rules.join("\n"), severity: severityText } : { rules: rules.join("\n") };
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
/** Static check metadata: useful for diagnosis, never semantic enforcement proof. */
export type MarkerCheck = Pick<Check, "name" | "run" | "tier" | "paths" | "local_only">;

const CONSTANT_RUN = /^(?:true|false|:|exit\s+\d+)$/;

function commandCanDetect(run: string): boolean {
  const text = run.trim();
  return text.length > 0 && !CONSTANT_RUN.test(text);
}

function pathsMentioned(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s`'"(])((?:[\w.@+-]+\/)+[\w.@+-]+)/g)].map((m) => m[1]!);
}

/**
 * True when `check:` names a fast or full check that is not local-only, has a command, and is not
 * scoped away from a path the rule states. A missing check, a manual check, a constant command,
 * or a pull_request job id does not cover the rule.
 */
export function markerHasCheck(item: { text: string; check?: string }, checks: readonly MarkerCheck[]): boolean {
  if (!item.check) return false;
  const check = checks.find((c) => c.name === item.check);
  if (!check || check.tier === "manual" || check.local_only || !commandCanDetect(check.run)) return false;
  if (check.paths && check.paths.length > 0) {
    const mentioned = pathsMentioned(item.text);
    if (mentioned.length === 0 || !mentioned.some((path) => matchesAny(path, check.paths!))) return false;
  }
  return true;
}

/** Rules the standards reviewer still has to judge. */
export function rulesForReview(items: readonly ChecklistItem[]): ChecklistItem[] {
  // A static command/path match cannot establish semantic enforcement. Keep the statement and
  // its marker visible so the reviewer can inspect the check's real behavior, not just its name.
  return [...items];
}

/**
 * Static configuration can establish only a candidate check, not full semantic coverage.
 * All standards stay in review scope. This is not a check-count quotient.
 */
export function automationCoverage(items: readonly ChecklistItem[], checks: readonly MarkerCheck[]): { full: string[]; partial: string[]; review_scope: string[] } {
  const full: string[] = [];
  const partial: string[] = [];
  const review_scope: string[] = [];
  for (const item of items) {
    review_scope.push(item.text);
    if (markerHasCheck(item, checks)) partial.push(item.text);
  }
  return { full, partial, review_scope };
}

/** Null when the repo has no standards file. That is unknown coverage, not zero rules. */
export function coverageOfRepo(repoDir: string): { full: string[]; partial: string[]; review_scope: string[] } | null {
  const checks = repoChecks(repoDir);
  const standards = readOptionalFile(join(repoDir, STANDARDS_REL));
  const text = standards !== undefined ? splitStandards(standards).rules : readOptionalFile(join(repoDir, CHECKLIST_REL));
  if (text === undefined) return null;
  return automationCoverage(parseChecklist(text), checks);
}

function repoChecks(repoDir: string): MarkerCheck[] {
  const text = readOptionalFile(join(repoDir, ".factory", "repo.yaml"));
  if (text === undefined) return [];
  try {
    return parseRepoConfig(text).checks;
  } catch {
    return [];
  }
}

export function unmarkedStandardRules(repoDir: string): string[] {
  const standards = readOptionalFile(join(repoDir, STANDARDS_REL));
  if (standards !== undefined) return rulesForReview(parseChecklist(splitStandards(standards).rules)).map((i) => i.text);
  const checklist = readOptionalFile(join(repoDir, CHECKLIST_REL));
  return checklist === undefined ? [] : rulesForReview(parseChecklist(checklist)).map((i) => i.text);
}

function stripTitle(text: string): string {
  return text.replace(/^\uFEFF?/, "").replace(/^#[ \t]+[^\n]*\n+/, "");
}

/**
 * `standards.md` body from the old files. Undefined when both are missing. Does not delete them.
 * Severity comes first and `## Rules` last, so a line appended at the end is a rule.
 * A leading H1 is dropped. Headings inside the old review rules are demoted so they stay
 * inside `## Severity` instead of becoming rule sections.
 */
export function migrateStandards(input: { checklist?: string; reviewRules?: string }): string | undefined {
  if (input.checklist === undefined && input.reviewRules === undefined) return undefined;
  const rules = input.checklist !== undefined ? stripTitle(input.checklist).trim() : "";
  const severity = input.reviewRules !== undefined ? demoteHeadings(stripTitle(input.reviewRules).trim()) : "";
  const parts = ["# Standards", ""];
  if (severity) parts.push("## Severity", "", severity, "");
  parts.push("## Rules");
  if (rules) parts.push("", rules);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function demoteHeadings(text: string): string {
  return text
    .split("\n")
    .map((l) => (/^#{1,6}[ \t]/.test(l) ? `#${l}` : l))
    .join("\n");
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

/** Plan fields the declaration check may see. `context` and `out_of_scope` are accepted and ignored. */
export interface StandardsDeclarationPlan {
  goal?: string;
  context?: string;
  packages?: readonly { title?: string; description?: string; files?: readonly string[] }[];
  acceptance?: readonly { text?: string }[];
  protected_changes?: readonly { change?: string; reason?: string }[];
  out_of_scope?: readonly string[];
}

function declarationText(plan: StandardsDeclarationPlan): string {
  return [
    plan.goal ?? "",
    ...(plan.packages ?? []).flatMap((p) => [p.title ?? "", p.description ?? ""]),
    ...(plan.acceptance ?? []).map((a) => a.text ?? ""),
    ...(plan.protected_changes ?? []).flatMap((c) => [c.change ?? "", c.reason ?? ""]),
  ].join("\n");
}

/** Whole identifier, not `\b`: a hyphen is a `\b` boundary, so `unit` would match inside `unit-test`. */
export function namesCheck(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i").test(text);
}

/**
 * A removed rule or marker is declared only when a package lists `.factory/standards.md` and the
 * rule text, or the check name as a whole word, appears in the goal, a package title or description,
 * an acceptance criterion, or protected_changes. Not in `out_of_scope` or context.
 */
export function standardsRemovalDeclared(plan: StandardsDeclarationPlan, r: StandardsRemoval): boolean {
  const files = (plan.packages ?? []).flatMap((p) => p.files ?? []);
  if (!files.includes(STANDARDS_REL)) return false;
  const text = declarationText(plan);
  if (r.kind === "rule") {
    const rule = r.text.trim();
    return rule !== "" && text.toLowerCase().includes(rule.toLowerCase());
  }
  const name = (r.check ?? "").trim();
  return name !== "" && namesCheck(text, name);
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
 * Doctor: a migration hint when the old files are still the source, or a warning to delete them
 * when `standards.md` already exists (they are ignored). Then a failure for each marker that does
 * not name a blocking check covering that rule. A workflow job id is not enough.
 */
export function standardsDoctorNotes(repoDir: string, checks: readonly MarkerCheck[]): StandardsDoctorNote[] {
  const notes: StandardsDoctorNote[] = [];
  const hasStandards = existsSync(join(repoDir, STANDARDS_REL));
  const old = [existsSync(join(repoDir, CHECKLIST_REL)) ? CHECKLIST_REL : undefined, existsSync(join(repoDir, REVIEW_RULES_REL)) ? REVIEW_RULES_REL : undefined].filter((x): x is string => x !== undefined);
  if (!hasStandards && old.length) notes.push({ name: "standards", status: "warn", detail: STANDARDS_DEPRECATION });
  if (hasStandards && old.length) notes.push({ name: "standards", status: "warn", detail: standardsOldIgnored(old) });
  const text = hasStandards ? readFileSync(join(repoDir, STANDARDS_REL), "utf8") : old.includes(CHECKLIST_REL) ? readFileSync(join(repoDir, CHECKLIST_REL), "utf8") : "";
  if (!text) return notes;
  const items = hasStandards ? parseChecklist(splitStandards(text).rules) : parseChecklist(text);
  const dangling = items.filter((item) => item.check !== undefined && !markerHasCheck(item, checks));
  if (dangling.length) {
    const where = hasStandards ? "standards.md" : "checklist.md";
    notes.push({
      name: "standards",
      status: "fail",
      detail: `dangling check marker${dangling.length > 1 ? "s" : ""}: ${dangling.map((i) => `"${i.check}" (${where}:${i.line})`).join(", ")} (not a blocking check on the relevant path)`,
    });
  }
  return notes;
}
