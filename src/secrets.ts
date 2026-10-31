import { spawn, spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BASE_ENV_ALLOWLIST } from "./agents/env.js";
import type { SecretsConfig } from "./schemas/repo.js";

/**
 * Per-repo secrets (repo.yaml `secrets:`). Values go to checks, services and the evaluated app only,
 * never to agent sessions, their tools or prompts; every value is redacted from what the factory writes.
 * Nothing here prints or returns a value in an error.
 */

/** Values shorter than this are not redacted (they would mangle logs); doctor warns about them. */
export const MIN_REDACT_LENGTH = 6;
const WRAPPER_TIMEOUT_MS = 60_000;

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export interface ResolvedSecrets {
  /** name → value, only the configured `names` that resolved. */
  env: Record<string, string>;
  /** Configured names that did not resolve. */
  missing: string[];
  /** Values to redact everywhere: the secrets and the wrapper's credentials. */
  redact: string[];
  /** Names of resolved values too short to redact. */
  short: string[];
  /** Secret files (hidden from jails). */
  files: string[];
  /** Every name involved (secrets and wrapper credentials), never passed to agents. */
  names: string[];
}

export const NO_SECRETS: ResolvedSecrets = { env: {}, missing: [], redact: [], short: [], files: [], names: [] };

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** Repo name from a remote URL (`git@host:owner/tourenpilot.git`, `https://host/owner/tourenpilot`); undefined when none. */
export function repoNameFromUrl(url: string): string | undefined {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return name && name !== "." && name !== ".." ? name : undefined;
}

/**
 * Stable per-repo name for files outside the repo (`~/.factory/secrets/<name>.env`): the repository name
 * from `remote.origin.url`, so every clone or worktree of a repo shares it; the directory name without an origin.
 */
export function repoName(repoDir: string): string {
  const r = spawnSync("git", ["-C", repoDir, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 10_000 });
  return (r.status === 0 && repoNameFromUrl(r.stdout)) || basename(resolve(repoDir));
}

/**
 * Default `env_file` path: `$FACTORY_HOME/secrets/<repo name>.env`. A file named after the checkout
 * directory (the earlier default) is still used while the new one does not exist; `legacy` is then set.
 */
export function defaultSecretsFile(repoDir: string, factoryHome: string): { file: string; legacy?: string; preferred: string } {
  const preferred = join(factoryHome, "secrets", `${repoName(repoDir)}.env`);
  const old = join(factoryHome, "secrets", `${basename(resolve(repoDir))}.env`);
  if (old !== preferred && !existsSync(preferred) && existsSync(old)) return { file: old, legacy: old, preferred };
  return { file: preferred, preferred };
}

/** The dotenv file a config reads: `env_file` path (default per repo) or the wrapper's credentials. */
export function secretsFile(cfg: SecretsConfig, repoDir: string, factoryHome: string): string | undefined {
  if (cfg.provider === "env_file") return resolve(cfg.path ? expandHome(cfg.path) : defaultSecretsFile(repoDir, factoryHome).file);
  return cfg.credentials ? resolve(expandHome(cfg.credentials)) : undefined;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Whether `file` lies inside `dir` (after resolving symlinks). */
export function isInside(dir: string, file: string): boolean {
  const rel = relative(real(dir), existsSync(file) ? real(file) : join(real(dirname(file)), basename(file)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Group or world permission bits set (a secret file should be 0600). */
export function looseMode(file: string): boolean {
  return (statSync(file).mode & 0o077) !== 0;
}

/** Minimal dotenv: `NAME=value`, optional `export `, `#` comments, single or double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** Reads a secret dotenv file after the location and permission checks. */
function readSecretFile(file: string, what: string, repoDir: string): Record<string, string> {
  if (isInside(repoDir, file)) throw new SecretsError(`${what} ${file} is inside the repo; keep it outside (e.g. ~/.factory/secrets/)`);
  if (!existsSync(file)) throw new SecretsError(`${what} ${file} does not exist`);
  if (looseMode(file)) throw new SecretsError(`${what} ${file} is readable by group or others; run chmod 600 ${file}`);
  return parseDotenv(readFileSync(file, "utf8"));
}

export interface ResolveOptions {
  repoDir: string;
  factoryHome: string;
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Resolves the configured names. Throws SecretsError (no values in the message) on config or wrapper errors. */
export async function resolveSecrets(cfg: SecretsConfig | undefined, opts: ResolveOptions): Promise<ResolvedSecrets> {
  if (!cfg) return NO_SECRETS;
  const file = secretsFile(cfg, opts.repoDir, opts.factoryHome);
  let source: Record<string, string>;
  let credentials: Record<string, string> = {};
  if (cfg.provider === "env_file") {
    source = readSecretFile(file!, "secrets file", opts.repoDir);
  } else {
    if (file) credentials = readSecretFile(file, "secrets credentials file", opts.repoDir);
    const overlap = cfg.names.filter((n) => n in credentials);
    if (overlap.length) throw new SecretsError(`secrets.names lists wrapper credentials (${overlap.join(", ")}); they stay with the wrapper`);
    source = await runWrapper(cfg.command, { cwd: opts.repoDir, env: wrapperEnv(opts.parentEnv ?? process.env, credentials), timeoutMs: opts.timeoutMs ?? WRAPPER_TIMEOUT_MS, redact: Object.values(credentials) });
  }
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of cfg.names) {
    if (source[name] === undefined) missing.push(name);
    else env[name] = source[name];
  }
  const values = [...Object.values(env), ...Object.values(credentials)];
  return {
    env,
    missing,
    redact: [...new Set(values.filter((v) => v.length >= MIN_REDACT_LENGTH))].sort((a, b) => b.length - a.length),
    short: Object.entries(env).filter(([, v]) => v.length > 0 && v.length < MIN_REDACT_LENGTH).map(([n]) => n),
    files: file ? [file] : [],
    names: [...cfg.names, ...Object.keys(credentials)],
  };
}

/** The wrapper's env: the base allowlist, the user's HOME (a logged-in CLI keeps working) and its credentials. */
export function wrapperEnv(parent: NodeJS.ProcessEnv, credentials: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_ALLOWLIST, "HOME", "USER", "LOGNAME", "XDG_CONFIG_HOME"]) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...credentials };
}

/** Runs `<command> env -0` and parses the NUL-separated environment it prints. Stdout never reaches an error. */
function runWrapper(command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number; redact: string[] }): Promise<Record<string, string>> {
  return new Promise((done, fail) => {
    const child = spawn("sh", ["-c", `${command} env -0`], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(new SecretsError(`secrets command could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return fail(new SecretsError(`secrets command timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
      if (code !== 0) {
        let tail = err.trim().split("\n").slice(-3).join(" | ");
        for (const v of opts.redact) if (v.length >= MIN_REDACT_LENGTH) tail = tail.split(v).join("[redacted]");
        return fail(new SecretsError(`secrets command exited ${code}${tail ? `: ${tail}` : ""}`));
      }
      const env: Record<string, string> = {};
      for (const entry of Buffer.concat(out).toString("utf8").split("\0")) {
        const i = entry.indexOf("=");
        // A wrapper banner on stdout ends up before the first name; names never hold a newline.
        const name = i > 0 ? entry.slice(entry.lastIndexOf("\n", i) + 1, i) : "";
        if (name) env[name] = entry.slice(i + 1);
      }
      done(env);
    });
  });
}

const BINARY = /\.(png|jpe?g|gif|webm|mp4|zip|gz|tar|sqlite|db)$/i;

/**
 * Redacts text files under `dir` in place (service logs, browser captures), skipping `skip` dir names
 * (worktrees, agent HOME). Run-end defense in depth: some outputs are written by child processes directly.
 */
export function redactTree(dir: string, redact: (s: string) => string, skip: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.includes(e.name)) redactTree(p, redact, skip);
    } else if (e.isFile() && !BINARY.test(e.name)) {
      try {
        if (statSync(p).size > 50_000_000) continue;
        const text = readFileSync(p, "utf8");
        const out = redact(text);
        if (out !== text) writeFileSync(p, out);
      } catch {
        // vanished or unreadable
      }
    }
  }
}
