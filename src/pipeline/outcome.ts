import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redact, StopSchema, type RunOutcome, type RunProvenance, type RunResultKind, type RunStop, type StopCause } from "../events.js";

/**
 * The one action permitted per stop cause. This mapping is the whole contract of #179: it never
 * grants merge permission — risk, protected paths, pause, issue revision, model-family separation,
 * reviewed SHA and required checks stay authoritative wherever they are enforced.
 */
export function stopFor(cause: StopCause): RunStop {
  switch (cause) {
    case "technical_repair":
      return { cause, action: "repair" };
    case "transient_retry":
      return { cause, action: "retry" };
    case "provider_window_wait":
      return { cause, action: "wait" };
    case "explicit_decision":
    case "budget_exhausted":
      return { cause, action: "decide" };
    case "human_approval":
      return { cause, action: "approve" };
    case "unknown":
      return { cause, action: "none" };
  }
}

/**
 * Provider stops the worker may requeue now. A usage-window wait is not one of them: it parks on its
 * reset window (#177), and generic 429/capacity is `transient_retry`.
 */
export function isProviderRetryCause(cause: unknown): boolean {
  return cause === "transient_retry";
}

/** Canonical stop, or undefined when the stop is absent (legacy) or not a canonical pair. */
export function readStop(stop: unknown): RunStop | undefined {
  const parsed = StopSchema.safeParse(stop);
  return parsed.success ? parsed.data : undefined;
}

/** Cause of a stored stop, or undefined when the stop is absent (legacy) or malformed. */
export function stopCauseOf(stop: unknown): StopCause | undefined {
  return readStop(stop)?.cause;
}

/**
 * A stopped run may be re-driven only when both stored stops grant repair and the result names the
 * same run, branch, worktree and PR as state. Done self-merge revalidation does not use this.
 */
export function repairContinuationAllowed(
  state: { run_id: string; branch: string | null; worktree: string | null; pr: string | null; stop?: unknown },
  result: { result: string; run_id: string; branch: string | null; worktree: string | null; pr: string | null; stop?: unknown },
): boolean {
  if (result.result === "done") return false;
  if (!state.branch || !state.worktree || !state.pr) return false;
  if (result.run_id !== state.run_id || result.branch !== state.branch || result.worktree !== state.worktree || result.pr !== state.pr) return false;
  return readStop(state.stop)?.cause === "technical_repair" && readStop(result.stop)?.cause === "technical_repair";
}

/**
 * A coding run never stores a confirmed merge. `ticket: null` means the task has no ticket.
 * `attempts: null` means this checkpoint did not record a count (legacy); that is not zero.
 */
export function buildOutcome(input: { ticket: number | null; attempts: number | null; pr: string | null; result: RunResultKind }): RunOutcome {
  return {
    ticket: input.ticket,
    attempts: input.attempts,
    delivered_pr: input.pr,
    merged: "no",
    ended_without_merge: input.result !== "locked",
    open_decision: input.result === "needs_human" || input.result === "needs_input",
  };
}

/** Read model. Missing `outcome` stays unknown, including when an older `pr` field is set. */
export interface ReadOutcome {
  ticket: number | null | "unknown";
  attempts: number | null | "unknown";
  delivered_pr: string | null | "unknown";
  merged: "no" | "confirmed" | "unknown";
  ended_without_merge: boolean | "unknown";
  open_decision: boolean | "unknown";
}

const UNKNOWN_OUTCOME: ReadOutcome = {
  ticket: "unknown",
  attempts: "unknown",
  delivered_pr: "unknown",
  merged: "unknown",
  ended_without_merge: "unknown",
  open_decision: "unknown",
};

export function readOutcome(result: { outcome?: RunOutcome | null; pr?: string | null; result?: string } | null | undefined): ReadOutcome {
  const outcome = result?.outcome;
  if (!outcome) return { ...UNKNOWN_OUTCOME };
  return {
    ticket: outcome.ticket === null || typeof outcome.ticket === "number" ? outcome.ticket : "unknown",
    attempts: outcome.attempts === null || typeof outcome.attempts === "number" ? outcome.attempts : "unknown",
    delivered_pr: outcome.delivered_pr === null || typeof outcome.delivered_pr === "string" ? outcome.delivered_pr : "unknown",
    merged: outcome.merged === "no" || outcome.merged === "confirmed" || outcome.merged === "unknown" ? outcome.merged : "unknown",
    ended_without_merge: typeof outcome.ended_without_merge === "boolean" ? outcome.ended_without_merge : "unknown",
    open_decision: typeof outcome.open_decision === "boolean" ? outcome.open_decision : "unknown",
  };
}

/** Period counters. Attempts are summed; the other known fields count runs. An empty period is all zeros. */
export interface OutcomeCounts {
  tickets: number;
  tickets_unknown: number;
  attempts: number;
  attempts_unknown: number;
  delivered_prs: number;
  delivered_prs_unknown: number;
  confirmed_merges: number;
  merges_unknown: number;
  ended_without_merge: number;
  ended_without_merge_unknown: number;
  open_decisions: number;
  open_decisions_unknown: number;
}

export function emptyOutcomeCounts(): OutcomeCounts {
  return {
    tickets: 0,
    tickets_unknown: 0,
    attempts: 0,
    attempts_unknown: 0,
    delivered_prs: 0,
    delivered_prs_unknown: 0,
    confirmed_merges: 0,
    merges_unknown: 0,
    ended_without_merge: 0,
    ended_without_merge_unknown: 0,
    open_decisions: 0,
    open_decisions_unknown: 0,
  };
}

export function addOutcome(counts: OutcomeCounts, outcome: ReadOutcome): void {
  if (outcome.ticket === "unknown") counts.tickets_unknown++;
  else if (typeof outcome.ticket === "number") counts.tickets++;
  if (outcome.attempts === "unknown" || outcome.attempts === null) counts.attempts_unknown++;
  else counts.attempts += outcome.attempts;
  if (outcome.delivered_pr === "unknown") counts.delivered_prs_unknown++;
  else if (typeof outcome.delivered_pr === "string") counts.delivered_prs++;
  if (outcome.merged === "confirmed") counts.confirmed_merges++;
  else if (outcome.merged === "unknown") counts.merges_unknown++;
  if (outcome.ended_without_merge === "unknown") counts.ended_without_merge_unknown++;
  else if (outcome.ended_without_merge) counts.ended_without_merge++;
  if (outcome.open_decision === "unknown") counts.open_decisions_unknown++;
  else if (outcome.open_decision) counts.open_decisions++;
}

/** Queue row written when a coding run reaches `done`. That is not a confirmed merge. */
export interface QueueDelivery {
  merged: "no" | "confirmed" | "unknown";
  pr: string | null;
  attempts: number | null;
}

export function deliveryForDone(result: { pr: string | null; outcome?: { attempts: number | null } | null }): QueueDelivery {
  return { merged: "no", pr: result.pr, attempts: result.outcome?.attempts ?? null };
}

/** A queue entry stored before `delivery` is unknown, even when it is `done` and names a PR. */
export function readQueueDelivery(entry: { delivery?: Partial<QueueDelivery> | null; pr?: string; status?: string }): QueueDelivery {
  const delivery = entry.delivery;
  if (!delivery || (delivery.merged !== "no" && delivery.merged !== "confirmed" && delivery.merged !== "unknown")) {
    return { merged: "unknown", pr: null, attempts: null };
  }
  return {
    merged: delivery.merged,
    pr: typeof delivery.pr === "string" ? delivery.pr : null,
    attempts: typeof delivery.attempts === "number" ? delivery.attempts : null,
  };
}

/** Another attempt only when the checkpoint already stored a count. Legacy checkpoints stay unknown. */
export function nextAttempt(current: number | undefined): number | null {
  return typeof current === "number" ? current + 1 : null;
}

export const RECOVERY_NOTE = "Resumed the same run from the checkpoint plan. A coding result is not a confirmed merge.";

export interface RecoveryNote {
  previous_result: string | null;
  attempts: number | null;
  branch: string | null;
  checkpoint: string;
  plan_kept: true;
  note: string;
}

export function writeRecoveryNote(
  runDir: string,
  note: { previous_result: string | null; attempts: number | null; branch: string | null; checkpoint: string },
  secrets: string[],
): RecoveryNote {
  const full: RecoveryNote = { ...note, plan_kept: true, note: RECOVERY_NOTE };
  const text = redact(JSON.stringify(full, null, 2), secrets);
  writeFileSync(join(runDir, "recovery.json"), text + "\n");
  return JSON.parse(text) as RecoveryNote;
}

/** Last implementer model recorded on the run. A missing event stays `unknown`. */
export function implementModel(eventsJsonl: string): string {
  if (!existsSync(eventsJsonl)) return "unknown";
  let model = "unknown";
  for (const line of readFileSync(eventsJsonl, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; role?: string | null; model?: string | null };
      if ((event.event === "agent_finished" || event.event === "agent_error") && event.role === "implement" && event.model) model = event.model;
    } catch {
      // a torn last line of a killed run
    }
  }
  return model;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash of the repo config after secret values are removed. The hash is not reversible to those values. */
export function configFingerprint(repo: unknown, secrets: string[]): string {
  const text = redact(stableStringify(repo), secrets.filter((secret) => secret.length > 0));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Hash of each check command. Callers store the hash, not the command, because a command can carry a token. */
export function checkVersions(checks: { name: string; run: string }[]): { name: string; version: string }[] {
  return [...checks]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((check) => ({ name: check.name, version: createHash("sha256").update(check.run).digest("hex").slice(0, 16) }));
}

/** Short hash of the role prompts shipped with this package. Prompt text is not stored on the run. */
export function promptRevision(dir = fileURLToPath(new URL("../../roles/", import.meta.url))): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Package version and git commit. A tree without git stays `unknown` instead of a guessed commit. */
export function factoryIdentity(root = fileURLToPath(new URL("../..", import.meta.url))): { version: string; commit: string } {
  let version = "unknown";
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    if (parsed.version) version = parsed.version;
  } catch {
    // packaged without package.json: leave unknown
  }
  let commit = "unknown";
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) commit = sha;
  } catch {
    // no checkout: do not invent a commit
  }
  return { version, commit };
}

export function buildProvenance(input: {
  model: string;
  effort: string;
  repo: unknown;
  secrets: string[];
  base: string | null;
  head: string | null;
  checks: { name: string; run: string }[];
}): RunProvenance {
  const identity = factoryIdentity();
  return {
    factory_version: identity.version,
    factory_commit: identity.commit,
    prompt_revision: promptRevision(),
    model: input.model || "unknown",
    effort: input.effort || "unknown",
    config_fingerprint: configFingerprint(input.repo, input.secrets),
    base: input.base,
    head: input.head,
    checks: checkVersions(input.checks),
  };
}
