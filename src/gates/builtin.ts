import { type DiffEntry, diffTotals, formatDiffTotals } from "../git.js";
import { matchCheckEvidence, matchTestEvidence, type ExecutedTest } from "./evidence.js";
import { isProtected, matchesAny, type Plan } from "../schemas/plan.js";
import type { Handoff } from "../schemas/handoff.js";
import type { RepoConfig } from "../schemas/repo.js";

export interface BuiltinResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Killed for the wall-clock cap. Recorded as `timeout`, not a failing check. */
  timedOut?: boolean;
}

const ok = (name: string, detail = ""): BuiltinResult => ({ name, ok: true, detail });
const fail = (name: string, detail: string): BuiltinResult => ({ name, ok: false, detail });

/** Evidence refs are `path` or `path::test name`. */
export function refPath(ref: string): string {
  return ref.split("::")[0]!.trim();
}

export function forbiddenPaths(changed: string[], globs: string[]): BuiltinResult {
  const hits = changed.filter((f) => matchesAny(f, globs));
  return hits.length ? fail("forbidden_paths", `forbidden paths touched: ${hits.join(", ")}`) : ok("forbidden_paths");
}

/** Changed `human_only_paths` files: only the plan's declared `protected_changes` may change. */
export function protectedFiles(changed: string[], humanOnly: string[]): string[] {
  return changed.filter((f) => isProtected(f, humanOnly));
}

export function protectedPaths(plan: Plan, changed: string[], humanOnly: string[]): BuiltinResult {
  const declared = new Set(plan.protected_changes.map((c) => c.file));
  const bad = protectedFiles(changed, humanOnly).filter((f) => !declared.has(f));
  return bad.length
    ? fail("protected_paths", `human_only_paths changed without a protected_changes entry in the plan (revert them): ${bad.join(", ")}`)
    : ok("protected_paths", declared.size ? `declared: ${[...declared].join(", ")}` : "");
}

/**
 * Counted lines only: lockfiles, binaries and `limits.diff_exclude` are named in the detail, not counted.
 * With `countTests: false`, test-file lines are named too and do not count toward `max`.
 */
export function diffSize(stat: Map<string, DiffEntry>, max: number, opts?: { countTests?: boolean }): BuiltinResult {
  const t = diffTotals(stat);
  const detail = formatDiffTotals(t, opts);
  return t.counted > max ? fail("max_diff_lines", `diff has ${detail} > ${max}`) : ok("max_diff_lines", detail);
}

export interface EvidenceInputs {
  /** Paths present in the worktree. The cited file does not have to be in the diff. */
  files: readonly string[];
  /** Tests `tests.run` actually executed for the cited files. */
  executed: readonly ExecutedTest[];
  /** Check names from repo.yaml. */
  knownChecks: readonly string[];
  /** Checks selected for this gate tier and their result. A check that did not run is absent. */
  ranChecks: readonly { name: string; status: string }[];
}

/**
 * Every verify:test criterion has evidence for a test that exists, was selected, and passed.
 * An unchanged test counts. A review criterion (documentation, a non-goal) does not need one.
 */
export function testPresence(plan: Plan, packages: string[], handoffs: Handoff[], evidence: EvidenceInputs): BuiltinResult {
  const files = new Set(evidence.files);
  const missing: string[] = [];
  for (const a of plan.acceptance) {
    if (a.verify !== "test" || !packages.includes(a.package)) continue;
    const matches = handoffs.flatMap((h) => h.evidence.filter((e) => e.acceptance_id === a.id && e.kind === "test"));
    const hit = matches
      .map((e) => matchTestEvidence(e.ref, evidence.executed, files.has(refPath(e.ref))))
      .find((m) => m.ok);
    if (hit) continue;
    const reason = matches.length
      ? matchTestEvidence(matches[0]!.ref, evidence.executed, files.has(refPath(matches[0]!.ref))).reason
      : "no test evidence";
    missing.push(`${a.id} (${reason})`);
  }
  return missing.length ? fail("test_presence", `no executed test evidence for ${missing.join("; ")}`) : ok("test_presence");
}

/**
 * Every evidence ref matches a real run: a test that exists and passed in the cited scope,
 * or a known check that was selected and passed. Invented refs and skipped tests do not.
 */
export function evidenceCheck(handoffs: Handoff[], evidence: EvidenceInputs): BuiltinResult {
  const files = new Set(evidence.files);
  const bad: string[] = [];
  for (const h of handoffs) {
    for (const e of h.evidence) {
      const match =
        e.kind === "test"
          ? matchTestEvidence(e.ref, evidence.executed, files.has(refPath(e.ref)))
          : matchCheckEvidence(e.ref, evidence.knownChecks, evidence.ranChecks);
      if (!match.ok) bad.push(`${e.acceptance_id}:${e.ref} (${match.reason})`);
    }
  }
  return bad.length ? fail("evidence", `evidence refs not accepted: ${bad.join("; ")}`) : ok("evidence");
}

/** Packages with `changes_flows` must touch the area's guide and/or flows. */
export function guideUpdate(plan: Plan, packages: string[], changed: string[], repo: RepoConfig): BuiltinResult {
  const missing: string[] = [];
  for (const p of plan.packages) {
    if (!packages.includes(p.id)) continue;
    for (const name of p.changes_flows) {
      const area = repo.verify.areas.find((a) => a.name === name);
      const targets = [area?.guide, ...(area?.flows ?? [])].filter((x): x is string => !!x);
      if (!targets.some((t) => changed.includes(t))) missing.push(`${p.id}:${name}`);
    }
  }
  return missing.length ? fail("guide_update", `verify guide/flows not updated for ${missing.join(", ")}`) : ok("guide_update");
}

/** Files changed outside the plan's `files`; informational for the plan reviewer, never a failure. */
export function scopeReport(plan: Plan, changed: string[]): string[] {
  const planned = plan.packages.flatMap((p) => p.files);
  return changed.filter((f) => !planned.includes(f) && !matchesAny(f, planned));
}

/** Repro test files of a bug plan: evidence of `kind: repro` criteria. */
export function reproFiles(plan: Plan, handoffs: Handoff[]): string[] {
  const reproIds = new Set(plan.acceptance.filter((a) => a.kind === "repro").map((a) => a.id));
  const files = handoffs.flatMap((h) => h.evidence.filter((e) => reproIds.has(e.acceptance_id) && e.kind === "test").map((e) => refPath(e.ref)));
  return [...new Set(files)];
}
