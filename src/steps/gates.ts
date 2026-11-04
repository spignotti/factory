import { sh, tail } from "../exec.js";
import { changedFiles, diffCountFields, diffTotals, repoDiffStat, stageAll } from "../git.js";
import {
  type BuiltinResult,
  diffSize,
  evidenceCheck,
  forbiddenPaths,
  guideUpdate,
  protectedPaths,
  reproFiles,
  scopeReport,
  testPresence,
} from "../gates/builtin.js";
import { configGuard, configGuardInputs } from "../gates/config-guard.js";
import { runBaselineGates } from "../baseline/gates.js";
import { redGreenProof } from "../gates/redgreen.js";
import { RED_GREEN_NEEDS_REASON, redGreenDecision, redGreenExemptDetail } from "../schemas/plan.js";
import { selectChecks } from "../gates/select.js";
import { gateCheckTimeoutMs, shTimedOut, watchCheck, type CheckPulse } from "../gates/timeout.js";
import { resolveToolchains } from "../toolchains.js";
import { topoOrder } from "../pipeline/dag.js";
import type { Deadline } from "../pipeline/budget.js";
import { checkDeadline, commandEnv, jailFor, type RunContext, writeJson } from "../pipeline/context.js";
import type { Jail } from "../sandbox/sandbox.js";
import { EnvMissing, type Services } from "../services.js";
import type { Check, Tier } from "../schemas/repo.js";

export interface CheckResult {
  name: string;
  kind: "check" | "builtin";
  status: "pass" | "fail" | "flaky" | "timeout";
  duration_ms: number;
  output_tail: string;
  timed_out?: boolean;
}

export interface GateReport {
  n: number;
  tier: Tier;
  green: boolean;
  changed_files: string[];
  checks: CheckResult[];
  scope_report: string[];
  /** Bug plans: whether the repro test fails on base (false = it does not reproduce the bug). */
  repro_red_on_base?: boolean;
}

export function withEnvCommand(run: string, envCommand: string): string {
  return envCommand ? `${envCommand} ${run}` : run;
}

/**
 * Runs checks; a red check is re-run once and counts as flaky (not a blocker) when it turns green.
 * A check with `services` starts them first (EnvMissing when one does not come up), gets their
 * env and, jailed, reaches exactly their ports.
 */
export async function runChecks(
  checks: Check[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    envCommand: string;
    gateTimeoutMinutes: number;
    deadline?: Deadline;
    jail?: Jail;
    services?: Services;
    /** Progress and heartbeat while a check command is running. */
    onCheck?: (e: CheckPulse) => void;
    heartbeatMs?: number;
  },
): Promise<CheckResult[]> {
  const timeoutMs = (check: Check) => gateCheckTimeoutMs({ check, gateTimeoutMinutes: opts.gateTimeoutMinutes, deadline: opts.deadline });
  const results: CheckResult[] = [];
  const spawnCheck = (check: Check, command: string, env: Record<string, string>, jail: Jail | undefined) =>
    watchCheck(check.name, () => sh(command, { cwd: opts.cwd, env, timeoutMs: timeoutMs(check), jail }), {
      onCheck: opts.onCheck,
      heartbeatMs: opts.heartbeatMs,
    });
  for (const check of checks) {
    const needs = check.services ?? [];
    let env = opts.env;
    let jail = opts.jail;
    let command = check.run;
    if (opts.services) {
      await opts.services.ensure(needs);
      env = { ...env, ...(await opts.services.envOf(needs)) };
      if (jail && needs.length) jail = { ...jail, ports: { reach: opts.services.reachOf(needs) } };
      command = await opts.services.expand(command);
    } else if (needs.length) {
      throw new EnvMissing(`check ${check.name} needs services ${needs.join(", ")} but none are configured for this call`);
    }
    const cmd = withEnvCommand(command, opts.envCommand);
    let r = await spawnCheck(check, cmd, env, jail);
    // Timeout wins over exit 0: a kill that races a clean exit is still a timeout, not a pass.
    let status: CheckResult["status"] = shTimedOut(r) ? "timeout" : r.code === 0 ? "pass" : "fail";
    if (status === "fail") {
      const again = await spawnCheck(check, cmd, env, jail);
      if (shTimedOut(again)) {
        r = again;
        status = "timeout";
      } else if (again.code === 0) status = "flaky";
      else {
        r = again;
        status = "fail";
      }
    }
    const timed_out = status === "timeout";
    results.push({
      name: check.name,
      kind: "check",
      status,
      duration_ms: r.durationMs,
      output_tail: status === "pass" ? "" : tail(r.output),
      ...(timed_out ? { timed_out: true } : {}),
    });
  }
  return results;
}

const fromBuiltin = (b: BuiltinResult): CheckResult => ({
  name: b.name,
  kind: "builtin",
  status: b.timedOut ? "timeout" : b.ok ? "pass" : "fail",
  duration_ms: 0,
  output_tail: b.detail,
  ...(b.timedOut ? { timed_out: true } : {}),
});

/** First line of a gate detail the PR body should show (skipped scanners, red-green exemption). */
export function visibleGateDetail(output: string): string {
  const head = output.split("\n")[0]?.trim() ?? "";
  if (head.startsWith("SKIPPED") || head.startsWith("EXEMPT") || head.startsWith("loosening:")) return head;
  return "";
}

/** Fast checks on a base commit: a timeout is inconclusive, a real failure is `base_red`. */
export function baseCheckOutcome(results: CheckResult[]): { result: "base_red" | "needs_human"; reason: string } | undefined {
  const timed = results.filter((r) => r.status === "timeout").map((r) => r.name);
  if (timed.length) return { result: "needs_human", reason: `fast checks timed out on base (inconclusive): ${timed.join(", ")}` };
  const red = results.filter((r) => r.status === "fail").map((r) => r.name);
  if (red.length) return { result: "base_red", reason: `fast checks red on base: ${red.join(", ")}` };
  return undefined;
}

/** Stored on the package when a gate attempt does not go green. A timeout is not called red. */
export function gateAttemptReason(attempt: number, report: GateReport): string {
  const timed = report.checks.filter((c) => c.status === "timeout").map((c) => c.name);
  if (timed.length) return `gates timed out after ${attempt} attempt(s) (inconclusive): ${timed.join(", ")}`;
  return `fast gates red after ${attempt} attempt(s)`;
}

/** Pipeline gates: selected repo checks plus built-in checks over the packages done so far. */
export async function runGates(ctx: RunContext, tier: Exclude<Tier, "manual">, packages: string[]): Promise<GateReport> {
  const { repo, plan, worktree, handoffs } = ctx;
  await stageAll(worktree);
  const changed = await changedFiles(worktree, ctx.baseSha);
  // Checks and red-green tests get the repo secrets; agents never do.
  const env = commandEnv(ctx);
  // Out of time: stop here instead of running every check with a 1 s timeout and reporting the
  // kills as red checks (run 20261030-164929-9ca1f6, gates-2: shellcheck and run-all "timed out after 1s").
  checkDeadline(ctx);
  const onCheck = (e: CheckPulse) =>
    ctx.events.emit({
      step: "gates",
      event: e.event,
      data: { check: e.check, phase: "running", ...(e.where ? { where: e.where } : {}) },
    });
  const checks = await runChecks(selectChecks(repo.checks, tier, changed), {
    cwd: worktree,
    env,
    envCommand: repo.env_command,
    gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
    deadline: ctx.deadline,
    jail: jailFor(ctx, worktree),
    services: ctx.services,
    onCheck,
  });

  // A check killed at the deadline is not a red check: the run stops on the wall limit instead.
  checkDeadline(ctx);
  const countTests = repo.limits.diff_count_tests;
  const stat = await repoDiffStat(worktree, ctx.baseSha, repo, { countTests });
  const diffReport = diffCountFields(diffTotals(stat), countTests);
  if (diffReport) ctx.events.diffCount = diffReport;
  const builtins: BuiltinResult[] = [
    forbiddenPaths(changed, repo.limits.forbidden_paths),
    protectedPaths(plan, changed, repo.human_only_paths),
    diffSize(stat, repo.limits.max_diff_lines, { countTests }),
    testPresence(plan, packages, handoffs, changed, repo.tests.globs),
    evidenceCheck(handoffs, changed, repo.checks.map((c) => c.name)),
    guideUpdate(plan, packages, changed, repo),
    configGuard({ plan, packages, labels: ctx.task.labels, ...(await configGuardInputs(worktree, ctx.baseSha, changed)) }),
    ...(await runBaselineGates({
      cwd: worktree,
      tier,
      changed,
      baseSha: ctx.baseSha,
      toolchains: resolveToolchains(worktree, repo).toolchains,
      timeoutMs: gateCheckTimeoutMs({ gateTimeoutMinutes: repo.limits.gate_timeout_minutes, deadline: ctx.deadline }) ?? repo.limits.gate_timeout_minutes * 60_000,
      onCheck,
      secrets: ctx.secrets?.redact,
      requireTools: repo.baseline.require_tools,
    })),
  ];
  let reproRedOnBase: boolean | undefined;
  const first = topoOrder(plan.packages)[0];
  if (plan.type === "bug" && first && packages.includes(first.id)) {
    const decision = redGreenDecision(plan, ctx.task.labels);
    if (decision.kind === "exempt") {
      builtins.push({ name: "red_green", ok: true, detail: redGreenExemptDetail(decision.reason) });
    } else if (decision.kind === "missing_reason") {
      builtins.push({ name: "red_green", ok: false, detail: `loosening: ${RED_GREEN_NEEDS_REASON}` });
    } else {
      const proof = await redGreenProof({
        worktree,
        baseSha: ctx.baseSha,
        files: reproFiles(plan, handoffs),
        testCommand: repo.tests.run,
        setup: repo.setup,
        env,
        gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
        timeoutS: repo.tests.timeout_s,
        deadline: ctx.deadline,
        jail: (cwd) => jailFor(ctx, cwd),
        onCheck,
      });
      checkDeadline(ctx);
      reproRedOnBase = proof.inconclusive ? undefined : proof.redOnBase;
      builtins.push({ name: "red_green", ok: proof.ok, detail: proof.detail, timedOut: proof.timedOut });
    }
  }
  const all = [...checks, ...builtins.map(fromBuiltin)];
  const report: GateReport = {
    n: ++ctx.gateCount,
    tier,
    green: all.every((c) => c.status !== "fail" && c.status !== "timeout"),
    changed_files: changed,
    checks: all,
    scope_report: scopeReport(plan, changed),
    repro_red_on_base: reproRedOnBase,
  };
  writeJson(ctx, `gates-${report.n}.json`, report);
  for (const c of all) {
    const detail = visibleGateDetail(c.output_tail);
    ctx.events.emit({
      step: "gates",
      event: "gate_result",
      data: {
        n: report.n,
        tier,
        check: c.name,
        kind: c.kind,
        status: c.status,
        ...(c.name === "max_diff_lines" && diffReport ? diffReport : {}),
        ...(detail ? { detail } : {}),
      },
    });
  }
  return report;
}

/**
 * Security gates that passed only because the scanner was missing. The detail starts with `SKIPPED`.
 * A missing binary with `baseline.require_tools` is a failure and is not listed here.
 */
export function skippedSecurityGates(checks: { name: string; status: string; output_tail: string }[]): string[] {
  return checks.filter((c) => c.status === "pass" && c.output_tail.startsWith("SKIPPED")).map((c) => c.name);
}

/** Gate list for the PR body. Skipped security gates are named above the check marks. */
export function formatGateResults(checks: CheckResult[]): string {
  const skipped = skippedSecurityGates(checks);
  const lines = checks.map((c) => {
    const mark = c.status === "pass" ? "✅" : c.status === "flaky" ? "⚠️" : c.status === "timeout" ? "⏱️" : "❌";
    const flaky = c.status === "flaky" ? ", flaky" : c.status === "timeout" ? ", timed out" : "";
    const shown = visibleGateDetail(c.output_tail);
    const detail = shown ? `: ${shown}` : "";
    return `- ${mark} ${c.name} (${c.kind}${flaky})${detail}`;
  });
  if (skipped.length) lines.unshift(`Skipped security gates: ${skipped.join(", ")}`);
  return lines.join("\n");
}

/** Failure tail handed back to the implementer. */
export function failureSummary(report: GateReport): string {
  return report.checks
    .filter((c) => c.status === "fail" || c.status === "timeout")
    .map((c) => `### ${c.name} (${c.kind})${c.status === "timeout" ? " [timed out]" : ""}\n${c.output_tail}`)
    .join("\n\n");
}
