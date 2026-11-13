import type { Candidate, DiskVersions } from "./state.js";
import { DATA_VERSIONS } from "./state.js";

export { dataVersionsOnDisk } from "./state.js";

/**
 * Whether a staged release can run over the durable state this factory home holds (#187).
 *
 * Two different answers, because they fail differently:
 * - the state on disk is newer than the candidate reads → the candidate cannot run over it at all
 *   (the same test is why a downgrade back to an older release is refused once state was migrated).
 * - the candidate writes a newer version than the state in use → starting it migrates that state,
 *   and a migration cannot be undone by switching the version back.
 */

export interface Compat {
  ok: boolean;
  reasons: string[];
  /** True when the reasons are only about a state migration the operator can accept. */
  migrates_only: boolean;
}

const KINDS = ["queue", "run_state", "plan"] as const;
type Kind = (typeof KINDS)[number];

const LABEL: Record<Kind, string> = { queue: "queue schema", run_state: "run state schema", plan: "plan schema" };

type CandidateLike = Pick<Candidate, "reads" | "writes" | "version">;

/**
 * The schema versions in use: what is on disk, and at least what the running installation writes
 * (an empty home still holds version-1 state as soon as the current worker writes to it).
 */
function versionsInUse(disk: DiskVersions, baseline: CandidateLike["writes"] = DATA_VERSIONS.writes): Record<Kind, number> {
  const out = {} as Record<Kind, number>;
  for (const kind of KINDS) {
    const onDisk = disk[kind];
    out[kind] = onDisk.length ? Math.max(baseline[kind], Math.max(...onDisk)) : baseline[kind];
  }
  return out;
}

function check(candidate: CandidateLike, disk: DiskVersions, name: string, baseline?: CandidateLike["writes"]): Compat {
  const unreadable: string[] = [];
  const migrations: string[] = [];
  const inUse = versionsInUse(disk, baseline);
  for (const kind of KINDS) {
    for (const version of disk[kind]) {
      if (!candidate.reads[kind].includes(version)) {
        unreadable.push(`${name} ${candidate.version} cannot read ${LABEL[kind]} ${version} on disk (it reads ${candidate.reads[kind].join(", ")})`);
      }
    }
    if (candidate.writes[kind] > inUse[kind]) {
      migrations.push(`${name} ${candidate.version} would migrate ${LABEL[kind]} ${inUse[kind]} -> ${candidate.writes[kind]}; switching the version back cannot undo it`);
    }
  }
  const reasons = [...unreadable, ...migrations];
  return { ok: reasons.length === 0, reasons, migrates_only: reasons.length > 0 && unreadable.length === 0 };
}

/** `baseline` is the write version of the installation being replaced; it defaults to this code. */
export function checkCandidateCompat(candidate: CandidateLike, disk: DiskVersions, baseline?: CandidateLike["writes"]): Compat {
  return check(candidate, disk, "candidate", baseline);
}

/** True when `rollback` could still read the state `target` writes. */
export function rollbackIsCompatible(rollback: CandidateLike, target: CandidateLike, disk: DiskVersions): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const inUse = versionsInUse(disk);
  for (const kind of KINDS) {
    const written = Math.max(target.writes[kind], inUse[kind]);
    if (!rollback.reads[kind].includes(written)) {
      reasons.push(`rollback to ${rollback.version} is refused: it cannot read ${LABEL[kind]} ${written}, which the target ${target.version} writes`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
