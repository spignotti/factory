import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Variables agent tool processes may inherit from the factory. Everything else is dropped. */
export const BASE_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "SHELL",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * Never passed, even when configured (repo.yaml `agent_env`, profile `env`): only the factory process
 * pushes, calls `gh` and talks to model providers.
 */
export const NEVER_PASSED = new Set([
  // Model provider credentials of the factory itself (Pi reads them from the factory's env/auth.json).
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  // Context7 key: docs_lookup runs in the factory process.
  "CONTEXT7_API_KEY",
  "PI_CODING_AGENT_DIR",
  "FACTORY_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

/**
 * Creates the per-run isolated HOME: empty git and gh config, no credentials.
 * Idempotent; returns the directory.
 */
export function prepareAgentHome(runDir: string): string {
  const home = join(runDir, "home");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "");
  return home;
}

/** Shared download cache for setup, checks and agents. `HOME` stays the per-run directory. */
export function sharedCacheDir(factoryHome: string): string {
  return join(factoryHome, "cache");
}

/** Creates `$FACTORY_HOME/cache` when the home exists. Does not create a missing factory home. */
export function ensureSharedCache(factoryHome: string): string {
  const cache = sharedCacheDir(factoryHome);
  if (existsSync(factoryHome)) mkdirSync(cache, { recursive: true });
  return cache;
}

/** Package-manager caches for setup, checks and agents. All four point at `$FACTORY_HOME/cache`. */
export function sharedCacheEnv(factoryHome: string): Record<string, string> {
  const cache = ensureSharedCache(factoryHome);
  return {
    UV_CACHE_DIR: cache,
    npm_config_cache: cache,
    PIP_CACHE_DIR: cache,
    XDG_CACHE_HOME: cache,
  };
}

export interface AgentEnvOptions {
  home: string;
  /** When set, package caches go to `$FACTORY_HOME/cache` (setup, checks, agents). */
  factoryHome?: string;
  /** Explicitly configured extra names (repo.yaml `agent_env`, profile role `env`). */
  extra?: readonly string[];
  /** Names never passed (repo secrets and their wrapper credentials: commands get them, agents never). */
  exclude?: readonly string[];
  /** Values the factory sets itself (e.g. service URLs); never taken from the parent env. */
  set?: Record<string, string>;
}

/** Builds the complete environment for agent tool processes and checks from an explicit allowlist. */
export function buildAgentEnv(parent: NodeJS.ProcessEnv, opts: AgentEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV_ALLOWLIST, ...(opts.extra ?? [])]) {
    if (NEVER_PASSED.has(name) || opts.exclude?.includes(name)) continue;
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, opts.set ?? {});
  if (opts.factoryHome) Object.assign(env, sharedCacheEnv(opts.factoryHome));
  Object.assign(env, {
    HOME: opts.home,
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    GIT_CONFIG_GLOBAL: join(opts.home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(opts.home, ".config", "gh"),
    GIT_TERMINAL_PROMPT: "0",
  });
  for (const name of NEVER_PASSED) delete env[name];
  return env;
}
