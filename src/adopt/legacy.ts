import picomatch from "picomatch";
import type { Candidate, Workflow } from "./detect.js";
import { specialJobs } from "./detect.js";

/**
 * Legacy coding setup (Silas decision for M5): the adopt PR deletes what the factory replaces and lists
 * every deleted file in its description. Anything uncertain is only listed as a proposed removal. Paths
 * matched by `--keep` (glob, exact path or directory) are never touched, e.g. `--keep CLAUDE.md
 * --keep .claude` in a repo whose owner keeps Claude Code.
 */

export interface LegacyItem {
  path: string;
  reason: string;
}

export interface LegacyReport {
  removed: LegacyItem[];
  proposed: LegacyItem[];
  kept: LegacyItem[];
}

/** Coding-agent configs the factory replaces: removed. */
const REMOVE: [string, string][] = [
  ["CLAUDE.md", "Claude Code instructions (AGENTS.md is the agent contract)"],
  [".claude/**", "Claude Code config"],
  [".cursorrules", "Cursor rules"],
  [".cursor/rules/**", "Cursor rules"],
  ["**/BUGBOT.md", "Bugbot review rules (.factory/review-rules.md replaces them)"],
  [".cursor/config/bugbot.*", "Bugbot config"],
  [".bugbot/**", "Bugbot config"],
  ["opencode.json", "opencode config"],
  ["opencode.jsonc", "opencode config"],
  [".opencode/opencode.json", "opencode config"],
  [".opencode/opencode.jsonc", "opencode config"],
  [".opencode/{agent,agents,command,commands,mode,modes}/**", "opencode agents/commands"],
  [".grok/config.toml", "grok config"],
  [".grok/{agent,agents,command,commands}/**", "grok agents/commands"],
];

/** Possibly legacy, possibly still used (skills with ops scripts, other assistants): listed only. */
const PROPOSE: [string, string][] = [
  [".opencode/**", "opencode skills/files; check whether anything outside coding still uses them"],
  [".grok/**", "grok skills/files; check whether anything outside coding still uses them"],
  [".cursor/**", "Cursor environment/install files"],
  [".agents/**", "agent skills; check whether anything outside coding still uses them"],
  [".codex/**", "Codex config"],
  [".gemini/**", "Gemini config"],
  ["GEMINI.md", "Gemini instructions"],
  [".aider*", "aider config"],
  [".windsurfrules", "Windsurf rules"],
  [".clinerules", "Cline rules"],
  [".continue/**", "Continue config"],
  [".roo/**", "Roo config"],
  [".github/copilot-instructions.md", "Copilot instructions"],
  [".coderabbit.{yml,yaml}", "CodeRabbit config (the factory reviews)"],
  ["**/CLAUDE.md", "nested Claude Code instructions"],
];

const LEGACY_ACTION = /(claude-code-action|anthropics\/claude|opencode|sst\/opencode|cursor|bugbot|grok|coderabbit|codex|aider)/i;
const LEGACY_TEXT = /\b(opencode|grok|bugbot|cursor|claude code|claude|codex|aider|copilot|coding-run|runner script|worker-run)\b/i;

/** `--keep` entries: a glob, an exact path or a directory (prefix). */
export function keepMatcher(keep: string[]): (path: string) => boolean {
  const globs = keep.map((k) => k.replace(/\/+$/, "")).filter(Boolean);
  const m = globs.length ? picomatch(globs, { dot: true }) : () => false;
  return (p) => m(p) || globs.some((k) => p === k || p.startsWith(`${k}/`));
}

const SETUP_LINE = /^(cd\b|echo\b|export\b|mkdir\b|ls\b|cat\b|corepack\b|pnpm (i|install)\b|npm (ci|i|install)\b|yarn( install)?$|yarn install\b|bun install\b|uv sync\b|uv (pip|venv|python)\b|poetry install\b|pip3? install\b|python3? -m pip install\b|python3? -m venv\b|pipx install\b|curl\b.*install|sudo apt(-get)? (update|install)\b|apt(-get)? (update|install)\b|git config\b|source\b|\.\s)/;
const SAFE_ACTION = /^(actions\/(checkout|setup-[a-z]+|cache|upload-artifact|download-artifact)|pnpm\/action-setup|astral-sh\/setup-uv|oven-sh\/setup-bun|dtolnay\/rust-toolchain|Swatinem\/rust-cache|wntrblm\/nox)@/;

function stripPrefix(cmd: string): string {
  return cmd
    .trim()
    .replace(/^(uv run( --(locked|frozen))*|poetry run|pipenv run|npx|pnpm exec|yarn exec|bunx|python3? -m|\.venv\/bin\/)\s+/, "")
    .replace(/^(pnpm|npm|yarn|bun) (run )?/, "run ")
    .trim();
}

/** Leading command words of a check (`ruff check .` -> ruff check; `nox -s tests` stays whole). */
function checkKey(run: string): string[] {
  const words = stripPrefix(run).split(/\s+/);
  if (words[0] === "nox") return words;
  const key: string[] = [];
  for (const w of words) {
    if (key.length >= 3 || w.startsWith("-") || w.startsWith(".") || w.includes("/")) break;
    key.push(w);
  }
  return key.length ? key : words.slice(0, 1);
}

/** A CI run line counts as covered when it is setup or the same command as a drafted check. */
export function lineCovered(line: string, checks: Pick<Candidate, "run">[], setup: string): boolean {
  const parts = line.split(/\n|&&|;/).map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
  return parts.every((part) => {
    if (SETUP_LINE.test(part) || setup.includes(part)) return true;
    const words = stripPrefix(part).split(/\s+/);
    return checks.some((c) => {
      const key = checkKey(c.run);
      return key.every((w, i) => words[i] === w);
    });
  });
}

/** Legacy workflows and workflows the factory CI stub replaces. */
function classifyWorkflows(workflows: Workflow[], checks: Pick<Candidate, "run">[], setup: string, out: LegacyReport, keep: (p: string) => boolean): void {
  const special = specialJobs(workflows);
  for (const wf of workflows) {
    const item = (reason: string) => ({ path: wf.file, reason });
    const legacyBot = wf.jobs.some((j) => j.uses.some((u) => LEGACY_ACTION.test(u))) || /\b(opencode|bugbot|claude-code|grok) /i.test(wf.jobs.flatMap((j) => j.runs).join("\n"));
    if (legacyBot) {
      (keep(wf.file) ? out.kept : out.removed).push(item("runs a legacy coding/review bot"));
      continue;
    }
    if (!wf.gates_prs) continue; // deploy/release/schedule workflows stay as they are
    const blockers: string[] = [];
    for (const j of wf.jobs) {
      const s = special.find((x) => x.workflow === wf.file && x.job === j.id);
      if (s) blockers.push(`job ${j.id} runs ${s.tool} (carry it over as a check)`);
      else if (j.services.length) blockers.push(`job ${j.id} needs services ${j.services.join(", ")}`);
      else if (j.secrets) blockers.push(`job ${j.id} uses secrets`);
      else if (j.uses.some((u) => !SAFE_ACTION.test(u))) blockers.push(`job ${j.id} uses ${j.uses.filter((u) => !SAFE_ACTION.test(u)).join(", ")}`);
      else {
        const uncovered = j.runs.filter((r) => !lineCovered(r, checks, setup));
        if (uncovered.length) blockers.push(`job ${j.id} runs \`${uncovered[0]!.split("\n")[0]!.slice(0, 80)}\` which no drafted check covers`);
      }
    }
    if (!wf.jobs.length) blockers.push("no jobs parsed");
    if (keep(wf.file)) out.kept.push(item("matched --keep"));
    else if (blockers.length) out.proposed.push(item(`PR/push CI the factory stub may replace; ${blockers.join("; ")}`));
    else out.removed.push(item("PR/push CI fully covered by the drafted checks (the factory CI stub runs them)"));
  }
}

/** `## ` sections of AGENTS.md that talk about legacy tools: proposed (text edits stay human). */
export function legacyAgentsSections(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/^(?=##\s)/m);
  for (const part of parts) {
    const title = /^##\s+(.+)$/m.exec(part)?.[1]?.trim();
    if (title && LEGACY_TEXT.test(part)) out.push(title);
  }
  return out;
}

export function classifyLegacy(input: { files: string[]; workflows: Workflow[]; checks: Pick<Candidate, "run">[]; setup: string; agentsMd?: string; keep: string[] }): LegacyReport {
  const keep = keepMatcher(input.keep);
  const out: LegacyReport = { removed: [], proposed: [], kept: [] };
  const remove = REMOVE.map(([g, r]) => [picomatch(g, { dot: true }), r] as const);
  const propose = PROPOSE.map(([g, r]) => [picomatch(g, { dot: true }), r] as const);
  for (const f of input.files) {
    if (f.startsWith(".github/workflows/")) continue;
    const r = remove.find(([m]) => m(f))?.[1];
    const p = r ? undefined : propose.find(([m]) => m(f))?.[1];
    if (!r && !p) continue;
    if (keep(f)) out.kept.push({ path: f, reason: `${r ?? p} (matched --keep)` });
    else if (r) out.removed.push({ path: f, reason: r });
    else out.proposed.push({ path: f, reason: p! });
  }
  classifyWorkflows(input.workflows, input.checks, input.setup, out, keep);
  if (input.agentsMd && !keep("AGENTS.md")) {
    for (const title of legacyAgentsSections(input.agentsMd)) out.proposed.push({ path: `AGENTS.md § ${title}`, reason: "mentions a legacy coding tool or runner; edit by hand" });
  }
  return out;
}
