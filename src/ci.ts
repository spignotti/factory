import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { asset } from "./prompts.js";
import { loadRepoConfig, REPO_CONFIG_PATH } from "./schemas/repo.js";

/**
 * CI stub: `.github/workflows/factory.yml` is a template with the pinned factory ref filled in.
 * Repos with a check that is not `local_only` get `templates/ci/factory.yml` (select, check, done),
 * including `tier: manual`, so `workflow_dispatch` can still run it. Repos where every check is
 * `local_only` (or there is none) get `templates/ci/factory-minimal.yml` (a draft marker and `done`, no npx).
 * `doctor` compares hashes against the rendering that matches the repo.
 * Pull requests, release tags and workflow_dispatch run it; pushes to the base branch do not.
 * One file, not a reusable workflow, so branch protection has a single status name (`done`) when
 * the stub actually runs checks.
 */
export const CI_STUB_PATH = ".github/workflows/factory.yml";
/**
 * The stub's single required status check: GitHub Actions reports a job's check run under its job name
 * (`done`), without the workflow name, so branch protection must require `done`.
 */
export const REQUIRED_CHECK = "done";
/** What earlier docs told people to require; it never reports, so it blocks every PR. */
export const LEGACY_REQUIRED_CHECK = "factory / done";
export const CI_TEMPLATE = new URL("../templates/ci/factory.yml", import.meta.url);
export const CI_MINIMAL_TEMPLATE = new URL("../templates/ci/factory-minimal.yml", import.meta.url);
const REF_MARK = "@FACTORY_REF@";
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const PINNED = /github:spignotti\/factory#([^\s"']+)/g;
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** A tag resolved to a commit, kept next to the SHA pin. Not part of the hash `doctor` compares. */
const TAG_PIN_LINE = /^# pinned from tag ([A-Za-z0-9][A-Za-z0-9._/-]{0,99}) \(([0-9a-f]{40})\)\n/m;
const FACTORY_GIT = "https://github.com/spignotti/factory.git";
const FACTORY_API = "repos/spignotti/factory";

/** `full`: select/check/done. `minimal`: draft marker and `done`, no factory install. */
export type CiStubMode = "full" | "minimal";

/**
 * A check that is not `local_only` can run in CI: fast and full on a pull request or a tag,
 * manual on `workflow_dispatch` (the full stub's tier input, default manual). When every check
 * is `local_only` (or there is none), the select job would only install the factory and print `[]`.
 */
export function ciStubMode(checks: { tier: string; local_only?: boolean }[]): CiStubMode {
  return checks.some((c) => c.local_only !== true) ? "full" : "minimal";
}

/** Rendering for the repo's checks. Missing `repo.yaml` keeps the full stub (do not drop checks we cannot see). */
export function ciStubModeAt(repoDir: string): CiStubMode {
  if (!existsSync(join(repoDir, REPO_CONFIG_PATH))) return "full";
  return ciStubMode(loadRepoConfig(repoDir).checks);
}

export function ciStubTemplate(mode: CiStubMode): string {
  return readFileSync(mode === "minimal" ? CI_MINIMAL_TEMPLATE : CI_TEMPLATE, "utf8");
}

/** Default CI-stub pin: the release tag of this factory version (`v<package.json version>`). */
export function defaultRef(): string {
  return `v${(JSON.parse(asset("package.json")) as { version: string }).version}`;
}

export function renderCiStub(ref: string, template = readFileSync(CI_TEMPLATE, "utf8")): string {
  if (!REF.test(ref) || ref.includes("..")) throw new Error(`invalid factory ref: ${ref}`);
  return template.replaceAll(REF_MARK, ref);
}

/** Human note for a SHA pin that was resolved from a tag. `doctor` strips it before hashing. */
export function tagPinComment(tag: string, sha: string): string {
  return `# pinned from tag ${tag} (${sha})`;
}

export function readTagPinComment(text: string): { tag: string; sha: string } | undefined {
  const m = TAG_PIN_LINE.exec(text);
  return m ? { tag: m[1]!, sha: m[2]! } : undefined;
}

export function stripTagPinComment(text: string): string {
  return text.replace(TAG_PIN_LINE, "");
}

/** Insert the tag comment after the first line so stripping it restores `renderCiStub`. */
export function withTagPinComment(rendered: string, tag: string, sha: string): string {
  const line = `${tagPinComment(tag, sha)}\n`;
  const nl = rendered.indexOf("\n");
  return nl < 0 ? `${rendered}\n${line}` : `${rendered.slice(0, nl + 1)}${line}${rendered.slice(nl + 1)}`;
}

/** The stub `factory ci-stub` prints for this ref and mode. `tag` records the tag a SHA pin came from. */
export function renderCiStubFor(ref: string, mode: CiStubMode, tag?: string): string {
  const body = renderCiStub(ref, ciStubTemplate(mode));
  return tag ? withTagPinComment(body, tag, ref) : body;
}

export interface RefLookup {
  exec(command: "git" | "gh", args: string[]): string;
}

function defaultRefLookup(): RefLookup {
  return {
    exec(command, args) {
      return execFileSync(command, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    },
  };
}

function shaFromLsRemote(text: string): string | undefined {
  return /^([0-9a-f]{40})\b/im.exec(text)?.[1]?.toLowerCase();
}

function tryLookup(lookup: RefLookup, command: "git" | "gh", args: string[]): string | undefined {
  try {
    const out = lookup.exec(command, args).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A full commit SHA is already a pin. A tag is resolved to the commit it points at
 * (git ls-remote peel, then `gh api`, then an unpeeled lightweight tag) and kept as a comment.
 */
export function resolveFactoryRef(ref: string, lookup: RefLookup = defaultRefLookup()): { pin: string; tag?: string } {
  if (!REF.test(ref) || ref.includes("..")) throw new Error(`invalid factory ref: ${ref}`);
  if (FULL_SHA.test(ref)) return { pin: ref.toLowerCase() };
  const peeled = shaFromLsRemote(tryLookup(lookup, "git", ["ls-remote", FACTORY_GIT, `refs/tags/${ref}^{}`]) ?? "");
  if (peeled) return { pin: peeled, tag: ref };
  const viaGh = tryLookup(lookup, "gh", ["api", `${FACTORY_API}/commits/${ref}`, "--jq", ".sha"])?.toLowerCase();
  if (viaGh && FULL_SHA.test(viaGh)) return { pin: viaGh, tag: ref };
  const direct = shaFromLsRemote(tryLookup(lookup, "git", ["ls-remote", FACTORY_GIT, `refs/tags/${ref}`]) ?? "");
  if (direct) return { pin: direct, tag: ref };
  throw new Error(`could not resolve factory ref ${ref} to a commit SHA (git ls-remote and gh api failed)`);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface CiStubStatus {
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Factory refs a CI stub text pins (`github:spignotti/factory#<ref>`), deduplicated. */
export function pinnedRefs(text: string): string[] {
  return [...new Set([...text.matchAll(PINNED)].map((m) => m[1]!))];
}

/** The repo's CI stub equals the rendering for the ref it pins (hash). `mode` is the rendering the repo's checks need. */
export function ciStubCheck(repoDir: string, template = readFileSync(CI_TEMPLATE, "utf8"), currentRef?: string, mode: CiStubMode = "full"): CiStubStatus {
  const path = join(repoDir, CI_STUB_PATH);
  // Not adopted yet (by hand until `adopt`, M5): a warning, not a failure.
  if (!existsSync(path)) return { status: "warn", detail: `${CI_STUB_PATH} is missing; write it with \`factory ci-stub --ref <tag> > ${CI_STUB_PATH}\`` };
  const actual = readFileSync(path, "utf8");
  // A SHA pin may carry a tag comment. The hash is the template for whatever ref the npx line pins.
  const noted = readTagPinComment(actual);
  const stripped = stripTagPinComment(actual);
  const refs = pinnedRefs(stripped);
  if (refs.length !== 1) {
    return { status: "fail", detail: refs.length ? `pins several factory refs (${refs.join(", ")})` : "pins no github:spignotti/factory#<ref>" };
  }
  const ref = refs[0]!;
  if (noted && noted.sha !== ref) return { status: "fail", detail: `tag comment records ${noted.sha} but the stub pins ${ref}` };
  let expected: string;
  try {
    expected = renderCiStub(ref, mode === "minimal" ? ciStubTemplate("minimal") : template);
  } catch (e) {
    return { status: "fail", detail: (e as Error).message };
  }
  const a = sha256(stripped);
  const x = sha256(expected);
  return a === x
    ? { status: "ok", detail: `equals the template for ${ref} (sha256 ${x.slice(0, 12)})` }
    : currentRef && currentRef !== ref
      ? // The template belongs to this factory, not to the pinned (older or newer) ref: bump the pin deliberately.
        { status: "fail", detail: `differs from this factory's template (pins ${ref}, this factory is ${currentRef}; sha256 ${a.slice(0, 12)}, expected ${x.slice(0, 12)}); bump the pin in a PR with \`factory ci-stub --ref ${currentRef} > ${CI_STUB_PATH}\`` }
      : { status: "fail", detail: `differs from the template for ${ref} (sha256 ${a.slice(0, 12)}, expected ${x.slice(0, 12)}); re-render with \`factory ci-stub --ref ${ref}\`` };
}

/**
 * Other workflows that run on pull requests may gate merges with checks repo.yaml does not know
 * (no other workflow should run checks unknown to repo.yaml). Returned as file names for a hint.
 */
export function otherPrWorkflows(repoDir: string): string[] {
  const dir = join(repoDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    if (`.github/workflows/${name}` === CI_STUB_PATH) continue;
    try {
      const wf = parse(readFileSync(join(dir, name), "utf8")) as { on?: unknown; true?: unknown } | null;
      const on = wf?.on ?? wf?.true; // YAML 1.1 readers turn `on` into true
      const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : on && typeof on === "object" ? Object.keys(on) : [];
      if (triggers.some((t) => t === "pull_request" || t === "pull_request_target")) out.push(name);
    } catch {
      out.push(`${name} (unparsable)`);
    }
  }
  return out;
}
