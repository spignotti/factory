import { createHash } from "node:crypto";
import { join } from "node:path";
import { sh, tail } from "../exec.js";
import { changedFiles, diffCountFields, diffTotals, git, repoDiffStat, stageAll } from "../git.js";
import {
  type BuiltinResult,
  type EvidenceInputs,
  diffSize,
  evidenceCheck,
  forbiddenPaths,
  guideUpdate,
  judgeEvidence,
  protectedPaths,
  reproFiles,
  scopeReport,
  testPresence,
} from "../gates/builtin.js";
import { citedTestFiles, configuredProbeCommand, evidenceProvesFullCommand, executedFromOutput, pytestResultLines, runCitedTests, shellQuote, splitEvidenceRef, type ExecutedTest } from "../gates/evidence.js";
import { configGuard, configGuardInputs } from "../gates/config-guard.js";
import { runBaselineGates } from "../baseline/gates.js";
import { baseProbeFiles, redGreenProof } from "../gates/redgreen.js";
import { RED_GREEN_NEEDS_REASON, redGreenDecision, redGreenExemptDetail } from "../schemas/plan.js";
import { dedupeChecks, omitRepeatedNames, selectChecks } from "../gates/select.js";
import { gateCheckTimeoutMs, shTimedOut, watchCheck, type CheckPulse } from "../gates/timeout.js";
import { resolveToolchains } from "../toolchains.js";
import { topoOrder } from "../pipeline/dag.js";
import type { Deadline } from "../pipeline/budget.js";
import { checkDeadline, commandEnv, jailFor, type RunContext, writeJson } from "../pipeline/context.js";
import type { Jail } from "../sandbox/sandbox.js";
import { EnvMissing, type Services } from "../services.js";
import type { Handoff } from "../schemas/handoff.js";
import type { Check, Tier } from "../schemas/repo.js";

export interface CheckResult {
  name: string;
  kind: "check" | "builtin";
  status: "pass" | "fail" | "flaky" | "timeout";
  /** Sum of every attempt of this check, not one chosen attempt. */
  duration_ms: number;
  output_tail: string;
  timed_out?: boolean;
  /** Set when a product red-then-green is allowed by this check's `flake_allow` reason. */
  flake_allowed?: boolean;
  /** An actual red-on-base, green-on-head proof, never an exemption or a green command alone. */
  effect_proven?: boolean;
  /**
   * The factory's own bookkeeping gate (evidence, test presence, red-green, config guard, guide
   * update, in-run security scanners). It is reported, and never turns the report red: quality is
   * enforced by the repository's checks, its CI and the review.
   */
  advisory?: boolean;
}

/** A fail, a timeout, or a product flake that no repo rule allows. An advisory gate never blocks. */
export function checkBlocksGate(check: Pick<CheckResult, "status" | "flake_allowed" | "advisory">): boolean {
  if (check.advisory) return false;
  if (check.status === "fail" || check.status === "timeout") return true;
  return check.status === "flaky" && !check.flake_allowed;
}

const INFRA_FAILURE = /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset by peer|Could not resolve host|TLS handshake|temporary failure in name resolution)\b/i;
const PRODUCT_FAILURE = /\bERR_ASSERTION\b|\bAssertionError\b|^not ok\s|^FAILED\s|\bFAIL\b|^E\s+assert\s+/m;

/**
 * An infrastructure failure may be retried once and then pass. A product failure that turns green
 * is instability. An assertion wins when the output names both.
 */
export function failureKind(output: string, signal?: NodeJS.Signals | null): "infra" | "product" {
  if (signal) return "infra";
  if (PRODUCT_FAILURE.test(output)) return "product";
  if (INFRA_FAILURE.test(output)) return "infra";
  return "product";
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
  /**
   * Handoff evidence the evidence gate accepted for this tree. Only these refs check an acceptance
   * box or close a bundle issue; a rejected (invented) ref is a note, not evidence.
   */
  accepted_evidence?: Handoff["evidence"];
}

export function withEnvCommand(run: string, envCommand: string): string {
  return envCommand ? `${envCommand} ${run}` : run;
}

/**
 * Runs checks. A red check is re-run once. An infrastructure failure that then passes is a pass
 * and keeps both attempts. A product red-then-green is `flaky` and blocks the gate unless the
 * check names `flake_allow`. `duration_ms` is the sum of the attempts.
 * A `manual` check with no `owner` fails closed and does not run.
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
    onResult?: (check: Check, result: Awaited<ReturnType<typeof sh>>, status: CheckResult["status"]) => void;
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
    if (check.tier === "manual" && !check.owner?.trim()) {
      results.push({
        name: check.name,
        kind: "check",
        status: "fail",
        duration_ms: 0,
        output_tail: "manual check has no owner; it is not a proof",
      });
      continue;
    }
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
    const r = await spawnCheck(check, cmd, env, jail);
    // Timeout wins over exit 0: a kill that races a clean exit is still a timeout, not a pass.
    let status: CheckResult["status"] = shTimedOut(r) ? "timeout" : r.code === 0 ? "pass" : "fail";
    let duration = r.durationMs;
    let output_tail = status === "pass" ? "" : tail(r.output);
    let flake_allowed = false;
    if (status === "fail") {
      const kind = failureKind(r.output, r.signal);
      const firstTail = tail(r.output);
      const again = await spawnCheck(check, cmd, env, jail);
      duration += again.durationMs;
      if (shTimedOut(again)) {
        status = "timeout";
        output_tail = tail(again.output);
      } else if (again.code === 0 && kind === "infra") {
        status = "pass";
        output_tail = `infrastructure retry: first attempt failed, second passed\n${firstTail}`;
      } else if (again.code === 0) {
        status = "flaky";
        flake_allowed = !!check.flake_allow;
        output_tail = flake_allowed
          ? `flake allowed (${check.flake_allow}): red then green\nfirst:\n${firstTail}`
          : `instability: red then green; not a pass\nfirst:\n${firstTail}`;
      } else {
        status = "fail";
        output_tail = tail(again.output);
      }
    }
    if (status === "pass" && check.tier === "manual" && check.owner) {
      output_tail = output_tail ? `owner: ${check.owner}\n${output_tail}` : `owner: ${check.owner}`;
    }
    const timed_out = status === "timeout";
    // A retried failure never supplies evidence from a different attempt.
    if (status === "pass" && r.code === 0) opts.onResult?.(check, r, status);
    results.push({
      name: check.name,
      kind: "check",
      status,
      duration_ms: duration,
      output_tail,
      ...(timed_out ? { timed_out: true } : {}),
      ...(flake_allowed ? { flake_allowed: true } : {}),
    });
  }
  return results;
}

const fromBuiltin = (b: BuiltinResult, advisory = false): CheckResult => ({
  name: b.name,
  kind: "builtin",
  status: b.timedOut ? "timeout" : b.ok ? "pass" : "fail",
  duration_ms: b.duration_ms ?? 0,
  output_tail: b.detail,
  ...(b.timedOut ? { timed_out: true } : {}),
  ...(advisory ? { advisory: true } : {}),
});

/** First line of a gate detail the PR body should show (skipped scanners, red-green exemption, flake and dedupe). */
export function visibleGateDetail(output: string): string {
  const head = output.split("\n")[0]?.trim() ?? "";
  if (
    head.startsWith("SKIPPED") ||
    head.startsWith("EXEMPT") ||
    head.startsWith("loosening:") ||
    head.startsWith("infrastructure retry:") ||
    head.startsWith("instability:") ||
    head.startsWith("flake allowed") ||
    head.startsWith("same command as") ||
    head.startsWith("owner:") ||
    head.startsWith("manual check has no owner") ||
    head.startsWith("base probe reused")
  ) {
    return head;
  }
  return "";
}

/**
 * Fast checks on a base commit. A timeout is inconclusive. A product red-then-green is not a pass.
 * A real failure is `base_red`.
 */
export function baseCheckOutcome(results: CheckResult[]): { result: "base_red" | "needs_human"; reason: string } | undefined {
  const timed = results.filter((r) => r.status === "timeout").map((r) => r.name);
  if (timed.length) return { result: "needs_human", reason: `fast checks timed out on base (inconclusive): ${timed.join(", ")}` };
  const unstable = results.filter((r) => r.status === "flaky" && checkBlocksGate(r)).map((r) => r.name);
  if (unstable.length) return { result: "needs_human", reason: `fast checks unstable on base (red then green, not a pass): ${unstable.join(", ")}` };
  const red = results.filter((r) => r.status === "fail").map((r) => r.name);
  if (red.length) return { result: "base_red", reason: `fast checks red on base: ${red.join(", ")}` };
  return undefined;
}

/** Stored on the package when a gate attempt does not go green. A timeout is not called red. */
export function gateAttemptReason(attempt: number, report: GateReport): string {
  const timed = report.checks.filter((c) => c.status === "timeout" && checkBlocksGate(c)).map((c) => c.name);
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
  const selected = dedupeChecks(selectChecks(repo.checks, tier, changed));
  const tree = (await git(worktree, ["ls-files"])).split("\n").filter(Boolean);
  const cited = citedTestFiles(handoffs).filter((f) => tree.includes(f));
  const namedFiles = new Set(handoffs.flatMap((h) => h.evidence.filter((e) => e.kind === "test").map((e) => splitEvidenceRef(e.ref))).filter((r) => r.name !== undefined).map((r) => r.file));
  const command = repo.tests.run ? withEnvCommand(repo.tests.run, repo.env_command) : undefined;
  const readTree = async () => (await git(worktree, ["write-tree"])).trim();
  const fingerprintOf = (tree: string) => createHash("sha256").update(JSON.stringify({
    tree, base: ctx.baseSha, command, env, cited,
  })).digest("hex");
  // Evidence is bound to the staged tree that was tested, not to a later commit of the same files.
  let checkpoint = await readTree();
  const before = fingerprintOf(checkpoint);
  const reusable = !repo.env_command && repo.services.length === 0;
  let executed: ExecutedTest[] = [];
  const checks = await runChecks(selected.checks, {
    cwd: worktree,
    env,
    envCommand: repo.env_command,
    gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
    deadline: ctx.deadline,
    jail: jailFor(ctx, worktree),
    services: ctx.services,
    onCheck,
    onResult: (check, result) => {
      if (!command || check.services?.length) return;
      const ranCommand = withEnvCommand(check.run, repo.env_command);
      if (!command.includes("{files}") && ranCommand === command) {
        for (const file of cited) {
          const rows = pytestResultLines(file, result.output, checkpoint).map((r) => ({ ...r, command: ranCommand }));
          if (!rows.length) continue;
          executed.push(...rows);
          if (result.code !== 0) executed.push({ file, name: "", result: "fail", checkpoint, command: ranCommand });
        }
      } else {
        for (const file of cited) {
          if (ranCommand === command.replaceAll("{files}", shellQuote(file)) || ranCommand === command.replaceAll("{files}", file)) {
            executed.push(...executedFromOutput(file, result.output, result.code, checkpoint, ranCommand));
          }
        }
      }
    },
  });
  for (const dup of selected.sameCommand) {
    const src = checks.find((c) => c.name === dup.sameAs);
    checks.push({
      name: dup.name,
      kind: "check",
      status: src?.status ?? "fail",
      duration_ms: 0,
      output_tail: `same command as ${dup.sameAs}; not run again`,
      ...(src?.timed_out ? { timed_out: true } : {}),
      ...(src?.flake_allowed ? { flake_allowed: true } : {}),
    });
  }

  // A check killed at the deadline is not a red check: the run stops on the wall limit instead.
  checkDeadline(ctx);
  const countTests = repo.limits.diff_count_tests;
  const stat = await repoDiffStat(worktree, ctx.baseSha, repo, { countTests });
  const diffReport = diffCountFields(diffTotals(stat), countTests);
  if (diffReport) ctx.events.diffCount = diffReport;
  await stageAll(worktree);
  checkpoint = await readTree();
  const key = fingerprintOf(checkpoint);
  if (before !== key) executed = [];
  if (reusable && ctx.testEvidence?.key === key) {
    executed.push(...ctx.testEvidence.executed.filter((row) => row.checkpoint === checkpoint && !executed.some((e) => e.file === row.file)));
  }
  const missing = cited.filter((file) => !executed.some((row) => row.file === file && row.checkpoint === checkpoint && (!namedFiles.has(file) || row.name !== "")));
  executed = executed.filter((row) => !missing.includes(row.file));
  const evidenceStarted = Date.now();
  executed.push(...await runCitedTests({
    cwd: worktree,
    files: missing,
    named: [...namedFiles],
    checkpoint,
    testCommand: command,
    env,
    timeoutMs: gateCheckTimeoutMs({
      check: repo.tests.timeout_s !== undefined ? { timeout_s: repo.tests.timeout_s } : undefined,
      gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
      deadline: ctx.deadline,
    }),
    jail: jailFor(ctx, worktree),
    onCheck,
  }));
  const evidenceDuration = Date.now() - evidenceStarted;
  await stageAll(worktree);
  // A test that writes files is not evidence for the tree those results were collected from.
  const after = await readTree();
  const evidenceTreeUnchanged = key === fingerprintOf(after);
  if (!evidenceTreeUnchanged) executed = [];
  if (reusable && evidenceTreeUnchanged && executed.every((e) => e.result === "pass")) ctx.testEvidence = { key, executed };
  else delete ctx.testEvidence;
  const evidence: EvidenceInputs = {
    files: tree,
    executed,
    checkpoint: evidenceTreeUnchanged ? checkpoint : after,
    knownChecks: repo.checks.map((c) => c.name),
    ranChecks: checks.map((c) => ({ name: c.name, status: c.status })),
  };
  const builtins: BuiltinResult[] = [
    forbiddenPaths(changed, repo.limits.forbidden_paths),
    protectedPaths(plan, changed, repo.human_only_paths),
    diffSize(stat, repo.limits.max_diff_lines, { countTests }),
  ];
  // Reported, never blocking: the repo's own checks and CI decide, not the factory's bookkeeping.
  const advisory: BuiltinResult[] = [
    testPresence(plan, packages, handoffs, evidence),
    { ...evidenceCheck(handoffs, evidence), duration_ms: evidenceDuration },
    guideUpdate(plan, packages, changed, repo),
    configGuard({ plan, packages, labels: ctx.task.labels, ...(await configGuardInputs(worktree, ctx.baseSha, changed)) }),
    ...omitRepeatedNames(
      await runBaselineGates({
        cwd: worktree,
        tier,
        changed,
        baseSha: ctx.baseSha,
        toolchains: resolveToolchains(worktree, repo).toolchains,
        timeoutMs: gateCheckTimeoutMs({ gateTimeoutMinutes: repo.limits.gate_timeout_minutes, deadline: ctx.deadline }) ?? repo.limits.gate_timeout_minutes * 60_000,
        onCheck,
        secrets: ctx.secrets?.redact,
        requireTools: repo.baseline.require_tools,
        skipNames: checks.map((c) => c.name),
      }),
      checks.map((c) => c.name),
    ),
  ];
  let reproRedOnBase: boolean | undefined;
  const first = topoOrder(plan.packages)[0];
  if ((plan.type === "bug" || plan.red_green === "required") && first && packages.includes(first.id)) {
    const decision = redGreenDecision(plan, ctx.task.labels);
    if (decision.kind === "exempt") {
      advisory.push({ name: "red_green", ok: true, detail: redGreenExemptDetail(decision.reason) });
    } else if (decision.kind === "missing_reason") {
      advisory.push({ name: "red_green", ok: false, detail: `loosening: ${RED_GREEN_NEEDS_REASON}` });
    } else {
      const probe = baseProbeFiles(reproFiles(plan, handoffs), changed, repo.tests.globs);
      const proof = await redGreenProof({
        worktree,
        baseSha: ctx.baseSha,
        files: probe.tests,
        supportFiles: probe.support,
        testCommand: command,
        setup: repo.setup,
        env,
        gateTimeoutMinutes: repo.limits.gate_timeout_minutes,
        timeoutS: repo.tests.timeout_s,
        deadline: ctx.deadline,
        jail: (cwd) => jailFor(ctx, cwd),
        onCheck,
        cacheFile: join(ctx.runDir, "red-green-base.json"),
        headPassed:
          evidenceTreeUnchanged &&
          reusable &&
          !!command &&
          probe.tests.length === 1 &&
          evidenceProvesFullCommand(executed, probe.tests[0]!, checkpoint, configuredProbeCommand(command, probe.tests)),
      });
      checkDeadline(ctx);
      reproRedOnBase = proof.inconclusive ? undefined : proof.redOnBase;
      advisory.push({ name: "red_green", ok: proof.ok, detail: proof.detail, timedOut: proof.timedOut, duration_ms: proof.duration_ms });
    }
  }
  const all = [...checks, ...builtins.map((b) => fromBuiltin(b)), ...advisory.map((b) => fromBuiltin(b, true))];
  const redGreen = all.find((c) => c.name === "red_green");
  if (redGreen && reproRedOnBase === true && redGreen.status === "pass") redGreen.effect_proven = true;
  const report: GateReport = {
    n: ++ctx.gateCount,
    tier,
    green: all.every((c) => !checkBlocksGate(c)),
    changed_files: changed,
    checks: all,
    scope_report: scopeReport(plan, changed),
    repro_red_on_base: reproRedOnBase,
    accepted_evidence: judgeEvidence(handoffs, evidence).accepted,
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
        ...(c.advisory ? { advisory: true } : {}),
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

/** The factory's own advisory gates; any other advisory gate is an in-run security scanner. */
const BOOKKEEPING_GATES = new Set(["test_presence", "evidence", "guide_update", "config_guard", "red_green"]);

/**
 * Advisory gates whose failure keeps a person in front of the merge. They never stop the run, but a
 * loosened check or a scanner finding must not auto-merge. A gitleaks finding also keeps the branch
 * off the remote: a pushed secret is public at once. A timed-out scanner counts as failed.
 */
export function mergeHolds(checks: Pick<CheckResult, "name" | "status" | "advisory">[]): { reasons: string[]; secret: boolean } {
  const failed = checks.filter((c) => c.advisory && (c.status === "fail" || c.status === "timeout"));
  const reasons: string[] = [];
  if (failed.some((c) => c.name === "config_guard")) reasons.push("config_guard failed: the diff loosens the repo's own checks");
  const scanners = failed.filter((c) => !BOOKKEEPING_GATES.has(c.name)).map((c) => c.name);
  if (scanners.length) reasons.push(`security scanner failed: ${scanners.join(", ")}`);
  return { reasons, secret: scanners.includes("gitleaks") };
}

/** A failed advisory gate's note: the first detail line for bookkeeping gates, never scanner output. */
function advisoryNote(c: CheckResult): string {
  if (c.status === "pass") return visibleGateDetail(c.output_tail);
  if (!BOOKKEEPING_GATES.has(c.name)) return "";
  const lines = c.output_tail.split("\n").map((line) => line.trim()).filter(Boolean);
  // A heading line ("…:") says nothing alone; the first finding under it does.
  const head = lines[0]?.endsWith(":") && lines[1] ? `${lines[0]} ${lines[1]}` : (lines[0] ?? "");
  return head.length > 200 ? `${head.slice(0, 199)}…` : head;
}

/**
 * Gate list for the PR body. Skipped security gates are named above the check marks. Advisory gates
 * follow in their own list: a failed one is a note, not a red gate.
 */
export function formatGateResults(checks: CheckResult[]): string {
  const skipped = skippedSecurityGates(checks);
  const lines = checks.filter((c) => !c.advisory).map((c) => {
    const mark = c.status === "pass" ? "✅" : c.status === "flaky" ? "⚠️" : c.status === "timeout" ? "⏱️" : "❌";
    const flaky = c.status === "flaky" ? ", flaky" : c.status === "timeout" ? ", timed out" : "";
    const shown = visibleGateDetail(c.output_tail);
    const detail = shown ? `: ${shown}` : "";
    return `- ${mark} ${c.name} (${c.kind}${flaky})${detail}`;
  });
  if (skipped.length) lines.unshift(`Skipped security gates: ${skipped.join(", ")}`);
  const advisory = checks.filter((c) => c.advisory);
  if (advisory.length) {
    lines.push("", "Advisory gates (reported, not blocking):");
    for (const c of advisory) {
      const state = c.status === "pass" ? "" : c.status === "timeout" ? ", timed out" : ", failed";
      const mark = c.status === "pass" ? "✅" : "📝";
      const note = advisoryNote(c);
      lines.push(`- ${mark} ${c.name} (${c.kind}, advisory${state})${note ? `: ${note}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** Failure tail handed back to the implementer. Advisory gates are not failures. */
export function failureSummary(report: GateReport): string {
  return report.checks
    .filter((c) => checkBlocksGate(c))
    .map((c) => `### ${c.name} (${c.kind})${c.status === "timeout" ? " [timed out]" : ""}\n${c.output_tail}`)
    .join("\n\n");
}
