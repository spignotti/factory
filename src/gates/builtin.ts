import { matchesAny, type Plan } from "../schemas/plan.js";
import type { Handoff } from "../schemas/handoff.js";
import type { RepoConfig } from "../schemas/repo.js";

export interface BuiltinResult {
  name: string;
  ok: boolean;
  detail: string;
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

export function diffSize(stat: Map<string, number>, max: number): BuiltinResult {
  const total = [...stat.values()].reduce((a, b) => a + b, 0);
  return total > max ? fail("max_diff_lines", `diff has ${total} lines > ${max}`) : ok("max_diff_lines", `${total} lines`);
}

/** Every verify:test criterion of the given packages has evidence naming a changed test file. */
export function testPresence(plan: Plan, packages: string[], handoffs: Handoff[], changed: string[], testGlobs: string[]): BuiltinResult {
  const missing: string[] = [];
  for (const a of plan.acceptance) {
    if (a.verify !== "test" || !packages.includes(a.package)) continue;
    const present = handoffs.some((h) =>
      h.evidence.some((e) => {
        const path = refPath(e.ref);
        return e.acceptance_id === a.id && e.kind === "test" && changed.includes(path) && (testGlobs.length === 0 || matchesAny(path, testGlobs));
      }),
    );
    if (!present) missing.push(a.id);
  }
  return missing.length ? fail("test_presence", `no changed test file as evidence for ${missing.join(", ")}`) : ok("test_presence");
}

/** Every evidence ref exists: test refs in the diff, check refs in repo.yaml. */
export function evidenceCheck(handoffs: Handoff[], changed: string[], checkNames: string[]): BuiltinResult {
  const bad: string[] = [];
  for (const h of handoffs) {
    for (const e of h.evidence) {
      const exists = e.kind === "test" ? changed.includes(refPath(e.ref)) : checkNames.includes(e.ref);
      if (!exists) bad.push(`${e.acceptance_id}:${e.ref}`);
    }
  }
  return bad.length ? fail("evidence", `evidence refs not found: ${bad.join(", ")}`) : ok("evidence");
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
