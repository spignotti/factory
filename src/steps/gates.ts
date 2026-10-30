import { sh, tail } from "../exec.js";
import { changedFiles, repoDiffStat, stageAll } from "../git.js";
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
import { redGreenProof } from "../gates/redgreen.js";
import { selectChecks } from "../gates/select.js";
import { topoOrder } from "../pipeline/dag.js";
import type { Deadline } from "../pipeline/budget.js";
import { checkDeadline, commandEnv, jailFor, type RunContext, writeJson } from "../pipeline/context.js";
import type { Jail } from "../sandbox/sandbox.js";
import { EnvMissing, type Services } from "../services.js";
import type { Check, Tier } from "../schemas/repo.js";

export interface CheckResult {
  name: string;
  kind: "check" | "builtin";
  status: "pass" | "fail" | "flaky";
  duration_ms: number;
  output_tail: string;
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
  opts: { cwd: string; env: Record<string, string>; envCommand: string; deadline?: Deadline; jail?: Jail; services?: Services },
): Promise<CheckResult[]> {
  const timeout = () => (opts.deadline === undefined ? undefined : Math.max(1000, opts.deadline.at - Date.now()));
  const results: CheckResult[] = [];
  for (const check of checks) {
    const needs = check.services ?? [];
    let env = opts.env;
    let jail = opts.jail;
    let run = check.run;
    if (opts.services) {
      await opts.services.ensure(needs);
      env = { ...env, ...(await opts.services.envOf(needs)) };
      if (jail && needs.length) jail = { ...jail, ports: { reach: opts.services.reachOf(needs) } };
      run = await opts.services.expand(run);
    } else if (needs.length) {
      throw new EnvMissing(`check ${check.name} needs services ${needs.join(", ")} but none are configured for this call`);
    }
    const cmd = withEnvCommand(run, opts.envCommand);
    let r = await sh(cmd, { cwd: opts.cwd, env, timeoutMs: timeout(), jail });
    let status: CheckResult["status"] = r.code === 0 ? "pass" : "fail";
    if (status === "fail") {
      const again = await sh(cmd, { cwd: opts.cwd, env, timeoutMs: timeout(), jail });
      if (again.code === 0) status = "flaky";
      else r = again;
    }
    results.push({ name: check.name, kind: "check", status, duration_ms: r.durationMs, output_tail: status === "pass" ? "" : tail(r.output) });
  }
  return results;
}

const fromBuiltin = (b: BuiltinResult): CheckResult => ({
  name: b.name,
  kind: "builtin",
  status: b.ok ? "pass" : "fail",
  duration_ms: 0,
  output_tail: b.detail,
});

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
  const checks = await runChecks(selectChecks(repo.checks, tier, changed), {
    cwd: worktree,
    env,
    envCommand: repo.env_command,
    deadline: ctx.deadline,
    jail: jailFor(ctx, worktree),
    services: ctx.services,
  });

  // A check killed at the deadline is not a red check: the run stops on the wall limit instead.
  checkDeadline(ctx);
  const builtins: BuiltinResult[] = [
    forbiddenPaths(changed, repo.limits.forbidden_paths),
    protectedPaths(plan, changed, repo.human_only_paths),
    diffSize(await repoDiffStat(worktree, ctx.baseSha, repo), repo.limits.max_diff_lines),
    testPresence(plan, packages, handoffs, changed, repo.tests.globs),
    evidenceCheck(handoffs, changed, repo.checks.map((c) => c.name)),
    guideUpdate(plan, packages, changed, repo),
    configGuard({ plan, packages, ...(await configGuardInputs(worktree, ctx.baseSha, changed)) }),
  ];
  let reproRedOnBase: boolean | undefined;
  const first = topoOrder(plan.packages)[0];
  if (plan.type === "bug" && first && packages.includes(first.id)) {
    const proof = await redGreenProof({
      worktree,
      baseSha: ctx.baseSha,
      files: reproFiles(plan, handoffs),
      testCommand: repo.tests.run,
      setup: repo.setup,
      env,
      deadline: ctx.deadline,
      jail: (cwd) => jailFor(ctx, cwd),
    });
    checkDeadline(ctx);
    reproRedOnBase = proof.inconclusive ? undefined : proof.redOnBase;
    builtins.push({ name: "red_green", ok: proof.ok, detail: proof.detail });
  }
  const all = [...checks, ...builtins.map(fromBuiltin)];
  const report: GateReport = {
    n: ++ctx.gateCount,
    tier,
    green: all.every((c) => c.status !== "fail"),
    changed_files: changed,
    checks: all,
    scope_report: scopeReport(plan, changed),
    repro_red_on_base: reproRedOnBase,
  };
  writeJson(ctx, `gates-${report.n}.json`, report);
  for (const c of all) {
    ctx.events.emit({ step: "gates", event: "gate_result", data: { n: report.n, tier, check: c.name, kind: c.kind, status: c.status } });
  }
  return report;
}

/** Failure tail handed back to the implementer. */
export function failureSummary(report: GateReport): string {
  return report.checks
    .filter((c) => c.status === "fail")
    .map((c) => `### ${c.name} (${c.kind})\n${c.output_tail}`)
    .join("\n\n");
}
