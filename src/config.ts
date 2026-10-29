import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  DEFAULT_PROVIDERS,
  type Profile,
  type ProfileLayer,
  ProfileLayerSchema,
  type ProfileRole,
  ProfileSchema,
  type RoleOverrides,
} from "./schemas/profile.js";

/**
 * Layered model configuration (Amendment i), most specific wins:
 *   built-in (`profiles/default.yaml`) < user (`$FACTORY_HOME/profile.yaml`) < `--profile <file>`
 *   < repo (`.factory/repo.yaml` `models:`).
 * Layers replace whole role chains. Provider policy comes only from the built-in and user layers.
 * Every safety rule (provider policy, reviewer family ≠ implement family, capacity-only backup) is
 * validated on the merged result, so no layer can switch it off.
 */
export type LayerName = "built-in" | "user" | "cli" | "repo";

export interface Layer {
  name: LayerName;
  /** File the layer came from (for messages). */
  source: string;
  data: ProfileLayer;
  /** Per-role layer names to report instead of `name` (re-merging a resolved profile). */
  roleSources?: Partial<Record<ProfileRole, string>>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function factoryHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTORY_HOME ?? join(homedir(), ".factory");
}

export function userProfilePath(factoryHome: string): string {
  return join(factoryHome, "profile.yaml");
}

function formatZod(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseLayer(name: LayerName, source: string, text: string): Layer {
  const parsed = ProfileLayerSchema.safeParse(parse(text) ?? {});
  if (!parsed.success) throw new ConfigError(`${name} profile ${source} is invalid: ${formatZod(parsed.error)}`);
  for (const key of ["providers", "sandbox"] as const) {
    if (parsed.data[key] !== undefined && name !== "built-in" && name !== "user") {
      throw new ConfigError(`${name} profile ${source}: ${key} can only be set in the built-in or user profile (${userProfilePathHint})`);
    }
  }
  return { name, source, data: parsed.data };
}

const userProfilePathHint = "$FACTORY_HOME/profile.yaml";

function readLayer(name: LayerName, path: string | URL): Layer {
  return parseLayer(name, String(path instanceof URL ? path.pathname : path), readFileSync(path, "utf8"));
}

export const BUILTIN_PROFILE = new URL("../profiles/default.yaml", import.meta.url);

/** `--profile <name|file>`: a shipped profile name (`profiles/<name>.yaml`) or a path. */
function cliProfilePath(nameOrPath: string): string | URL {
  return nameOrPath.includes("/") || nameOrPath.endsWith(".yaml") ? nameOrPath : new URL(`../profiles/${nameOrPath}.yaml`, import.meta.url);
}

/** Built-in, user (if the file exists) and `--profile` (if given) layers. */
export function loadLayers(opts: { factoryHome: string; profile?: string; builtin?: string | URL }): Layer[] {
  const layers = [readLayer("built-in", opts.builtin ?? BUILTIN_PROFILE)];
  const user = userProfilePath(opts.factoryHome);
  if (existsSync(user)) layers.push(readLayer("user", user));
  if (opts.profile) layers.push(readLayer("cli", cliProfilePath(opts.profile)));
  return layers;
}

/** The repo layer from repo.yaml `models:` (role → chain). */
export function repoLayer(models: RoleOverrides | undefined, source = ".factory/repo.yaml"): Layer | undefined {
  return models && Object.keys(models).length ? { name: "repo", source, data: { roles: models } } : undefined;
}

/** Merges layers (later = more specific) and validates the result. */
export function resolveProfile(layers: Layer[]): Profile {
  const roles: Record<string, unknown> = {};
  const sources: Partial<Record<ProfileRole, string>> = {};
  let retry: Record<string, unknown> = {};
  const env: Record<string, string[]> = {};
  const providers: Record<string, unknown> = { ...DEFAULT_PROVIDERS };
  let sandbox: string | undefined;
  for (const layer of layers) {
    for (const [role, chain] of Object.entries(layer.data.roles ?? {})) {
      if (!chain) continue;
      roles[role] = chain;
      sources[role as ProfileRole] = layer.roleSources?.[role as ProfileRole] ?? layer.name;
    }
    retry = { ...retry, ...layer.data.retry };
    Object.assign(env, layer.data.env ?? {});
    if (layer.name === "built-in" || layer.name === "user") {
      Object.assign(providers, layer.data.providers ?? {});
      sandbox = layer.data.sandbox ?? sandbox;
    }
  }
  const parsed = ProfileSchema.safeParse({ roles, retry, env, providers, sandbox });
  if (!parsed.success) {
    const where = (path: PropertyKey[]) => {
      const role = path[0] === "roles" ? (path[1] as ProfileRole | undefined) : undefined;
      return role && sources[role] ? ` [${role} from ${sources[role]} layer]` : "";
    };
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}${where(i.path)}`).join("; ");
    throw new ConfigError(`model configuration is invalid after merging ${layers.map((l) => l.name).join(" < ")}: ${msg}`);
  }
  return { ...parsed.data, sources };
}

/** Applies a repo's `models:` overrides on top of an already resolved profile and re-validates. */
export function withRepoModels(profile: Profile, models: RoleOverrides | undefined): Profile {
  const layer = repoLayer(models);
  if (!layer) return profile;
  const base: Layer = {
    name: "built-in",
    source: "(resolved)",
    data: { roles: profile.roles, retry: profile.retry, env: profile.env, providers: profile.providers, sandbox: profile.sandbox },
    roleSources: profile.sources,
  };
  return resolveProfile([base, layer]);
}

/** Effective model per role with the layer it came from (`doctor`). */
export function describeProfile(profile: Profile): { role: ProfileRole; models: string[]; layer: string }[] {
  return (Object.keys(profile.roles) as ProfileRole[]).map((role) => ({
    role,
    models: profile.roles[role].map((e) => `${e.model}${e.thinking ? ` (${e.thinking})` : ""}${e.capacity_only ? " [capacity-only]" : ""}`),
    layer: profile.sources?.[role] ?? "built-in",
  }));
}
