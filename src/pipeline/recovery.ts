import { formatterWriteCommand } from "../adopt/mutation.js";
import { sh } from "../exec.js";
import { headSha } from "../git.js";
import type { Check } from "../schemas/repo.js";
import { commandEnv, jailFor, type RunContext } from "./context.js";
import { failureSummary, type GateReport, runGates, withEnvCommand } from "../steps/gates.js";

/** Gate-repair budget for one run. Resume continues these numbers; it does not start them over. */
export const MAX_GATE_ATTEMPTS = 3;
/** Post-push repair/revalidation attempts, shared by the worker and persisted resume path. */
export const MAX_CONTINUATIONS = 2;

export type RepairClass = "format" | "code" | "infra" | "base" | "config" | "unknown";

export interface RepairBudget {
  gateAttempts: number;
  /** Same-model network retries already spent. Shared across calls in this run. */
  network: { n: number };
  formatUsed: boolean;
  infraReruns: number;
  /** Last diagnosed class. A blocking class is not handed to the implementer again. */
  lastClass?: RepairClass;
}

export interface StoredRepair {
  gate_attempts: number;
  network_retries: number;
  format_used: boolean;
  infra_reruns: number;
  class?: RepairClass;
}

export function emptyBudget(): RepairBudget {
  return { gateAttempts: 0, network: { n: 0 }, formatUsed: false, infraReruns: 0 };
}

export function budgetFrom(raw: StoredRepair | undefined): RepairBudget {
  return {
    gateAttempts: raw?.gate_attempts ?? 0,
    network: { n: raw?.network_retries ?? 0 },
    formatUsed: raw?.format_used ?? false,
    infraReruns: raw?.infra_reruns ?? 0,
    ...(raw?.class ? { lastClass: raw.class } : {}),
  };
}

export function budgetTo(b: RepairBudget): StoredRepair {
  return {
    gate_attempts: b.gateAttempts,
    network_retries: b.network.n,
    format_used: b.formatUsed,
    infra_reruns: b.infraReruns,
    ...(b.lastClass ? { class: b.lastClass } : {}),
  };
}

export function clearRepair(budget: RepairBudget): void {
  budget.gateAttempts = 0;
  budget.formatUsed = false;
  budget.infraReruns = 0;
  delete budget.lastClass;
}

/** A class the implementer must not "fix" by editing product code. */
export function blocksProductEdit(cls: RepairClass | undefined): boolean {
  return cls === "unknown" || cls === "config" || cls === "infra" || cls === "base";
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

/** What to do before spending another implementer turn. */
export function repairDecision(cls: RepairClass, budget: Pick<RepairBudget, "formatUsed" | "infraReruns">): "format" | "rerun" | "stop" | "fix" {
  if (cls === "format" && !budget.formatUsed) return "format";
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

export function repairHandover(v: { cls: RepairClass; attempts: number; max: number; diagnosis: string; checkpoint: string; next: string }): string {
  const diagnosis = v.diagnosis.replace(/\s+/g, " ").trim().slice(0, 400) || "(none)";
  return [`repair exhausted: class=${v.cls} attempts=${v.attempts}/${v.max} checkpoint=${v.checkpoint}`, `diagnosis: ${diagnosis}`, `next: ${v.next}`].join("\n");
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
    max: MAX_GATE_ATTEMPTS,
    diagnosis: failureSummary(report),
    checkpoint: await checkpoint(ctx),
    next: nextStep(cls),
  });
}

export type Recovery = { action: "green"; gates: GateReport } | { action: "retry"; gates: GateReport } | { action: "stop"; gates: GateReport; reason: string };

/**
 * One mechanical format attempt, then at most one infrastructure rerun, then either a counted
 * fix turn or a stop. A stop for an unknown, config, infra or base failure does not ask the
 * implementer to edit product code.
 */
export async function recoverRedGates(
  ctx: RunContext,
  report: GateReport,
  opts: { tier: "fast" | "full"; packages: string[]; spend: boolean },
): Promise<Recovery> {
  const budget = ensureBudget(ctx);
  let current = report;
  if (!budget.formatUsed && hasFormatterFailure(current, ctx.repo.checks)) {
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
    return { action: "stop", gates: current, reason: await explain(ctx, cls, budget, current) };
  }
  if (!opts.spend) {
    ctx.persist?.();
    if (budget.gateAttempts >= MAX_GATE_ATTEMPTS) {
      return { action: "stop", gates: current, reason: await explain(ctx, cls, budget, current) };
    }
    return { action: "retry", gates: current };
  }
  budget.gateAttempts += 1;
  ctx.persist?.();
  if (budget.gateAttempts >= MAX_GATE_ATTEMPTS) {
    return { action: "stop", gates: current, reason: await explain(ctx, cls, budget, current) };
  }
  return { action: "retry", gates: current };
}

export function ensureBudget(ctx: { budget?: RepairBudget }): RepairBudget {
  if (!ctx.budget) ctx.budget = emptyBudget();
  return ctx.budget;
}

/** Resume of a blocking class must not call the implementer. Undefined when a fix turn is allowed. */
export async function blockedRepairReason(ctx: RunContext): Promise<string | undefined> {
  const budget = ctx.budget;
  if (!budget?.lastClass || !blocksProductEdit(budget.lastClass)) return undefined;
  return repairHandover({
    cls: budget.lastClass,
    attempts: budget.gateAttempts,
    max: MAX_GATE_ATTEMPTS,
    diagnosis: "persisted failure class; product code was not edited",
    checkpoint: await checkpoint(ctx),
    next: nextStep(budget.lastClass),
  });
}
