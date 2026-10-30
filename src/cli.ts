#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { PiRunner } from "./agents/pi-runner.js";
import { renderCiStub } from "./ci.js";
import { doctorCommand } from "./commands/doctor.js";
import { Context7Client } from "./docs/context7.js";
import { evalCommand, experimentCommand, validateCommand } from "./commands/eval.js";
import { gatesCommand, type Io } from "./commands/gates.js";
import { gcCommand } from "./commands/gc.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { adoptCommand } from "./commands/adopt.js";
import { hardenCommand } from "./commands/harden.js";
import { MAX_PROPOSALS_LIMIT } from "./schemas/repo.js";
import { GhCli } from "./gh.js";
import { installSignalHandlers, Interrupted } from "./interrupt.js";
import { resumeFactory, runFactory } from "./pipeline/run.js";
import { createSandbox, type Sandbox } from "./sandbox/sandbox.js";
import type { Profile } from "./schemas/profile.js";
import { factoryHomeOf, loadLayers, resolveProfile } from "./config.js";
import { asset } from "./prompts.js";
import { notifyTest } from "./notify.js";
import { notifyList, notifyRemove, notifySet, ttyPrompter } from "./commands/notify.js";

const USAGE = `usage:
  factory --version
  factory run --repo <path> (--issue <n> | --plan <file> | --text <file>) [--lane standard|fast]
              [--plan-effort none|medium|high] [--no-pr] [--profile <file>] [--wait]
              (one run per repo at a time: busy repo → result "locked", or queue with --wait)
  factory resume <run-id> [--wait] [--no-pr] [--profile <file>]
              (after a human fix: commits it, merges base, re-runs gates, continues; updates the PR)
  factory doctor [--repo <path>] [--profile <file>] [--ping] [--services] [--json]
              (setup checks, Zen guard, ChatGPT login; effective model per role and its layer;
               CI stub hash; --ping sends one tiny request per configured model;
               --services starts and stops each service and the ui once in a clean base worktree)
  models: built-in < $FACTORY_HOME/profile.yaml < --profile <file> < repo.yaml models: (see README)
  factory status [--json]
              (running, waiting for a human, interrupted runs; open factory PRs)
  factory stats [--since 7d] [--repo <path>] [--json]
              (results, rounds, gates, providers, cost; this period vs the previous one)
  factory gc [--dry-run] [--force] [--json]
              (worktree, factory/* branch and unchanged remote branch of merged/closed PRs)
  factory gates (--select | --run <check|selected>) [--tier fast|full|manual] [--base <ref>] [--repo <path>] [--json]
              (--run starts the services its checks need)
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
  factory notify set <owner/name> [--key-file] [--header <name>] [--scheme <word>] [--test | --no-test]
              (asks for the routine's webhook URL and key on the terminal, input hidden; writes
               $FACTORY_HOME/notify.yaml 0600, with --key-file the key to $FACTORY_HOME/keys/<owner>__<name>)
  factory notify list [--json]      (repos with a hook; never URLs or keys)
  factory notify remove <owner/name>
  factory notify test <owner/name>
              (one test POST to the repo's webhook from $FACTORY_HOME/notify.yaml; doctor lists the configured repos)
  factory ci-stub [--ref <tag>]
              (prints .github/workflows/factory.yml for a pinned factory ref, default v<version>; doctor checks its hash)
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

/** Package version, plus the commit when run from a git checkout (npm link / checkout installs). */
function packageVersion(): string {
  return (JSON.parse(asset("package.json")) as { version: string }).version;
}

/** Default CI-stub pin: the release tag of this factory version (`v<package.json version>`). */
export function defaultRef(): string {
  return `v${packageVersion()}`;
}

function versionString(): string {
  const version = packageVersion();
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    if (!existsSync(join(root, ".git"))) return version;
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return sha ? `${version} (${sha})` : version;
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
          run: { type: "string" },
          tier: { type: "string", default: "fast" },
          base: { type: "string" },
          repo: { type: "string", default: "." },
          json: { type: "boolean", default: false },
        },
      });
      return await gatesCommand({ ...values, repo: values.repo, tier: values.tier, select: values.select, json: values.json }, io);
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
      const workDir = values["work-dir"] ?? join(factoryHome, "eval", "work");
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
    if (command === "ci-stub") {
      const { values } = parseArgs({ args: rest, options: { ref: { type: "string" } } });
      io.out(renderCiStub(values.ref ?? defaultRef()));
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
      const [sub, ...args] = rest;
      if (sub === "list") {
        const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
        return notifyList(factoryHomeOf(), io, values.json);
      }
      if (sub === "set") {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          allowNegative: true,
          options: { "key-file": { type: "boolean", default: false }, header: { type: "string" }, scheme: { type: "string" }, test: { type: "boolean" } },
        });
        if (positionals.length !== 1) {
          io.err(USAGE);
          return 2;
        }
        let prompter;
        try {
          prompter = ttyPrompter();
        } catch (e) {
          io.err(`factory: ${(e as Error).message}\n`);
          return 1;
        }
        return await notifySet(
          { factoryHome: factoryHomeOf(), repo: positionals[0]!, keyFile: values["key-file"], header: values.header, scheme: values.scheme, test: values.test },
          prompter,
          io,
        );
      }
      const [repo, ...extra] = args;
      if (sub === "remove" && repo && !extra.length) return notifyRemove(factoryHomeOf(), repo, io);
      if (sub !== "test" || !repo || extra.length) {
        io.err(USAGE);
        return 2;
      }
      const r = await notifyTest(repo, { factoryHome: factoryHomeOf() });
      (r.ok ? io.out : io.err)(`${r.ok ? "" : "factory: "}${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    if (command === "status") {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } } });
      return await statusCommand({ factoryHome: factoryHomeOf(), github: new GhCli(), json: values.json }, io);
    }
    if (command === "stats") {
      const { values } = parseArgs({
        args: rest,
        options: { since: { type: "string", default: "7d" }, repo: { type: "string" }, json: { type: "boolean", default: false } },
      });
      return statsCommand({ factoryHome: factoryHomeOf(), since: values.since, repo: values.repo, json: values.json }, io);
    }
    if (command === "gc") {
      const { values } = parseArgs({
        args: rest,
        options: { "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
      });
      return await gcCommand({ factoryHome: factoryHomeOf(), github: new GhCli(), dryRun: values["dry-run"], force: values.force, json: values.json }, io);
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
          },
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal, docs: Context7Client.fromEnv(process.env) },
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
          profile: { type: "string" },
        },
      });
      if (positionals.length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const factoryHome = factoryHomeOf();
      const profile = resolveProfile(loadLayers({ factoryHome, profile: values.profile }));
      const runner = new PiRunner(join(factoryHome, "pi"));
      const controller = new AbortController();
      const uninstall = installSignalHandlers(controller, { log: io.err });
      try {
        const result = await resumeFactory(
          positionals[0]!,
          { wait: values.wait, noPr: values["no-pr"] },
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
