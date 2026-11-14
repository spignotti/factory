import { createHash } from "node:crypto";
import { commandParts, formatterWriteCommand } from "../adopt/mutation.js";
import { sh } from "../exec.js";
import { changedFiles, diffText, headSha } from "../git.js";
import { addedSuppressions } from "../gates/config-guard.js";
import { asData } from "../prompts.js";
import type { Check } from "../schemas/repo.js";
import type { StopCause } from "../events.js";
import { checkDeadline, commandEnv, jailFor, type RunContext } from "./context.js";
import { failureSummary, type GateReport, runGates, withEnvCommand } from "../steps/gates.js";

/** Gate-repair budget for one run. Resume continues these numbers; it does not start them over. */
export const MAX_GATE_ATTEMPTS = 3;
/** Post-push repair/revalidation attempts, shared by the worker and persisted resume path. */
export const MAX_CONTINUATIONS = 2;

/** An operator grant adds exactly one attempt. Any other stored value is not an allowance. */
export function grantedExtra(extra: number | undefined): number {
  return extra === 1 ? 1 : 0;
}

export function gateLimit(extra: number | undefined): number {
  return MAX_GATE_ATTEMPTS + grantedExtra(extra);
}

export function continuationLimit(extra: number | undefined): number {
  return MAX_CONTINUATIONS + grantedExtra(extra);
}

export type RepairClass = "format" | "code" | "infra" | "base" | "config" | "unknown";

/** One failing check that defines the root failure: its name, diagnostic codes, and highest severity word. */
export interface FailureRoot {
  name: string;
  codes: string[];
  severity?: "error" | "warning" | "note" | "style" | "info";
}

/**
 * Identity of one root failure (#181): a fingerprint of the failing checks, their diagnostic codes and
 * ordered semantic values, plus the code checkpoint it was last seen on and how many observations in a
 * row showed exactly this fingerprint. Reworded prose is not identity. Swapped values are. `roots` is
 * what resume re-runs before the next turn, and what a later green report may not drop.
 */
export interface FailureIdentity {
  signature: string;
  checkpoint: string;
  unchanged: number;
  roots: FailureRoot[];
}

export type RepairStrategy = "repeat" | "diagnose";

/** Same fingerprint at this many observations in a row: repeating the prompt has not helped, change strategy. */
export const STRATEGY_ESCALATE_AT = 2;

/**
 * The escalated strategy. The factory has already run the failing check; the prompt carries that output.
 * A sentence alone is not the escalation.
 */
export const DIAGNOSTIC_STEP =
  "Unchanged failure since the previous attempt. The failing check was run again; its output is in failing_check. Do not repeat the same edit, do not lower the finding's severity, do not suppress or drop the check. Name the root cause (file, line, why it fails) before changing product code, then fix that root cause in every occurrence.";

export interface RepairBudget {
  gateAttempts: number;
  /** Same-model network retries already spent. Shared across calls in this run. */
  network: { n: number };
  formatUsed: boolean;
  infraReruns: number;
  /** Completed out-of-scope removals in this run. Never reset by a green commit: it bounds the run. */
  scopeRepairs: number;
  /** Fingerprint of the deviation set the last repair removed. The same set again is an unchanged failure. */
  scopeLast?: string;
  /** Last diagnosed class. A blocking class is not handed to the implementer again. */
  lastClass?: RepairClass;
  /** Failure identity of the last observed red gate; the basis for strategy escalation (#181). */
  failure?: FailureIdentity;
  /**
   * One extra gate repair from an operator grant (#188). Only `1` counts. Spent `gateAttempts` stay.
   * Cleared once that extra attempt has been spent, and by a successful repair.
   */
  gateExtra?: number;
}

export interface StoredRepair {
  gate_attempts: number;
  network_retries: number;
  format_used: boolean;
  infra_reruns: number;
  scope_repairs?: number;
  scope_last?: string;
  class?: RepairClass;
  failure?: FailureIdentity;
  /** Remaining operator grant (#188). Only `1` is an allowance; absent or any other value is none. */
  gate_extra?: number;
}

export function emptyBudget(): RepairBudget {
  return { gateAttempts: 0, network: { n: 0 }, formatUsed: false, infraReruns: 0, scopeRepairs: 0 };
}

export function budgetFrom(raw: StoredRepair | undefined): RepairBudget {
  return {
    gateAttempts: raw?.gate_attempts ?? 0,
    network: { n: raw?.network_retries ?? 0 },
    formatUsed: raw?.format_used ?? false,
    infraReruns: raw?.infra_reruns ?? 0,
    scopeRepairs: raw?.scope_repairs ?? 0,
    ...(raw?.scope_last !== undefined ? { scopeLast: raw.scope_last } : {}),
    ...(raw?.class ? { lastClass: raw.class } : {}),
    ...(raw?.failure ? { failure: { ...raw.failure, roots: raw.failure.roots ?? [] } } : {}),
    ...(raw?.gate_extra === 1 ? { gateExtra: 1 as const } : {}),
  };
}

export function budgetTo(b: RepairBudget): StoredRepair {
  return {
    gate_attempts: b.gateAttempts,
    network_retries: b.network.n,
    format_used: b.formatUsed,
    infra_reruns: b.infraReruns,
    ...(b.scopeRepairs ? { scope_repairs: b.scopeRepairs } : {}),
    ...(b.scopeLast !== undefined ? { scope_last: b.scopeLast } : {}),
    ...(b.lastClass ? { class: b.lastClass } : {}),
    ...(b.failure ? { failure: { ...b.failure } } : {}),
    ...(b.gateExtra === 1 ? { gate_extra: 1 as const } : {}),
  };
}

export function clearRepair(budget: RepairBudget): void {
  budget.gateAttempts = 0;
  budget.formatUsed = false;
  budget.infraReruns = 0;
  delete budget.lastClass;
  delete budget.failure;
  delete budget.gateExtra;
  // scopeRepairs and scopeLast stay: a green commit elsewhere does not re-grant out-of-scope removals.
}

/** A class the implementer must not "fix" by editing product code. */
export function blocksProductEdit(cls: RepairClass | undefined): boolean {
  return cls === "unknown" || cls === "config" || cls === "infra" || cls === "base";
}

/**
 * What the stored stop cause says about a diagnosed failure class: config and base need a human
 * decision or approval, infra is retried without a product edit, unknown fails closed, format and
 * code are mechanical repair. Spent fix-class budgets are `budget_exhausted`, not `technical_repair`.
 */
export function stopCauseForClass(cls: RepairClass): StopCause {
  switch (cls) {
    case "config":
    case "base":
      return "human_approval";
    case "infra":
      return "transient_retry";
    case "unknown":
      return "unknown";
    case "format":
    case "code":
      return "technical_repair";
  }
}

const CODE = /\bSyntaxError\b|\bAssertionError\b|\bTypeError\b|\bReferenceError\b|not ok \d|✖|ERR_ASSERT|Assertion failed|\bExpected\b|^FAILED\s+\S+::/im;
const CONFIG = /command not found|EnvMissing|configuration file not found|config file not found|not recognized as an internal or external command/i;
const INFRA = /runner has received a shutdown signal|No space left on device|Resource temporarily unavailable|\bETIMEDOUT\b|\bECONNRESET\b|\bEAI_AGAIN\b|TLS handshake|temporary failure in name resolution|\b502 Bad Gateway\b|\b503 Service Unavailable\b/i;

function checkCommand(checks: Pick<Check, "name" | "run">[], name: string): string {
  return checks.find((c) => c.name === name)?.run ?? "";
}

function classifyOne(
  check: { name: string; kind?: string; status: string; output_tail: string },
  checks: Pick<Check, "name" | "run">[],
): RepairClass {
  const tail = check.output_tail ?? "";
  if (check.kind === "builtin") {
    if (check.status === "timeout") return "infra";
    if (CONFIG.test(tail)) return "config";
    return "code";
  }
  if (CONFIG.test(tail)) return "config";
  if (formatterWriteCommand(checkCommand(checks, check.name))) return "format";
  if (CODE.test(tail)) return "code";
  if (check.status === "timeout" || INFRA.test(tail)) return "infra";
  return "unknown";
}

/**
 * What a red gate or CI check is. `onBase` is for a failure of the base commit itself
 * (the caller already knows that); the other classes are read from the check command and its output.
 */
export function classifyRepair(
  report: { checks: { name: string; kind?: string; status: string; output_tail: string }[] },
  checks: Pick<Check, "name" | "run">[],
  opts?: { onBase?: boolean },
): RepairClass {
  if (opts?.onBase) return "base";
  const red = report.checks.filter((c) => c.status === "fail" || c.status === "timeout");
  if (!red.length) return "code";
  const classes = red.map((c) => classifyOne(c, checks));
  if (classes.every((c) => c === "format")) return "format";
  if (classes.some((c) => c === "code")) return "code";
  if (classes.some((c) => c === "unknown")) return "unknown";
  if (classes.some((c) => c === "config")) return "config";
  if (classes.some((c) => c === "infra")) return "infra";
  return "unknown";
}

const DIAGNOSTIC_CODE = /\b[Ss][Cc]\d{3,4}\b|\b[Tt][Ss]\d{3,5}\b|\b[A-Z]{1,6}\d{3,5}\b/g;
const SEVERITY_RANK = { error: 4, warning: 3, note: 2, style: 2, info: 1 } as const;
const INTERPRETERS = new Set(["node", "nodejs", "npm", "pnpm", "yarn", "npx", "python", "python3", "pytest", "bash", "sh", "cargo", "go", "make", "ruby", "deno", "bun"]);

/** Diagnostic codes in a report (`SC2166`, `TS2345`, `E501`). Prose around them is not identity. */
export function diagnosticCodes(text: string): string[] {
  return [...new Set((text.match(DIAGNOSTIC_CODE) ?? []).map((code) => code.toLowerCase()))].sort();
}

function stripNoise(text: string): string {
  return text
    .replace(/\b\d{4}-\d\d-\d\d([tT ]\d\d:\d\d(:\d\d)?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d\d(:\d\d)?\b/g, " ")
    .replace(/(?<![\w.])[0-9a-fA-F]{7,}(?![\w.])/g, " ")
    .replace(/\b(?:duration(?:_ms)?|elapsed|time)\b\s*[:=]?\s*\d+(?:[.,]\d+)?/gi, " ")
    .replace(/\b\d+[.,]\d{3,}\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?(?:ms|seconds?|minutes?|kb|mb|gb|bytes?|x)\b/gi, " ")
    .replace(/(:\d+)+(?=$|[^\w])/g, " ")
    .replace(/\b(?:lines?|cols?|columns?)\s+\d+\b/gi, " ")
    .replace(/((?:[\w.-]+\/)+[\w.-]+)\(\d+,\s*\d+\)/g, "$1");
}

/** Numbers that distinguish a failure, in order. Line, column, pid and timestamp noise is already gone. */
function semanticValues(text: string): string[] {
  return stripNoise(text).match(/(?<![\w.])\d+(?:[.,]\d+)?(?![\w.])/g) ?? [];
}

const DIAGNOSTIC_FILE = String.raw`(?:\.{1,2}/)?(?:[\w.-]+/)+[\w.-]+`;

/** Subject files a diagnostic names. `./` is not a different file. A path mentioned only in prose is not identity. */
function diagnosticPaths(text: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const path = raw.replace(/^\.\//, "");
    if (!path || path === "." || path.includes("://") || !path.includes("/")) return;
    found.add(path);
  };
  const file = DIAGNOSTIC_FILE;
  for (const match of text.matchAll(new RegExp(String.raw`(^|[\s:"'(])(${file}):\d+`, "g"))) add(match[2]!);
  for (const match of text.matchAll(new RegExp(String.raw`\bIn\s+(${file})(?::\d+|\s+line\s+\d+)`, "gi"))) add(match[1]!);
  for (const match of text.matchAll(new RegExp(String.raw`(^|[\s:"'(])(${file})\(\d+,\s*\d+\)`, "g"))) add(match[2]!);
  for (const match of text.matchAll(/["']file["']\s*[:=]\s*["']([^"']+)["']/gi)) add(match[1]!);
  return [...found].sort();
}

/**
 * Identity text of one diagnostic. A code-bearing finding (ShellCheck, tsc, ruff) is its codes,
 * subject file paths and ordered values, so a reworded message of the same finding matches.
 * Without a code, words stay in order and values are not blanked or sorted: `expected 1 … 2` is not `expected 2 … 1`.
 */
export function diagnosticIdentity(text: string): string {
  const codes = diagnosticCodes(text);
  const values = semanticValues(text);
  if (!codes.length) return stripNoise(text).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const paths = diagnosticPaths(text);
  return `codes=${codes.join(",")} values=${values.join(",")}${paths.length ? ` paths=${paths.join(",")}` : ""}`;
}

function highestSeverity(text: string): FailureRoot["severity"] | undefined {
  let best: { name: NonNullable<FailureRoot["severity"]>; rank: number } | undefined;
  for (const match of text.matchAll(/\b(error|warning|note|style|info)\b/gi)) {
    const name = match[1]!.toLowerCase() as NonNullable<FailureRoot["severity"]>;
    const rank = SEVERITY_RANK[name];
    if (!best || rank > best.rank) best = { name, rank };
  }
  return best?.name;
}

/** Root checks of a red report: name, diagnostic codes, highest severity. `repair_hold` is not a root. */
export function failureRoots(report: { checks: { name: string; status: string; output_tail?: string }[] }): FailureRoot[] {
  return report.checks
    .filter((c) => (c.status === "fail" || c.status === "timeout") && c.name !== "repair_hold")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => {
      const tail = c.output_tail ?? "";
      const severity = highestSeverity(tail);
      return { name: c.name, codes: diagnosticCodes(tail), ...(severity ? { severity } : {}) };
    });
}

/**
 * Fingerprint of the failing checks (#181). The check name is the root-check identity. Diagnostic
 * codes survive rewording. Ordered semantic values keep swapped results apart. Hashed so the
 * persisted state stays short.
 */
export function failureSignature(report: { checks: { name: string; status: string; output_tail: string }[] }): string {
  const parts = report.checks
    .filter((c) => (c.status === "fail" || c.status === "timeout") && c.name !== "repair_hold")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => `${c.name}|${c.status}|${diagnosticIdentity(c.output_tail ?? "")}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

/**
 * Record one observation of a red gate against the budget: the same fingerprint keeps counting up
 * (the checkpoint may move — the failure did not), a new fingerprint restarts at 1. Roots travel
 * with the fingerprint so resume can re-run those checks. Returns the stored identity.
 */
export function recordFailure(budget: RepairBudget, signature: string, checkpoint: string, roots: FailureRoot[] = []): FailureIdentity {
  const last = budget.failure;
  const kept = roots.length ? roots : last?.signature === signature ? last.roots : [];
  const identity: FailureIdentity =
    last && last.signature === signature
      ? { signature, checkpoint, unchanged: last.unchanged + 1, roots: kept }
      : { signature, checkpoint, unchanged: 1, roots: kept };
  budget.failure = identity;
  return identity;
}

/** What the next repair turn must do: the same prompt, or the documented diagnostic strategy (#181). */
export function repairStrategy(budget: Pick<RepairBudget, "failure">): RepairStrategy {
  return (budget.failure?.unchanged ?? 0) >= STRATEGY_ESCALATE_AT ? "diagnose" : "repeat";
}

/** What to do before spending another implementer turn. A repeated unchanged failure never just repeats the format fix. */
export function repairDecision(
  cls: RepairClass,
  budget: Pick<RepairBudget, "formatUsed" | "infraReruns" | "failure">,
): "format" | "rerun" | "stop" | "fix" {
  if (cls === "format" && !budget.formatUsed && repairStrategy(budget) === "repeat") return "format";
  if (cls === "infra" && budget.infraReruns < 1) return "rerun";
  if (blocksProductEdit(cls)) return "stop";
  return "fix";
}

export function nextStep(cls: RepairClass): string {
  switch (cls) {
    case "unknown":
      return "Read the external state and answer it. Factory did not change product code for this failure.";
    case "config":
      return "Install or configure the missing tool, then factory resume. Factory did not invent product code.";
    case "infra":
      return "Rerun the failed check once the runner is healthy. Do not cancel and rerun in a loop.";
    case "base":
      return "Fix the base outside this head. Do not patch the product to hide a base failure.";
    default:
      return "Fix the failing checks on this branch, then factory resume. Do not open a new plan or a second pull request.";
  }
}

export function repairHandover(v: {
  cls: RepairClass;
  attempts: number;
  max: number;
  diagnosis: string;
  checkpoint: string;
  next: string;
  failure?: { signature: string; unchanged: number };
}): string {
  const diagnosis = v.diagnosis.replace(/\s+/g, " ").trim().slice(0, 400) || "(none)";
  const failure = v.failure ? ` failure=${v.failure.signature} unchanged=${v.failure.unchanged}` : "";
  return [`repair exhausted: class=${v.cls} attempts=${v.attempts}/${v.max} checkpoint=${v.checkpoint}${failure}`, `diagnosis: ${diagnosis}`, `next: ${v.next}`].join("\n");
}

function redChecks(report: GateReport): GateReport["checks"] {
  return report.checks.filter((c) => c.status === "fail" || c.status === "timeout");
}

export function formatterCommands(report: GateReport, checks: Pick<Check, "name" | "run">[]): string[] {
  const out: string[] = [];
  for (const c of redChecks(report)) {
    if (CONFIG.test(c.output_tail)) continue;
    const write = formatterWriteCommand(checkCommand(checks, c.name));
    if (write && !out.includes(write)) out.push(write);
  }
  return out;
}

export function hasFormatterFailure(report: GateReport, checks: Pick<Check, "name" | "run">[]): boolean {
  return formatterCommands(report, checks).length > 0;
}

/** Quotes the saved plan still requires, that the issue body no longer contains. */
export function missingPlanQuotes(body: string, plan: { packages: { source_quote?: string }[]; acceptance: { source_quote?: string }[] }): string[] {
  const quotes = [...plan.packages.map((p) => p.source_quote?.trim() ?? ""), ...plan.acceptance.map((a) => a.source_quote?.trim() ?? "")].filter(Boolean);
  return [...new Set(quotes.filter((q) => !body.includes(q)))];
}

/** When the stored PR is no longer the open PR for this branch, resume must not open another. */
export function openPrProblem(stored: string | null, open: { url: string } | null, branch: string): string | undefined {
  if (!stored) return undefined;
  if (!open || open.url !== stored) return `pull request ${stored} is not the open PR for ${branch}; not opening another`;
  return undefined;
}

async function runRepoCommand(ctx: RunContext, command: string): Promise<number> {
  const cap = ctx.repo.limits.gate_timeout_minutes * 60_000;
  const left = ctx.deadline.at - Date.now();
  const timeoutMs = Math.max(1000, Math.min(cap, left));
  const r = await sh(withEnvCommand(command, ctx.repo.env_command), {
    cwd: ctx.worktree,
    env: commandEnv(ctx),
    timeoutMs,
    jail: jailFor(ctx, ctx.worktree),
  });
  return r.code;
}

async function applyFormatters(ctx: RunContext, report: GateReport): Promise<boolean> {
  const commands = formatterCommands(report, ctx.repo.checks);
  if (!commands.length) return false;
  for (const command of commands) {
    if ((await runRepoCommand(ctx, command)) !== 0) return false;
  }
  return true;
}

async function checkpoint(ctx: RunContext): Promise<string> {
  try {
    return (await headSha(ctx.worktree)).slice(0, 12);
  } catch {
    return "unknown";
  }
}

async function explain(ctx: RunContext, cls: RepairClass, budget: RepairBudget, report: GateReport): Promise<string> {
  return repairHandover({
    cls,
    attempts: budget.gateAttempts,
    max: gateLimit(budget.gateExtra),
    diagnosis: failureSummary(report),
    checkpoint: await checkpoint(ctx),
    next: nextStep(cls),
    ...(budget.failure ? { failure: { signature: budget.failure.signature, unchanged: budget.failure.unchanged } } : {}),
  });
}

export type Recovery =
  | { action: "green"; gates: GateReport }
  | { action: "retry"; gates: GateReport; strategy: RepairStrategy }
  | { action: "stop"; gates: GateReport; reason: string; cause: StopCause };

/**
 * One mechanical format attempt, then at most one infrastructure rerun, then either a counted
 * fix turn or a stop. Every red observation is recorded as a failure identity: when the same
 * fingerprint comes back `STRATEGY_ESCALATE_AT` times, the retry strategy becomes `diagnose` — the
 * caller must send the focused diagnostic step instead of the same repair prompt.
 * A stop for an unknown, config, infra or base failure does not ask the implementer to edit product code.
 */
export async function recoverRedGates(
  ctx: RunContext,
  report: GateReport,
  opts: { tier: "fast" | "full"; packages: string[]; spend: boolean },
): Promise<Recovery> {
  const budget = ensureBudget(ctx);
  let current = report;
  // A held fake fix is the same unfixed failure. Do not reset the fingerprint because the check went green.
  const held = current.checks.some((c) => c.name === "repair_hold" && (c.status === "fail" || c.status === "timeout"));
  const signature = held && budget.failure ? budget.failure.signature : failureSignature(current);
  const roots = held && budget.failure?.roots.length ? budget.failure.roots : failureRoots(current);
  const identity = recordFailure(budget, signature, await checkpoint(ctx), roots);
  if (identity.unchanged === STRATEGY_ESCALATE_AT) {
    ctx.events.emit({ step: "gates", event: "progress", data: { repair: "strategy", strategy: "diagnose", failure: identity.signature, unchanged: identity.unchanged } });
  }
  ctx.persist?.();
  const strategy = repairStrategy(budget);
  if (strategy === "repeat" && !budget.formatUsed && hasFormatterFailure(current, ctx.repo.checks)) {
    const commands = formatterCommands(current, ctx.repo.checks);
    budget.formatUsed = true;
    budget.lastClass = "format";
    ctx.persist?.();
    ctx.events.emit({ step: "gates", event: "progress", data: { repair: "format", commands } });
    if (await applyFormatters(ctx, current)) {
      current = await runGates(ctx, opts.tier, opts.packages);
      if (current.green) return { action: "green", gates: current };
    }
  }
  let cls = classifyRepair(current, ctx.repo.checks);
  if (cls === "infra" && budget.infraReruns < 1) {
    budget.infraReruns += 1;
    budget.lastClass = "infra";
    ctx.persist?.();
    ctx.events.emit({ step: "gates", event: "progress", data: { repair: "infra_rerun" } });
    current = await runGates(ctx, opts.tier, opts.packages);
    if (current.green) return { action: "green", gates: current };
    cls = classifyRepair(current, ctx.repo.checks);
  }
  budget.lastClass = cls;
  if (blocksProductEdit(cls)) {
    budget.gateAttempts += 1;
    ctx.persist?.();
    return { action: "stop", gates: current, cause: stopCauseForClass(cls), reason: await explain(ctx, cls, budget, current) };
  }
  if (!opts.spend) {
    ctx.persist?.();
    if (budget.gateAttempts >= gateLimit(budget.gateExtra)) {
      return { action: "stop", gates: current, cause: "budget_exhausted", reason: await explain(ctx, cls, budget, current) };
    }
    return { action: "retry", gates: current, strategy };
  }
  budget.gateAttempts += 1;
  if (budget.gateAttempts > MAX_GATE_ATTEMPTS) budget.gateExtra = 0;
  ctx.persist?.();
  if (budget.gateAttempts >= gateLimit(budget.gateExtra)) {
    return { action: "stop", gates: current, cause: "budget_exhausted", reason: await explain(ctx, cls, budget, current) };
  }
  return { action: "retry", gates: current, strategy };
}

export function ensureBudget(ctx: { budget?: RepairBudget }): RepairBudget {
  if (!ctx.budget) ctx.budget = emptyBudget();
  return ctx.budget;
}

/**
 * Cause for a stop that comes out of the implement/fix machinery without its own diagnosis:
 * a blocking persisted class keeps its human/infra/unknown meaning, a spent gate budget is
 * exhausted, anything else stays a mechanical repair with the checkpoint kept.
 */
export function stopCauseForBudget(budget: Pick<RepairBudget, "gateAttempts" | "lastClass" | "gateExtra">): StopCause {
  if (budget.lastClass && blocksProductEdit(budget.lastClass)) return stopCauseForClass(budget.lastClass);
  if (budget.gateAttempts >= gateLimit(budget.gateExtra)) return "budget_exhausted";
  return "technical_repair";
}

/** Resume of a blocking class must not call the implementer. Undefined when a fix turn is allowed. */
export async function blockedRepairReason(ctx: RunContext): Promise<{ reason: string; cause: StopCause } | undefined> {
  const budget = ctx.budget;
  if (!budget?.lastClass || !blocksProductEdit(budget.lastClass)) return undefined;
  const reason = repairHandover({
    cls: budget.lastClass,
    attempts: budget.gateAttempts,
    max: gateLimit(budget.gateExtra),
    diagnosis: "persisted failure class; product code was not edited",
    checkpoint: await checkpoint(ctx),
    next: nextStep(budget.lastClass),
    ...(budget.failure ? { failure: { signature: budget.failure.signature, unchanged: budget.failure.unchanged } } : {}),
  });
  return { reason, cause: stopCauseForClass(budget.lastClass) };
}

const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
const SCRIPT_RUNNERS = new Set(["node", "nodejs", "python", "python3", "ruby", "deno", "bun"]);
const CHECK_MODE = new Set(["--check", "--test", "-c", "-e", "--eval", "-m"]);
const PACKAGE_ALIASES = new Set(["test", "t", "tst", "start", "stop", "restart"]);
const PACKAGE_SKIP = new Set(["exec", "dlx", "install", "add", "remove", "update", "ci", "publish", "pack", "link", "config", "outdated"]);

function commandBase(token: string): string {
  return token.split("/").pop() ?? token;
}

function repoPath(token: string): string {
  return token.replace(/^\.\//, "");
}

function isScriptPath(token: string): boolean {
  return !token.startsWith("-") && (token.includes("/") || token.startsWith(".") || /\.(?:sh|bash|js|mjs|cjs|py|rb)$/.test(token));
}

function shellScript(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      const next = args[i + 1];
      return next && isScriptPath(next) ? repoPath(next) : undefined;
    }
    if (arg === "-c" || arg === "-o") {
      const next = args[++i];
      if (arg === "-c" && next && isScriptPath(next)) return repoPath(next);
      continue;
    }
    if (arg.startsWith("-")) continue;
    return isScriptPath(arg) ? repoPath(arg) : undefined;
  }
  return undefined;
}

function packageManifest(exe: string, args: string[]): string | undefined {
  if (exe !== "npm" && exe !== "pnpm" && exe !== "yarn" && exe !== "bun") return undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (arg === "--prefix" || arg === "--dir" || arg === "-C") i++;
      continue;
    }
    positional.push(arg);
  }
  const sub = positional[0];
  if (!sub) return undefined;
  if (sub === "run" || sub === "run-script") return positional[1] ? "package.json" : undefined;
  if (exe === "bun" && sub === "test") return undefined;
  if (PACKAGE_SKIP.has(sub)) return undefined;
  if (PACKAGE_ALIASES.has(sub)) return "package.json";
  return undefined;
}

function runnerScript(args: string[]): string | undefined {
  if (args.some((arg) => CHECK_MODE.has(arg) || arg.startsWith("--check=") || arg.startsWith("--test="))) return undefined;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    return isScriptPath(arg) ? repoPath(arg) : undefined;
  }
  return undefined;
}

function implementationOf(argv: string[]): string | undefined {
  const first = argv[0];
  if (!first || first.startsWith("-")) return undefined;
  const exe = commandBase(first);
  if (SHELLS.has(exe)) return shellScript(argv.slice(1));
  const manifest = packageManifest(exe, argv.slice(1));
  if (manifest) return manifest;
  if (SCRIPT_RUNNERS.has(exe)) return runnerScript(argv.slice(1));
  if (!INTERPRETERS.has(exe) && (first.includes("/") || first.startsWith("."))) return repoPath(first);
  return undefined;
}

/** Repo paths a check command executes as its own implementation. Checker arguments (`node --check src/math.js`) are not included. */
export function gateImplementations(command: string): string[] {
  const out: string[] = [];
  for (const argv of commandParts(command)) {
    const path = implementationOf(argv);
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** First protected path of a check command, when it has one. */
export function gateImplementation(command: string): string | undefined {
  return gateImplementations(command)[0];
}

/**
 * Why a green-looking report is not a fix (#181). Undefined when the recorded roots are still in the
 * report and the diff did not suppress them, lower their severity, or alter the gate that runs them.
 */
export function fakeFixReason(input: {
  roots: FailureRoot[];
  reportNames: string[];
  diff: string;
  changed: string[];
  commands: { name: string; run: string }[];
}): string | undefined {
  if (!input.roots.length) return undefined;
  const have = new Set(input.reportNames);
  const dropped = input.roots.filter((root) => !have.has(root.name));
  if (dropped.length) return `dropped gate: ${dropped.map((root) => root.name).join(", ")} is not in the required gate set; not a fix`;
  const hits = addedSuppressions(input.diff);
  if (hits.length) {
    const codes = new Set(input.roots.flatMap((root) => root.codes));
    const targeted = hits.filter((hit) => [...codes].some((code) => hit.line.toLowerCase().includes(code)));
    const hit = targeted[0] ?? hits[0]!;
    return `suppression is not a fix: ${hit.file} ${hit.marker}`;
  }
  const added = input.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  for (const code of input.roots.flatMap((root) => root.codes)) {
    if (disablesCode(added, code)) return `severity reduced: ${code} disabled; not a fix`;
  }
  if (SEVERITY_BYPASS.test(added)) return "severity reduced; not a fix";
  const changed = new Set(input.changed);
  for (const root of input.roots) {
    const command = input.commands.find((check) => check.name === root.name)?.run ?? "";
    for (const impl of gateImplementations(command)) {
      if (changed.has(impl)) return `gate ${root.name} altered (${impl}); not a fix`;
    }
  }
  return undefined;
}

const SEVERITY_WORD = "error|warning|info|style|note";
const SEVERITY_BYPASS = new RegExp(`(?:^|[^\\w-])(?:-S(?:=|\\s*)?|--severity(?:=|\\s+)|severity\\s*[:=]\\s*)(?:${SEVERITY_WORD})\\b`, "i");

/** A disable/exclude list that names `code`, including `disable=SC2086,SC2166` and `-eSC2166`. */
function disablesCode(added: string, code: string): boolean {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const list = "(?:[A-Za-z]{1,6}\\d{3,5}\\s*,\\s*)*";
  const flag = new RegExp(`(?:^|[^\\w-])(?:--exclude|-e)(?:=|\\s+)?${list}${escaped}\\b`, "i");
  const key = new RegExp(`(?:^|[^\\w-])(?:disable|exclude)\\s*[:=]\\s*${list}${escaped}\\b`, "i");
  return flag.test(added) || key.test(added);
}

/** Missing or red members of the gate set that must pass before approval. */
export function approvalGateGap(input: { required: string[]; report: { name: string; status: string }[] }): string | undefined {
  const have = new Map(input.report.map((check) => [check.name, check.status]));
  const required = [...new Set(input.required)];
  const missing = required.filter((name) => !have.has(name));
  if (missing.length) return `required gate set incomplete: ${missing.join(", ")}; not approving`;
  const red = required.filter((name) => have.get(name) === "fail" || have.get(name) === "timeout");
  if (red.length) return `required gates red: ${red.join(", ")}; not approving`;
  return undefined;
}

function markHeld(report: GateReport, reason: string): GateReport {
  if (report.checks.some((c) => c.name === "repair_hold" && c.status === "fail")) return { ...report, green: false };
  return {
    ...report,
    green: false,
    checks: [...report.checks, { name: "repair_hold", kind: "builtin", status: "fail", duration_ms: 0, output_tail: reason }],
  };
}

/**
 * A green report after a recorded failure is not success when the fix is a suppression, a severity
 * reduction, a dropped gate, or an altered check script. The report stays red so approval cannot
 * proceed, and the previous fingerprint is kept by `recoverRedGates`.
 */
export async function holdUnfixed(ctx: RunContext, report: GateReport): Promise<GateReport> {
  const roots = ctx.budget?.failure?.roots ?? [];
  if (!roots.length) return report;
  let diff: string;
  let changed: string[];
  try {
    diff = await diffText(ctx.worktree, ctx.baseSha);
    changed = await changedFiles(ctx.worktree, ctx.baseSha);
  } catch {
    if (report.green) return markHeld(report, "could not read the diff; not a fix");
    return report;
  }
  const reason = fakeFixReason({
    roots,
    reportNames: report.checks.map((check) => check.name),
    diff,
    changed,
    commands: ctx.repo.checks.map((check) => ({ name: check.name, run: check.run })),
  });
  return reason ? markHeld(report, reason) : report;
}

async function executeFailingChecks(ctx: RunContext, names: string[]): Promise<{ name: string; code: number; output: string }[]> {
  const out: { name: string; code: number; output: string }[] = [];
  for (const name of [...new Set(names)]) {
    const command = checkCommand(ctx.repo.checks, name);
    if (!command) {
      out.push({ name, code: 127, output: `check ${name} has no command` });
      continue;
    }
    checkDeadline(ctx);
    const cap = ctx.repo.limits.gate_timeout_minutes * 60_000;
    const left = ctx.deadline.at - Date.now();
    const timeoutMs = Math.max(1000, Math.min(cap, left));
    const result = await sh(withEnvCommand(command, ctx.repo.env_command), {
      cwd: ctx.worktree,
      env: commandEnv(ctx),
      timeoutMs,
      jail: jailFor(ctx, ctx.worktree),
    });
    out.push({ name, code: result.code, output: result.output });
  }
  return out;
}

/**
 * Prompt prefix for an already escalated failure. Runs the recorded failing checks and includes
 * their full output. Empty when the persisted strategy is still `repeat`.
 */
export async function diagnosticPrefix(ctx: RunContext): Promise<string> {
  const budget = ensureBudget(ctx);
  if (repairStrategy(budget) !== "diagnose") return "";
  const names = (budget.failure?.roots ?? []).map((root) => root.name);
  const focused = await executeFailingChecks(ctx, names);
  ctx.events.emit({
    step: "gates",
    event: "progress",
    data: { repair: "diagnose", executed: focused.length > 0, checks: focused.map((check) => check.name) },
  });
  const body = focused.length
    ? focused.map((check) => `### ${check.name} (exit ${check.code})\n${check.output.trimEnd() || "(no output)"}`).join("\n\n")
    : "(no failing check command recorded)";
  return `${DIAGNOSTIC_STEP}\n\n${asData("failing_check", body)}`;
}

/** Applies the persisted diagnostic strategy before an implement or fix turn. Does not spend a gate attempt. */
export async function withDiagnosticStrategy(ctx: RunContext, prompt: string): Promise<string> {
  const prefix = await diagnosticPrefix(ctx);
  if (!prefix || prompt.includes("<failing_check>")) return prompt;
  return `${prefix}\n\n${prompt}`;
}
