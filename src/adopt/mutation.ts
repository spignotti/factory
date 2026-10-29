/**
 * `factory adopt`: checks must never change files. A gate that formats or fixes code would slip
 * those edits into every commit, so mutating commands are turned into their read-only variant where
 * that is obvious (`ruff format .` → `ruff format --check .`) and dropped otherwise. Measuring also
 * runs every check in a scratch worktree and drops any that changed tracked files (measure.ts).
 */

/** Session/script names whose purpose is to change files (fix, lock, release …). */
const MUTATING_NAME = /^(?:auto)?fix(?:es)?$|[_:-](?:fix|write)$|^(?:fix|write)[_:-]|^(?:lock|relock|update|upgrade|bump|clean|release|publish|deploy|pre-?commit-update)(?:[_:-].*)?$/i;

export function mutatingName(name: string): boolean {
  return MUTATING_NAME.test(name);
}

export type CommandVerdict = { mutates: false } | { mutates: true; check: string[] | null; why: string };

const has = (argv: string[], ...flags: string[]) => argv.some((a) => flags.includes(a) || flags.some((f) => f.endsWith("=") && a.startsWith(f)));
const without = (argv: string[], ...flags: string[]) => argv.filter((a) => !flags.includes(a));

/** Index of the tool in argv, skipping runners such as `uv run`, `poetry run`, `npx`, `pnpm exec`, `python -m`. */
function toolIndex(argv: string[]): number {
  let i = 0;
  const skip = new Set(["uv", "poetry", "pdm", "hatch", "pipenv", "npx", "pnpx", "bunx", "pnpm", "yarn", "npm", "bun", "python", "python3"]);
  while (i < argv.length) {
    const a = argv[i]!;
    if (skip.has(a.split("/").pop()!)) {
      i++;
      while (i < argv.length && (argv[i]!.startsWith("-") || ["run", "exec", "dlx", "x", "-m"].includes(argv[i]!))) i++;
      continue;
    }
    if (a === "env" || /^\w+=/.test(a)) {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

/** Whether one command (argv) changes files, and its read-only variant when obvious. */
export function analyzeCommand(argv: string[]): CommandVerdict {
  const t = toolIndex(argv);
  if (t < 0) return { mutates: false };
  const pre = argv.slice(0, t);
  const tool = argv[t]!.split("/").pop()!;
  const args = argv.slice(t + 1);
  const mk = (rest: string[]) => [...pre, argv[t]!, ...rest];
  const sub = args[0];
  if (tool === "ruff" && sub === "format" && !has(args, "--check", "--diff")) return { mutates: true, check: mk(["format", "--check", ...args.slice(1)]), why: "ruff format rewrites files" };
  if (tool === "ruff" && has(args, "--fix", "--unsafe-fixes", "--fix-only")) {
    if (has(args, "--fix-only")) return { mutates: true, check: null, why: "ruff --fix-only rewrites files" };
    return { mutates: true, check: mk(without(args, "--fix", "--unsafe-fixes")), why: "ruff --fix rewrites files" };
  }
  if (tool === "black" && !has(args, "--check", "--diff")) return { mutates: true, check: mk(["--check", ...args]), why: "black rewrites files" };
  if (tool === "isort" && !has(args, "--check-only", "--check", "-c", "--diff")) return { mutates: true, check: mk(["--check-only", ...args]), why: "isort rewrites files" };
  if (tool === "prettier" && has(args, "--write", "-w")) return { mutates: true, check: mk(["--check", ...without(args, "--write", "-w", "--check", "-c")]), why: "prettier --write rewrites files" };
  if ((tool === "eslint" || tool === "biome" || tool === "stylelint" || tool === "markdownlint" || tool === "markdownlint-cli2") && has(args, "--fix", "--write", "--apply", "--apply-unsafe")) {
    return { mutates: true, check: mk(without(args, "--fix", "--write", "--apply", "--apply-unsafe")), why: `${tool} --fix rewrites files` };
  }
  if (tool === "cargo" && sub === "fmt" && !has(args, "--check")) return { mutates: true, check: mk([...args, "--check"]), why: "cargo fmt rewrites files" };
  if (tool === "cargo" && sub === "clippy" && has(args, "--fix")) return { mutates: true, check: null, why: "cargo clippy --fix rewrites files" };
  if ((tool === "gofmt" || tool === "goimports") && has(args, "-w")) return { mutates: true, check: mk(["-l", ...without(args, "-w", "-l")]), why: `${tool} -w rewrites files` };
  if (tool === "go" && sub === "fmt") return { mutates: true, check: null, why: "go fmt rewrites files" };
  if (tool === "sed" && has(args, "-i")) return { mutates: true, check: null, why: "sed -i edits files" };
  if (tool === "pre-commit") return { mutates: true, check: null, why: "pre-commit hooks may rewrite files" };
  const lockish: Record<string, string[]> = { uv: ["lock", "sync", "add", "remove"], poetry: ["lock", "update", "add", "remove"], npm: ["install", "update", "i"], pnpm: ["install", "update", "add", "i"], yarn: ["install", "upgrade", "add"], git: ["commit", "push", "add", "checkout", "reset", "tag"] };
  // Runners skipped above are the tool only when used bare (e.g. `uv lock`, `npm install`).
  const bare = argv[0]?.split("/").pop() ?? "";
  if (lockish[bare] && argv[1] && lockish[bare].includes(argv[1])) return { mutates: true, check: null, why: `${bare} ${argv[1]} changes files` };
  return { mutates: false };
}

/** Shell-ish split of a `package.json` script / command line (quotes respected; no expansion). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const SHELL_OPS = /^(?:&&|\|\||;|\|)$/;

/** Splits a command line at `&&`, `||`, `;`, `|` into argv lists. */
export function commandParts(cmd: string): string[][] {
  const parts: string[][] = [[]];
  for (const tok of splitCommand(cmd)) {
    if (SHELL_OPS.test(tok)) parts.push([]);
    else parts.at(-1)!.push(tok);
  }
  return parts.filter((p) => p.length);
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
export const joinArgv = (argv: string[]) => argv.map(quote).join(" ");

/**
 * A whole command line: unchanged when nothing mutates; its read-only variant when every mutating
 * part has an obvious one; null (drop it) otherwise.
 */
export function readOnlyCommand(cmd: string): { run: string; changed: boolean; why: string[] } | null {
  const parts = commandParts(cmd);
  const why: string[] = [];
  let changed = false;
  for (const p of parts) {
    const v = analyzeCommand(p);
    if (!v.mutates) continue;
    why.push(v.why);
    if (!v.check) return null;
    changed = true;
  }
  if (!changed) return { run: cmd, changed: false, why };
  // Rebuild only when we changed something; separators are normalized to `&&` only when the line had no others.
  if (/\|\||;|(?<!\|)\|(?!\|)/.test(cmd)) return null;
  return { run: parts.map((p) => { const v = analyzeCommand(p); return joinArgv(v.mutates && v.check ? v.check : p); }).join(" && "), changed, why };
}

export interface NoxSessionBody {
  name: string;
  /** Positional string arguments of each `session.run(...)` call; null when the body is not plain (helpers, notify, variables). */
  commands: string[][] | null;
  /** `venv_backend="none"`: commands run as written (no nox-managed venv). */
  external: boolean;
}

function balanced(text: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
    else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return undefined;
      i = end;
    }
  }
  return undefined;
}

/** The `session.run(...)` commands of each nox session (for mutation and duplicate detection). */
export function noxSessionBodies(text: string): NoxSessionBody[] {
  const out: NoxSessionBody[] = [];
  const re = /@(?:nox\.)?session\b(\([^)]*\))?\s*(?:@[^\n]*\n\s*)*def\s+(\w+)[^\n]*\n/g;
  const matches = [...text.matchAll(re)];
  matches.forEach((m) => {
    const name = /name\s*=\s*["']([^"']+)["']/.exec(m[1] ?? "")?.[1] ?? m[2]!;
    const start = m.index! + m[0].length;
    // The body ends at the next line starting in column 0 (the next decorator or definition).
    const next = text.slice(start).search(/^\S/m);
    const body = text.slice(start, next < 0 ? text.length : start + next);
    const commands: string[][] = [];
    let plain = true;
    for (const call of body.matchAll(/session\.(\w+)\s*\(/g)) {
      const fn = call[1]!;
      if (fn === "install" || fn === "log" || fn === "skip" || fn === "error" || fn === "warn") continue;
      if (fn !== "run" && fn !== "run_always") {
        plain = false;
        continue;
      }
      const args = balanced(body, call.index! + call[0].length - 1);
      if (args === undefined) {
        plain = false;
        continue;
      }
      const positional: string[] = [];
      for (const a of args.split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/).map((s) => s.trim()).filter(Boolean)) {
        if (/^\w+\s*=/.test(a)) continue; // keyword argument (external=True, env={...})
        const lit = /^["']([^"']*)["']$/.exec(a);
        if (!lit) {
          plain = false;
          break;
        }
        positional.push(lit[1]!);
      }
      if (positional.length) commands.push(positional);
    }
    // Other code than session calls and docstrings/comments (loops, helpers) makes the body opaque.
    const rest = body.replace(/session\.\w+\s*\((?:[^()]|\([^()]*\))*\)/g, "").replace(/("""|''')[\s\S]*?\1/g, "").replace(/#[^\n]*/g, "");
    if (/\b(?:for|if|while|with)\b|\w+\s*\(/.test(rest)) plain = false;
    out.push({ name, commands: plain && commands.length ? commands : null, external: /venv_backend\s*=\s*["']none["']/.test(m[1] ?? "") });
  });
  return out;
}
