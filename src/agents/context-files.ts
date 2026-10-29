import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** File names Pi picks up as context in a directory (its loader's order). */
export const PI_CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
  path: string;
  content: string;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The worktree root of `cwd`: the nearest directory with a `.git` dir or file; `cwd` itself if none. */
export function worktreeRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

/**
 * Context for an agent session: only `AGENTS.md` at the worktree root. Pi's own loader would also
 * read its agent dir (`$FACTORY_HOME/pi`) and every ancestor (`~/.factory`, `~`, `/`), and prefer
 * `AGENTS.override.md`; none of that belongs to the repo at the planned SHA. An override is ignored
 * with a warning.
 */
export function isolatedContextFiles(cwd: string): { files: ContextFile[]; warnings: string[] } {
  const root = worktreeRoot(cwd);
  const warnings: string[] = [];
  if (isFile(join(root, "AGENTS.override.md"))) warnings.push("AGENTS.override.md ignored: the factory reads only AGENTS.md at the worktree root");
  const path = join(root, "AGENTS.md");
  if (!isFile(path)) return { files: [], warnings };
  return { files: [{ path, content: readFileSync(path, "utf8").replace(/^\uFEFF/, "") }], warnings };
}

/** Context files Pi would load from `dir` and its ancestors (stopping at the filesystem root). */
export function ancestorContextFiles(dir: string, opts: { includeSelf?: boolean } = {}): string[] {
  const found: string[] = [];
  let d = resolve(dir);
  if (!opts.includeSelf) d = dirname(d);
  for (;;) {
    for (const n of PI_CONTEXT_NAMES) if (isFile(join(d, n))) found.push(join(d, n));
    const up = dirname(d);
    if (up === d) return found;
    d = up;
  }
}
