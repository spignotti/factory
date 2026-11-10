import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Io } from "./gates.js";
import { CHECKLIST_REL, migrateStandards, readOptionalFile, REVIEW_RULES_REL, STANDARDS_REL } from "../standards.js";

export interface StandardsMigrateOptions {
  repo: string;
  json: boolean;
}

/**
 * `factory standards migrate --repo <path>`: writes `.factory/standards.md` from the old files.
 * Does not delete them.
 */
export function standardsMigrateCommand(opts: StandardsMigrateOptions, io: Io): number {
  const repoDir = resolve(opts.repo);
  const dest = join(repoDir, STANDARDS_REL);
  if (existsSync(dest)) {
    io.err(`factory: ${STANDARDS_REL} already exists; not overwriting\n`);
    return 1;
  }
  const text = migrateStandards({
    checklist: readOptionalFile(join(repoDir, CHECKLIST_REL)),
    reviewRules: readOptionalFile(join(repoDir, REVIEW_RULES_REL)),
  });
  if (text === undefined) {
    io.err(`factory: nothing to migrate (no ${CHECKLIST_REL} or ${REVIEW_RULES_REL})\n`);
    return 1;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  if (opts.json) io.out(JSON.stringify({ written: STANDARDS_REL }) + "\n");
  else io.out(`wrote ${STANDARDS_REL} (severity first, ## Rules last; left ${CHECKLIST_REL} and ${REVIEW_RULES_REL} in place — ignored once standards.md exists, delete them)\n`);
  return 0;
}
