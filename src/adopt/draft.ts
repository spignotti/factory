import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { MIGRATION_GLOBS } from "../paths.js";
import { type Check, parseRepoConfig, type RepoConfig } from "../schemas/repo.js";
import type { Candidate, Detection } from "./detect.js";
import { lineCovered } from "./legacy.js";
import type { MeasureResult } from "./measure.js";

/** Measured duration above which a check is proposed as `full` instead of `fast`. */
export const SLOW_CHECK_SECONDS = 120;

export const DEFAULT_HUMAN_ONLY = [".factory/**", ".github/workflows/**"];

export interface DraftCheck extends Check {
  /** Why the tier differs from `fast` (written as a YAML comment). */
  note?: string;
  seconds: number | null;
}

/** CI jobs that run this check (to inherit services/secrets). */
function ciJobsFor(c: Candidate, d: Detection) {
  return d.workflows.flatMap((w) => w.jobs.filter((j) => j.runs.some((r) => lineCovered(r, [c], "") && !lineCovered(r, [], d.setup))));
}

/**
 * Candidates that changed tracked files when measured: never drafted as checks (they would slip
 * edits into every commit). Moved to `d.skipped` so the adopt PR lists them.
 */
export function dropMutating(d: Detection, m: MeasureResult | null): void {
  for (const c of d.candidates) {
    const files = m?.checks.find((x) => x.name === c.name)?.mutated;
    if (files?.length) d.skipped.push({ name: c.name, run: c.run, source: c.source, reason: `changed files when measured (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""})` });
  }
}

/** Proposed tiers (SPEC §12 step 2): DB → full, cloud/secrets → manual, failing → manual, slow → full. */
export function draftChecks(d: Detection, m: MeasureResult | null): DraftCheck[] {
  return d.candidates.filter((c) => !m?.checks.find((x) => x.name === c.name)?.mutated?.length).map((c) => {
    const measured = m?.checks.find((x) => x.name === c.name);
    const jobs = ciJobsFor(c, d);
    const base: DraftCheck = { name: c.name, run: c.run, tier: "fast", seconds: measured?.seconds ?? null };
    if (jobs.some((j) => j.secrets)) return { ...base, tier: "manual", note: "its CI job uses secrets; needs credentials the factory does not have" };
    if (measured && measured.ok === false) return { ...base, tier: "manual", note: `failed on the base branch at adopt (${measured.seconds}s); fix it, then make it fast/full` };
    if (jobs.some((j) => j.services.length)) return { ...base, tier: "full", note: `its CI job needs ${jobs.flatMap((j) => j.services).join(", ")}; add a service (baseline plan)` };
    if (c.kind === "e2e" || c.kind === "build") return { ...base, tier: "full", note: `${c.kind} check` };
    if (measured?.seconds != null && measured.seconds > SLOW_CHECK_SECONDS) return { ...base, tier: "full", note: `took ${measured.seconds}s at adopt (> ${SLOW_CHECK_SECONDS}s)` };
    return base;
  });
}

export interface DraftInput {
  detection: Detection;
  checks: DraftCheck[];
  baseBranch: string;
  date: string;
}

/** `.factory/repo.yaml` text (validated by `parseRepoConfig`); notes become comments. */
export function draftRepoYaml(input: DraftInput): { text: string; config: RepoConfig } {
  const d = input.detection;
  const doc: Record<string, unknown> = {
    base_branch: input.baseBranch,
    setup: d.setup,
    checks: input.checks.map((c) => ({ name: c.name, run: c.run, tier: c.tier })),
    tests: d.tests.run ? { globs: d.tests.globs, run: d.tests.run } : { globs: d.tests.globs },
    sensitive_paths: d.db.present ? MIGRATION_GLOBS : [],
    human_only_paths: DEFAULT_HUMAN_ONLY,
    merge: { auto_merge_max_risk: "none" },
  };
  let body = stringify(doc, { lineWidth: 0 });
  for (const c of input.checks) {
    const line = `  - name: ${stringify(c.name).trim()}\n`;
    const seconds = c.seconds != null ? `${c.seconds}s at adopt` : "not measured";
    const comment = `  # ${c.note ? `${c.tier}: ${c.note}; ` : ""}${seconds}\n`;
    body = body.replace(line, comment + line);
  }
  const header = [
    `# Drafted by \`factory adopt\` on ${input.date}. Review before merging; SPEC §5.1 documents every field.`,
    `# Detected: ${d.stacks.join(", ") || "no known stack"}${d.ui.present ? `; UI (${d.ui.reasons.join(", ")})` : ""}${d.db.present ? `; DB (${d.db.reasons.join(", ")})` : ""}.`,
    "# paths: per check, services and ui are left to the baseline plan (proposals/<date>-adopt.plan.json).",
    "",
  ].join("\n");
  const text = header + body;
  return { text, config: parseRepoConfig(text) };
}

/** 3–5 lines of repo facts for AGENTS.md (§12 step 3), from what adopt knows. */
export function testStrategySection(d: Detection, checks: DraftCheck[]): string {
  const tier = (t: string) => checks.filter((c) => c.tier === t).map((c) => `\`${c.name}\``).join(", ");
  const lines = [
    `- Checks (\`.factory/repo.yaml\`): fast ${tier("fast") || "none"}; full ${tier("full") || "none"}; manual ${tier("manual") || "none"}. Run one with \`factory gates --run <name>\`.`,
    `- Tests live in ${d.tests.globs.length ? d.tests.globs.map((g) => `\`${g}\``).join(", ") : "(no test files found yet)"}${d.tests.run ? `; run specific files with \`${d.tests.run}\`` : ""}.`,
    d.db.present ? `- Database: ${d.db.reasons.join("; ")}. Tests that need it run in the full tier.` : "",
    checks.some((c) => c.name === "e2e" || /e2e|playwright/.test(c.run)) ? `- E2E: \`${checks.find((c) => c.name === "e2e" || /e2e|playwright/.test(c.run))!.run}\`.` : d.ui.present ? "- E2E: none yet (the baseline plan proposes the setup)." : "",
    "- Fixtures/seeds: TODO (describe where test data comes from).",
  ].filter(Boolean);
  return `## Test strategy\n\n${lines.join("\n")}\n`;
}

/** Appends the section unless AGENTS.md already has a `Test strategy` heading. */
export function withTestStrategy(agentsMd: string | undefined, section: string): string | undefined {
  if (agentsMd !== undefined && /^#{1,6}\s+test strategy\b/im.test(agentsMd)) return undefined;
  if (agentsMd === undefined) return `# AGENTS.md\n\n${section}`;
  return `${agentsMd.trimEnd()}\n\n${section}`;
}

/** Project description from package.json / pyproject.toml / Cargo.toml, else the README's first paragraph. */
export function projectPurpose(dir: string): string | undefined {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  try {
    const pkg = read("package.json");
    const desc = pkg ? (JSON.parse(pkg) as { description?: unknown }).description : undefined;
    if (typeof desc === "string" && desc.trim()) return desc.trim();
  } catch {
    // not JSON: fall through
  }
  for (const f of ["pyproject.toml", "Cargo.toml"]) {
    const m = /^description\s*=\s*["'](.+?)["']\s*$/m.exec(read(f) ?? "");
    if (m?.[1]?.trim()) return m[1].trim();
  }
  const readme = read("README.md");
  if (!readme) return undefined;
  const para = readme
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|!\[|\[!\[|<|```|[-*|>])/.test(p));
  return para && para.length <= 400 ? para.replace(/\s+/g, " ") : undefined;
}

/**
 * AGENTS.md for a repo that has none: the factory's sections with what adopt detected filled in and
 * TODOs where only a human knows. `extra` (e.g. a CLAUDE.md being replaced) is kept as its own section.
 */
export function agentsTemplate(input: { detection: Detection; checks: DraftCheck[]; purpose?: string; topDirs: string[]; extra?: { from: string; text: string } }): string {
  const d = input.detection;
  const stack = [
    `- Stack: ${d.stacks.join(", ") || "TODO"}${d.package_manager ? ` (${d.package_manager})` : d.python?.runner ? ` (${d.python.runner})` : ""}.`,
    d.setup ? `- Setup: \`${d.setup}\`.` : "- Setup: TODO.",
    ...input.checks.map((c) => `- ${c.name}: \`${c.run}\``),
  ];
  const testing = testStrategySection(d, input.checks).replace(/^## Test strategy\n\n/, "").trimEnd();
  const dirs = input.topDirs.length ? `- Top-level directories: ${input.topDirs.map((x) => `\`${x}/\``).join(", ")}.` : "";
  const data = [
    d.db.present ? `- Database: ${d.db.reasons.join("; ")}.` : "",
    "- No secrets or real customer data in code, tests, fixtures, logs or prompts; test data is synthetic.",
    "- TODO: where secrets live and how commands that need them are run.",
  ].filter(Boolean);
  const fast = input.checks.filter((c) => c.tier === "fast").map((c) => `\`${c.name}\``);
  const verify = [
    `- Before calling a change done: ${fast.length ? `the fast checks (${fast.join(", ")}) pass` : "the checks in `.factory/repo.yaml` pass"}; \`factory gates --run selected\` runs the ones the diff needs.`,
    d.ui.present ? "- UI changes: check the changed screens in a browser, including empty, error and loading states." : "",
    "- New behavior has a test at the level a user would notice it.",
  ].filter(Boolean);
  const sections: [string, string[]][] = [
    ["Purpose", [input.purpose ?? "TODO: what this repository is for and who uses it, in two sentences."]],
    ["Stack & commands", stack],
    ["Test strategy", [testing]],
    ["Architecture", [dirs, "- TODO: main modules, how a request or job flows through them, boundaries that must hold."].filter(Boolean)],
    ["Conventions", ["- TODO: naming, error handling, logging, and anything a reviewer keeps pointing out."]],
    ["Domain knowledge", ["- TODO: terms, invariants and business rules an agent cannot read from the code."]],
    ["Data & secrets", data],
    ["Do not", ["- Do not edit `.factory/` or `.github/workflows/` (human-only).", "- TODO: commands never to run, paths never to touch."]],
    ["Verify", verify],
  ];
  const out = ["# AGENTS.md", "", "Rules for coding agents in this repository. Keep it short; the code and README are the documentation.", ""];
  for (const [title, lines] of sections) out.push(`## ${title}`, "", ...lines, "");
  if (input.extra?.text.trim()) {
    const body = input.extra.text.replace(/\r\n/g, "\n").replace(/^#\s.*\n+/, "").replace(/^(#{2,5})\s/gm, "#$1 ").trim();
    out.push(`## Migrated from ${input.extra.from}`, "", "TODO: move these into the sections above, then delete this section.", "", body, "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
