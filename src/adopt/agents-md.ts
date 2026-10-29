/**
 * AGENTS.md trimming for `factory adopt`. Rules in tool-named sections ("Cursor Cloud specific
 * instructions", "Claude Code") are repo rules that happen to sit under a tool's heading: never-run
 * commands, protected paths, test commands. They move into "Do not" / "Stack & commands". Only
 * sections about workflow the factory owns (Git, PRs, review, models) are proposed for removal; the
 * text edit stays human. Also warns about rules stated twice and a CLAUDE.md that says more than
 * AGENTS.md.
 */

/** Tool names in a heading. `cursor` only as the product (not a database cursor) in prose is moot here. */
const TOOL_TITLE = /\b(opencode|grok|bugbot|cursor|claude(?: code)?|codex|aider|copilot|gemini|windsurf|cline|roo|continue\.dev)\b/i;
const WORKFLOW_TITLE = /^(git|github flow|workflows?|pull requests?|prs?|code reviews?|reviews?|models?|branch(?:es|ing)?|commits?|merging)\b|\b(git|pull requests?|code review|model (?:selection|routing|choice)|branching|commit messages?|(?:coding|development|dev|agent|git|pr|review) workflows?)\b/i;
const WORKFLOW_ITEM = /\b(git|commits?|push(?:es|ing)?|branch(?:es)?|pull requests?|PRs?|merge|squash|rebase|reviews?|reviewers?|models?)\b/;
const DO_NOT_ITEM = /\b(never|do not|don't|must not|mustn't|avoid|forbidden|protected|read-only|no (?:edits?|changes?))\b/i;
const COMMAND_ITEM = /`[^`]*\b(nox|pytest|uv|poetry|pnpm|npm|yarn|bun|npx|make|cargo|go|tsc|ruff|mypy|vitest|jest|playwright|docker|just|task|test\w*|lint\w*|typecheck)\b[^`]*`/;
const DO_NOT_TITLE = /^(do not|don'?ts?|never|forbidden)\b/i;
const COMMANDS_TITLE = /\b(stack|commands?|setup|development|dev)\b/i;

interface Section {
  /** `null` for the text before the first `## ` heading. */
  title: string | null;
  head: string;
  items: string[];
  /** Original text (heading included); used as is unless the section changed. */
  raw: string[];
  dirty?: boolean;
}

function parse(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { title: null, head: "", items: [], raw: [] };
  let item: string[] | null = null;
  const flush = () => {
    if (item) cur.items.push(item.join("\n"));
    item = null;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push(cur);
      cur = { title: h[1]!, head: line, items: [], raw: [line] };
      continue;
    }
    cur.raw.push(line);
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    // A new list item or a non-indented line after a blank starts an item; indented lines continue it.
    if (LIST_ITEM.test(line) || !item) {
      flush();
      item = [line];
    } else item.push(line);
  }
  flush();
  out.push(cur);
  return out;
}

const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s/;

function render(sections: Section[]): string {
  const parts = sections.map((s) => {
    if (!s.dirty) return s.raw.join("\n").trim();
    const tight = s.items.every((i) => LIST_ITEM.test(i));
    return `${s.head}\n\n${s.items.join(tight ? "\n" : "\n\n")}`.trim();
  });
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

/** Comparable form of a rule: lower case, no list marker, single spaces, no trailing punctuation. */
export function normalizeRule(item: string): string {
  return item
    .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,]+$/, "")
    .toLowerCase();
}

/** A rule-like item: list items and sentences, not headings, code fences or one-word lines. */
function ruleLike(item: string): boolean {
  return !/^\s*(#|```|<!--|>)/.test(item) && normalizeRule(item).split(" ").length >= 3;
}

export interface AgentsTrim {
  /** AGENTS.md after moving rules; equal to the input when nothing moved. */
  text: string;
  moved: { from: string; to: string; rule: string }[];
  /** Sections proposed for removal, with the reason. */
  proposed: { title: string; reason: string }[];
  warnings: string[];
}

function target(sections: Section[], titleRe: RegExp, title: string): Section {
  const found = sections.find((s) => s.title !== null && titleRe.test(s.title));
  if (found) return found;
  const created: Section = { title, head: `## ${title}`, items: [], raw: [] };
  sections.push(created);
  return created;
}

export function trimAgentsMd(text: string): AgentsTrim {
  const sections = parse(text);
  const moved: AgentsTrim["moved"] = [];
  const proposed: AgentsTrim["proposed"] = [];
  for (const s of [...sections]) {
    if (s.title === null) continue;
    const tool = TOOL_TITLE.test(s.title);
    const workflow = WORKFLOW_TITLE.test(s.title);
    if (workflow) {
      proposed.push({ title: s.title, reason: "workflow the factory owns (branches, commits, PRs, review, models); keep only repo rules from it" });
      continue;
    }
    if (!tool) continue;
    const keep: string[] = [];
    for (const item of s.items) {
      const to = WORKFLOW_ITEM.test(item) ? undefined : DO_NOT_ITEM.test(item) ? "do" : COMMAND_ITEM.test(item) ? "cmd" : undefined;
      if (!to) {
        keep.push(item);
        continue;
      }
      const t = to === "do" ? target(sections, DO_NOT_TITLE, "Do not") : target(sections, COMMANDS_TITLE, "Stack & commands");
      t.items.push(item);
      t.dirty = true;
      s.dirty = true;
      moved.push({ from: s.title, to: t.title!, rule: normalizeRule(item) });
    }
    s.items = keep;
    if (!keep.length) sections.splice(sections.indexOf(s), 1);
    else proposed.push({ title: s.title, reason: `tool-specific section${moved.some((m) => m.from === s.title) ? " (its repo rules were moved to the sections named in the PR)" : ""}; remove what only concerns that tool` });
  }
  const out = moved.length ? render(sections) : text;
  return { text: out, moved, proposed, warnings: duplicateRules(out) };
}

/** Rules stated more than once in AGENTS.md (same text after normalizing). */
export function duplicateRules(text: string): string[] {
  const seen = new Map<string, string[]>();
  for (const s of parse(text)) {
    for (const item of s.items) {
      if (!ruleLike(item)) continue;
      const k = normalizeRule(item);
      seen.set(k, [...(seen.get(k) ?? []), s.title ?? "(top)"]);
    }
  }
  return [...seen].filter(([, where]) => where.length > 1).map(([rule, where]) => `AGENTS.md states a rule ${where.length}× (${where.join(", ")}): "${rule.slice(0, 100)}"`);
}

/**
 * A CLAUDE.md next to AGENTS.md is stale when it holds rules AGENTS.md lacks (adopt removes it; the
 * rules would be lost). A pointer file (`@AGENTS.md`, "see AGENTS.md") is fine.
 */
export function staleClaudeMd(claude: string, agents: string | undefined): string | undefined {
  const items = parse(claude).flatMap((s) => s.items).filter(ruleLike);
  if (/^\s*@?AGENTS\.md\s*$/m.test(claude) && items.length <= 2) return undefined;
  const known = new Set(agents ? parse(agents).flatMap((s) => s.items).map(normalizeRule) : []);
  const missing = items.filter((i) => !known.has(normalizeRule(i)));
  if (!missing.length) return undefined;
  return `CLAUDE.md has ${missing.length} rule(s) AGENTS.md lacks and is removed by this PR; merge them into AGENTS.md first, e.g. "${normalizeRule(missing[0]!).slice(0, 100)}"`;
}
