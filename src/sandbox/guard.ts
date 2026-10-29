import { constants } from "node:fs";
import { access, glob, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathDenied extends Error {
  constructor(path: string, why: string) {
    super(`path denied (${why}): ${path}`);
    this.name = "PathDenied";
  }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** Realpath of `p`, or of its nearest existing ancestor joined with the rest (for new files). */
async function resolveReal(p: string): Promise<string> {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch (e) {
      // A dangling symlink must not be followed later by a write.
      const st = await lstat(cur).catch(() => undefined);
      if (st?.isSymbolicLink()) throw new PathDenied(p, "dangling symlink");
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length).replace(/^\//, ""));
      cur = parent;
    }
  }
}

/**
 * Confines Pi's in-process tools (read, write, edit, grep, find, ls) to the worktree, symlinks resolved.
 * Writes into any `.git` (worktree link file, submodule git dirs) are denied. Residual risk: a symlink
 * swapped in between the check and the use (TOCTOU) by a concurrent agent bash process.
 */
export class PathGuard {
  private readonly roots: Promise<string[]>;

  constructor(roots: string[]) {
    this.roots = Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))));
  }

  private async check(path: string, write: boolean): Promise<string> {
    if (!isAbsolute(path)) throw new PathDenied(path, "not absolute");
    const lexical = resolve(path);
    const real = await resolveReal(lexical);
    const roots = await this.roots;
    const root = roots.find((r) => inside(r, real));
    if (!root) throw new PathDenied(path, "outside the worktree");
    if (write && relative(root, real).split(sep).includes(".git")) throw new PathDenied(path, "git internals are read-only");
    return real;
  }

  read(path: string): Promise<string> {
    return this.check(path, false);
  }

  write(path: string): Promise<string> {
    return this.check(path, true);
  }

  readOps() {
    return {
      readFile: async (p: string) => readFile(await this.read(p)),
      access: async (p: string) => access(await this.read(p), constants.R_OK),
    };
  }

  writeOps() {
    return {
      writeFile: async (p: string, content: string) => writeFile(await this.write(p), content, "utf8"),
      mkdir: async (d: string) => void (await mkdir(await this.write(d), { recursive: true })),
    };
  }

  editOps() {
    return {
      readFile: async (p: string) => readFile(await this.write(p)),
      writeFile: async (p: string, content: string) => writeFile(await this.write(p), content, "utf8"),
      access: async (p: string) => access(await this.write(p), constants.R_OK | constants.W_OK),
    };
  }

  grepOps() {
    return {
      // Called first with the search path; a denial surfaces as "Path not found".
      isDirectory: async (p: string) => (await stat(await this.read(p))).isDirectory(),
      readFile: async (p: string) => readFile(await this.read(p), "utf8"),
    };
  }

  findOps() {
    return {
      exists: async (p: string) => {
        try {
          await stat(await this.read(p));
          return true;
        } catch {
          return false;
        }
      },
      glob: async (pattern: string, cwd: string, opts: { ignore: string[]; limit: number }) => {
        const base = await this.read(cwd);
        const pat = pattern.includes("/") ? pattern : `**/${pattern}`;
        const out: string[] = [];
        for await (const rel of glob(pat, { cwd: base, exclude: (n) => /(^|\/)(node_modules|\.git)(\/|$)/.test(String(n)) })) {
          const abs = join(base, rel);
          // Results reached through a symlink to outside are dropped.
          if (!(await this.read(abs).then(() => true, () => false))) continue;
          out.push(rel);
          if (out.length >= opts.limit) break;
        }
        return out;
      },
    };
  }

  lsOps() {
    return {
      exists: async (p: string) => {
        try {
          await lstat(await this.read(p));
          return true;
        } catch {
          return false;
        }
      },
      stat: async (p: string) => {
        // Entries are listed by name; a symlink to outside is shown but not followed.
        try {
          return await stat(await this.read(p));
        } catch (e) {
          if (e instanceof PathDenied) return lstat(p);
          throw e;
        }
      },
      readdir: async (p: string) => readdir(await this.read(p)),
    };
  }
}
