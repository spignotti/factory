import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * CI stub: `.github/workflows/factory.yml` is `templates/ci/factory.yml` with the pinned factory
 * ref filled in, identical in every repo. `doctor` compares hashes.
 */
export const CI_STUB_PATH = ".github/workflows/factory.yml";
export const CI_TEMPLATE = new URL("../templates/ci/factory.yml", import.meta.url);
const REF_MARK = "@FACTORY_REF@";
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const PINNED = /github:spignotti\/factory#([^\s"']+)/g;

export function renderCiStub(ref: string, template = readFileSync(CI_TEMPLATE, "utf8")): string {
  if (!REF.test(ref) || ref.includes("..")) throw new Error(`invalid factory ref: ${ref}`);
  return template.replaceAll(REF_MARK, ref);
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

/** The repo's CI stub equals the template for the ref it pins (hash). */
export function ciStubCheck(repoDir: string, template = readFileSync(CI_TEMPLATE, "utf8")): CiStubStatus {
  const path = join(repoDir, CI_STUB_PATH);
  // Not adopted yet (by hand until `adopt`, M5): a warning, not a failure.
  if (!existsSync(path)) return { status: "warn", detail: `${CI_STUB_PATH} is missing; write it with \`factory ci-stub --ref <tag> > ${CI_STUB_PATH}\`` };
  const actual = readFileSync(path, "utf8");
  const refs = pinnedRefs(actual);
  if (refs.length !== 1) {
    return { status: "fail", detail: refs.length ? `pins several factory refs (${refs.join(", ")})` : "pins no github:spignotti/factory#<ref>" };
  }
  const ref = refs[0]!;
  let expected: string;
  try {
    expected = renderCiStub(ref, template);
  } catch (e) {
    return { status: "fail", detail: (e as Error).message };
  }
  const a = sha256(actual);
  const x = sha256(expected);
  return a === x
    ? { status: "ok", detail: `equals the template for ${ref} (sha256 ${x.slice(0, 12)})` }
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
