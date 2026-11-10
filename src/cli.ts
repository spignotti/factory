#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { PiRunner } from "./agents/pi-runner.js";
import { ciStubModeAt, defaultRef, renderCiStubFor } from "./ci.js";

export { defaultRef };
import { doctorCommand } from "./commands/doctor.js";
import { Context7Client } from "./docs/context7.js";
import { evalCommand, experimentCommand, validateCommand } from "./commands/eval.js";
import { gatesCommand, type Io } from "./commands/gates.js";
import { abandonRun } from "./commands/abandon.js";
import { autoGc, gcCommand } from "./commands/gc.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { adoptCommand } from "./commands/adopt.js";
import { auditCommand } from "./commands/audit.js";
import { hardenCommand } from "./commands/harden.js";
import { AUDIT_TYPES, type AuditType, MAX_PROPOSALS_LIMIT } from "./schemas/repo.js";
import { GhCli } from "./gh.js";
import { installSignalHandlers, Interrupted } from "./interrupt.js";
import { isBaseRedWaiting, resumeFactory, runFactory, sweepBaseRed } from "./pipeline/run.js";
import { listRuns } from "./runs.js";
import { createSandbox, type Sandbox } from "./sandbox/sandbox.js";
import type { Profile } from "./schemas/profile.js";
import { factoryHomeOf, loadLayers, resolveProfile } from "./config.js";
import { asset } from "./prompts.js";
import { notifyTest, flushNotifyOutbox, requireNotifyHook, requireNotifyTarget } from "./notify.js";

const USAGE = `usage:
  factory --version
  factory run --repo <path> (--issue <n> | --plan <file> | --text <file>) [--lane standard|fast]
              [--plan-effort none|medium|high] [--no-pr] [--profile <file>] [--wait]
              (one run per repo at a time: busy repo → result "locked", or queue with --wait)
              [--notify <target>] [--no-notify]
              (refuse to start without a notify hook for the repo unless --no-notify;
               --notify names a targets: entry in notify.yaml, stored on the run)
  factory resume <run-id> [--wait] [--no-pr] [--profile <file>] [--notify <target>]
              (--notify overrides the target stored on the run; omitted reuses it)
              (after a human fix: commits it, merges base, re-runs gates, continues; updates the PR)
  factory abandon <run-id> [--json]
              (marks the run abandoned, releases a stale lock, removes its worktree; result and logs stay)
  factory doctor [--repo <path>] [--profile <file>] [--ping] [--services] [--json]
              (setup checks, Zen guard, ChatGPT login; effective model per role and its layer;
               CI stub hash; --ping sends one tiny request per configured model;
               --services starts and stops each service and the ui once in a clean base worktree)
  models: built-in < $FACTORY_HOME/profile.yaml < --profile <file> < repo.yaml models: (see README)
  factory status [--since <duration>] [--json]
              (running, waiting for a human, interrupted runs; open factory PRs;
               --since 12h adds finished runs from result.json: merged, human_review, blocked, failed, base_red, needs_input)
  factory stats [--since 7d] [--repo <path>] [--json]
              (results, rounds, gates, providers, cost; this period vs the previous one;
               text includes top gate failures and reasons)
  factory gc [--dry-run] [--scheduled] [--force] [--retention-days N] [--strip-after-hours N] [--archive-days N] [--json]
              (worktree and branch of merged/closed PRs; needs_input unanswered for 2 working days
               (Mon-Fri, Europe/Berlin) is abandoned and the owner notified; run dirs idle for
               --archive-days (default 90) overrides metadata tarball retention; use factory gc --scheduled for cron (see docs/GC_RETENTION.md)
               base CI is green again is resumed, within limits.base_red_resume_hours)
  factory gates (--select | --toolchains | --run <check|selected>) [--tier fast|full|manual] [--base <ref>] [--all] [--repo <path>] [--json]
              (--all selects every check of the tier, with no path filter: tag pushes and workflow_dispatch.
               A pull request still filters by the diff. --run starts the services its checks need; with CI set,
               local_only checks are not selected; --toolchains: what the CI stub installs, repo.yaml ci.toolchains or detected)
  factory eval --profile <name|file> [--profile …] [--tasks <glob>] [--repeat N] [--out <dir>] [--json]
              (fresh clone at base → run --no-pr → hidden tests; results in evals/results/<date>.jsonl + .md)
  factory eval --validate [--tasks <glob>] [--json]
              (no agents: hidden tests red on base, green on the upstream fix)
  factory experiment --base <profile> --variant <profile> [--tasks <glob>] [--repeat N≥2] [--out <dir>]
              (eval of both, decision rule, JSON verdict; schemas/verdict.schema.json)
              eval/experiment also take [--work-dir <dir>] [--keep]
  factory adopt --repo <path> [--ref <tag>] [--base <branch>] [--keep <glob>]… [--no-measure] [--no-plan] [--no-pr] [--force] [--json]
              (drafts .factory/repo.yaml, review rules, CI stub, AGENTS.md (template if missing); removes the legacy
               coding setup (--keep spares paths); baseline plan as proposal; one PR; settings only as hints)
  factory harden --repo <path> [--no-compact] [--max <1-10>] [--profile <file>] [--json]
              (resolves earlier proposals, compacts memory, signals and metrics (metrics.jsonl), one ticket
               $FACTORY_HOME/memory/<repo>/proposals/<date>.json with up to --max (repo.yaml harden.max_proposals,
               default 5) ranked proposals, each its own run/PR; exit 1 when selection failed)
  factory audit --repo <path> --type security|performance|refactor|simplify [--max <1-10>] [--profile <file>] [--json]
              (one read-only session; ticket proposals/<date>-audit-<type>.json with up to --max
               (repo.yaml audit.max_proposals, default 5) ranked plans when --type is listed in audit.types;
               otherwise exit 1 and no model call; audit.focus.<type> is an optional note added only to
               that type's prompt; each plan is its own run/PR)
  factory notify test <owner/name> [--target <name>]
              (one test POST to the repo's webhook, or to a named target, from $FACTORY_HOME/notify.yaml;
               doctor lists configured repos and target names, never URLs)
  factory notify flush [--json]
              (retry pending notifications from $FACTORY_HOME/outbox/; also runs at the start of every run and resume)
  factory ci-stub [--ref <tag>] [--repo <path>]
              (prints .github/workflows/factory.yml for a pinned factory ref, default v<version>; a repo whose
               checks are all local_only, or there are none, gets the minimal stub, no npx; a manual
               check keeps the full stub so workflow_dispatch can run it; doctor checks its hash)
`;

function exitCode(result: string, signal: AbortSignal): number {
  const reason: unknown = signal.reason;
  if (reason instanceof Interrupted) return reason.signalName === "SIGINT" ? 130 : 143;
  return result === "failed" ? 1 : 0;
}

/** Decides the sandbox from the profile (throws when `required` is unmet); warnings go to stderr. */
function sandboxFor(profile: Profile, io: Io): Sandbox {
  const sandbox = createSandbox(profile.sandbox);
  for (const w of sandbox.warnings) io.err(`factory: ${w}\n`);
  return sandbox;
}

const defaultIo: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

/**
 * Resumes GitHub-CI `base_red` runs whose base commit is green again. No-op when none are waiting,
 * so `factory gc` / `factory run` do not load a runner otherwise. Failures are logged and swallowed.
 */
async function sweepBaseRedRuns(factoryHome: string, io: Io): Promise<void> {
  if (!listRuns(factoryHome).some((r) => isBaseRedWaiting(r.state))) return;
  const profile = resolveProfile(loadLayers({ factoryHome }));
  const runner = new PiRunner(join(factoryHome, "pi"));
  try {
    await sweepBaseRed({ runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome }, io.err);
  } catch (e) {
    io.err(`factory: base_red resume failed (continuing): ${(e as Error).message.slice(0, 200)}\n`);
  } finally {
    await runner.close();
  }
}

/** Package version, plus the commit when run from a git checkout (npm link / checkout installs). */
function packageVersion(): string {
  return (JSON.parse(asset("package.json")) as { version: string }).version;
}


function versionString(): string {
  const version = packageVersion();
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(join(root, ".git"))) {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (sha) return `${version} (${sha})`;
    }
    // Staging tarballs have no checkout. BUILD.json is written by scripts/pack-staging.mjs.
    const buildPath = join(root, "BUILD.json");
    if (existsSync(buildPath)) {
      const commit = (JSON.parse(readFileSync(buildPath, "utf8")) as { commit?: string }).commit?.trim();
      if (commit) return `${version} (${commit.slice(0, 12)})`;
    }
    return version;
  } catch {
    return version;
  }
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "--version" || command === "version") {
      io.out(`factory ${versionString()}\n`);
      return 0;
    }
    if (command === "gates") {
      const { values } = parseArgs({
        args: rest,
        options: {
          select: { type: "boolean", default: false },
          toolchains: { type: "boolean", default: false },
          run: { type: "string" },
          tier: { type: "string", default: "fast" },
          base: { type: "string" },
          all: { type: "boolean", default: false },
          repo: { type: "string", default: "." },
          json: { type: "boolean", default: false },
        },
      });
      return await gatesCommand({ ...values, repo: values.repo, tier: values.tier, select: values.select, toolchains: values.toolchains, all: values.all, json: values.json }, io);
    }
    if (command === "eval" || command === "experiment") {
      const { values } = parseArgs({
        args: rest,
        options: {
          profile: { type: "string", multiple: true },
          base: { type: "string" },
          variant: { type: "string" },
          tasks: { type: "string" },
          repeat: { type: "string" },
          out: { type: "string" },
          "work-dir": { type: "string" },
          keep: { type: "boolean", default: false },
          validate: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      const factoryHome = factoryHomeOf();
      // Sandbox and provider policy come from the user profile, as for `run`.
      const sandbox = sandboxFor(resolveProfile(loadLayers({ factoryHome })), io);
      // Absolute before any `git worktree add`. A relative `--work-dir` is otherwise created under the clone.
      const workDir = resolve(values["work-dir"] ?? join(factoryHome, "eval", "work"));
      if (values.validate) return await validateCommand({ tasks: values.tasks, json: values.json }, { factoryHome, workDir, sandbox, keep: values.keep }, io);
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      const deps = {
        factoryHome,
        workDir,
        sandbox,
        keep: values.keep,
        signal: controller.signal,
        // One runner per run; evalOne closes it.
        runner: () => new PiRunner(join(factoryHome, "pi")),
        docs: Context7Client.fromEnv(process.env),
      };
      try {
        if (command === "eval") {
          return await evalCommand({ profiles: values.profile ?? [], tasks: values.tasks, repeat: Number(values.repeat ?? 1), out: values.out, json: values.json }, deps, io);
        }
        if (!values.base || !values.variant) {
          io.err(USAGE);
          return 2;
        }
        return await experimentCommand({ base: values.base, variant: values.variant, tasks: values.tasks, repeat: Number(values.repeat ?? 2), out: values.out }, deps, io);
      } finally {
        uninstall();
      }
    }
    if (command === "adopt") {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          ref: { type: "string" },
          base: { type: "string" },
          keep: { type: "string", multiple: true },
          "no-measure": { type: "boolean", default: false },
          "no-plan": { type: "boolean", default: false },
          "no-pr": { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          profile: { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      if (!values.repo) {
        io.err(USAGE);
        return 2;
      }
      const factoryHome = factoryHomeOf();
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        return await adoptCommand(
          {
            repo: values.repo,
            ref: values.ref ?? defaultRef(),
            base: values.base,
            keep: values.keep ?? [],
            measure: !values["no-measure"],
            plan: !values["no-plan"],
            pr: !values["no-pr"],
            force: values.force,
            json: values.json,
          },
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal },
          io,
        );
      } finally {
        uninstall();
        await runner.close();
      }
    }
    if (command === "harden") {
      const { values } = parseArgs({
        args: rest,
        options: { repo: { type: "string" }, "no-compact": { type: "boolean", default: false }, max: { type: "string" }, profile: { type: "string" }, json: { type: "boolean", default: false } },
      });
      const max = values.max === undefined ? undefined : Number(values.max);
      if (!values.repo || (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= MAX_PROPOSALS_LIMIT))) {
        io.err(USAGE);
        return 2;
      }
      const factoryHome = factoryHomeOf();
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        return await hardenCommand(
          { repo: values.repo, compact: !values["no-compact"], json: values.json, ...(max ? { max } : {}) },
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal },
          io,
        );
      } finally {
        uninstall();
        await runner.close();
      }
    }
    if (command === "audit") {
      const { values } = parseArgs({
        args: rest,
        options: { repo: { type: "string" }, type: { type: "string" }, max: { type: "string" }, profile: { type: "string" }, json: { type: "boolean", default: false } },
      });
      const max = values.max === undefined ? undefined : Number(values.max);
      const typeOk = values.type !== undefined && (AUDIT_TYPES as readonly string[]).includes(values.type);
      if (!values.repo || !typeOk || (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= MAX_PROPOSALS_LIMIT))) {
        io.err(USAGE);
        return 2;
      }
      const factoryHome = factoryHomeOf();
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        return await auditCommand(
          { repo: values.repo, type: values.type as AuditType, json: values.json, ...(max ? { max } : {}) },
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal },
          io,
        );
      } finally {
        uninstall();
        await runner.close();
      }
    }
    if (command === "ci-stub") {
      const { values } = parseArgs({ args: rest, options: { ref: { type: "string" }, repo: { type: "string" } } });
      io.out(renderCiStubFor(values.ref ?? defaultRef(), ciStubModeAt(resolve(values.repo ?? "."))));
      return 0;
    }
    if (command === "doctor") {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          profile: { type: "string" },
          ping: { type: "boolean", default: false },
          services: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      return await doctorCommand(
        { factoryHome: factoryHomeOf(), repo: values.repo, profile: values.profile, ping: values.ping, services: values.services, json: values.json, context7: Context7Client.fromEnv(process.env) },
        io,
      );
    }
    if (command === "notify") {
      const [sub, ...subRest] = rest;
      if (sub === "flush") {
        const { values } = parseArgs({ args: subRest, options: { json: { type: "boolean", default: false } } });
        const report = await flushNotifyOutbox(factoryHomeOf(), { factoryHome: factoryHomeOf() });
        if (values.json) io.out(JSON.stringify(report) + "\n");
        else {
          io.out(`notify flush: sent ${report.sent}, failed ${report.failed}, skipped ${report.skipped}, remaining ${report.remaining}\n`);
          for (const e of report.errors) io.err(`factory: ${e}\n`);
        }
        return report.remaining > 0 || report.failed > 0 ? 1 : 0;
      }
      if (sub !== "test") {
        io.err(USAGE);
        return 2;
      }
      const { values, positionals } = parseArgs({
        args: subRest,
        allowPositionals: true,
        options: { target: { type: "string" } },
      });
      const repo = positionals[0];
      if (!repo || positionals.length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const r = await notifyTest(repo, { factoryHome: factoryHomeOf(), notifyTarget: values.target });
      (r.ok ? io.out : io.err)(`${r.ok ? "" : "factory: "}${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    if (command === "status") {
      const { values } = parseArgs({ args: rest, options: { since: { type: "string" }, json: { type: "boolean", default: false } } });
      return await statusCommand({ factoryHome: factoryHomeOf(), github: new GhCli(), since: values.since, json: values.json }, io);
    }
    if (command === "stats") {
      const { values } = parseArgs({
        args: rest,
        options: { since: { type: "string", default: "7d" }, repo: { type: "string" }, json: { type: "boolean", default: false } },
      });
      return statsCommand({ factoryHome: factoryHomeOf(), since: values.since, repo: values.repo, json: values.json }, io);
    }
    if (command === "abandon") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { json: { type: "boolean", default: false } },
      });
      if (positionals.length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const outcome = await abandonRun({ factoryHome: factoryHomeOf(), runId: positionals[0]!, reason: "abandoned with factory abandon" });
      if (values.json) io.out(JSON.stringify(outcome) + "\n");
      else (outcome.ok ? io.out : io.err)(`${outcome.message}\n`);
      return outcome.ok ? 0 : 1;
    }
    if (command === "gc") {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean", default: false },
          scheduled: { type: "boolean", default: false },
          force: { type: "boolean", default: false },
          "retention-days": { type: "string" },
          "strip-after-hours": { type: "string" },
          "archive-days": { type: "string" },
          json: { type: "boolean", default: false },
        },
      });
      const num = (flag: string, v: string | undefined) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${flag} ${v}`);
        return n;
      };
      const factoryHome = factoryHomeOf();
      const code = await gcCommand(
        {
          factoryHome,
          github: new GhCli(),
          dryRun: values["dry-run"],
          scheduled: values.scheduled,
          force: values.force,
          retentionDays: num("retention-days", values["retention-days"]),
          stripAfterHours: num("strip-after-hours", values["strip-after-hours"]),
          archiveDays: num("archive-days", values["archive-days"]),
          json: values.json,
        },
        io,
      );
      // Dry-run only reports. A real gc is the timer that continues base_red runs once CI is green.
      if (!values["dry-run"]) await sweepBaseRedRuns(factoryHome, io);
      return code;
    }
    if (command === "run") {
      const { values } = parseArgs({
        args: rest,
        options: {
          repo: { type: "string" },
          issue: { type: "string" },
          plan: { type: "string" },
          text: { type: "string" },
          lane: { type: "string", default: "standard" },
          "plan-effort": { type: "string" },
          "no-pr": { type: "boolean", default: false },
          wait: { type: "boolean", default: false },
          "no-notify": { type: "boolean", default: false },
          notify: { type: "string" },
          profile: { type: "string" },
        },
      });
      if (!values.repo || [values.issue, values.plan, values.text].filter(Boolean).length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const effort = values["plan-effort"];
      if (effort !== undefined && !["none", "medium", "high"].includes(effort)) throw new Error(`invalid --plan-effort ${effort}`);
      if (!["standard", "fast"].includes(values.lane)) throw new Error(`invalid --lane ${values.lane}`);
      const factoryHome = factoryHomeOf();
      if (values.notify !== undefined) {
        const named = await requireNotifyTarget(factoryHome, values.notify);
        if (!named.ok) {
          io.err(`factory: ${named.message}\n`);
          return 2;
        }
      }
      if (!values["no-notify"]) {
        const hook = await requireNotifyHook(factoryHome, resolve(values.repo));
        if (!hook.ok) {
          io.err(`factory: ${hook.message}\n`);
          return 2;
        }
      }
      // Best effort, bounded, never fails the run; FACTORY_NO_AUTO_GC=1 turns it off.
      if (process.env.FACTORY_NO_AUTO_GC !== "1") await autoGc({ factoryHome, github: new GhCli(), log: io.err });
      await sweepBaseRedRuns(factoryHome, io);
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        const result = await runFactory(
          {
            repo: values.repo,
            issue: values.issue !== undefined ? Number(values.issue) : undefined,
            planFile: values.plan,
            textFile: values.text,
            lane: values.lane as "standard" | "fast",
            planEffort: effort as "none" | "medium" | "high" | undefined,
            noPr: values["no-pr"],
            wait: values.wait,
            notifyTarget: values.notify,
          },
          {
            runner,
            github: new GhCli(),
            profile,
            sandbox: sandboxFor(profile, io),
            factoryHome,
            signal: controller.signal,
            docs: Context7Client.fromEnv(process.env),
            noNotify: values["no-notify"],
          },
        );
        io.out(JSON.stringify(result) + "\n");
        return exitCode(result.result, controller.signal);
      } finally {
        uninstall();
        await runner.close();
      }
    }
    if (command === "resume") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          wait: { type: "boolean", default: false },
          "no-pr": { type: "boolean" },
          notify: { type: "string" },
          profile: { type: "string" },
        },
      });
      if (positionals.length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const factoryHome = factoryHomeOf();
      if (values.notify !== undefined) {
        const named = await requireNotifyTarget(factoryHome, values.notify);
        if (!named.ok) {
          io.err(`factory: ${named.message}\n`);
          return 2;
        }
      }
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        const result = await resumeFactory(
          positionals[0]!,
          { wait: values.wait, noPr: values["no-pr"], notifyTarget: values.notify },
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal, docs: Context7Client.fromEnv(process.env) },
        );
        io.out(JSON.stringify(result) + "\n");
        return exitCode(result.result, controller.signal);
      } finally {
        uninstall();
        await runner.close();
      }
    }
    io.err(USAGE);
    return command === undefined || command === "--help" ? 0 : 2;
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
