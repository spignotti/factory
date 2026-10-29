import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Copies test/fixtures/repo into a temp dir, writes `.factory/repo.yaml` (optionally patched) and commits on main. */
export function createFixtureRepo(patch?: (cfg: Record<string, unknown>) => void): string {
  const dir = join(mkdtempSync(join(tmpdir(), "factory-fixture-")), "repo");
  cpSync(join(FIXTURES, "repo"), dir, { recursive: true });
  const cfg = parse(readFileSync(join(dir, "factory-repo.yaml"), "utf8")) as Record<string, unknown>;
  patch?.(cfg);
  mkdirSync(join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory", "repo.yaml"), stringify(cfg));
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@test", "commit", "-q", "-m", "init");
  return dir;
}

export function commitFile(dir: string, path: string, content: string, message = "change"): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@test", "commit", "-q", "-m", message);
}
