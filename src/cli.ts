#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { PiRunner } from "./agents/pi-runner.js";
import { renderCiStub } from "./ci.js";
import { doctorCommand } from "./commands/doctor.js";
import { gatesCommand, type Io } from "./commands/gates.js";
import { gcCommand } from "./commands/gc.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { GhCli } from "./gh.js";
import { installSignalHandlers, Interrupted } from "./interrupt.js";
import { resumeFactory, runFactory } from "./pipeline/run.js";
import { createSandbox, type Sandbox } from "./sandbox/sandbox.js";
import type { Profile } from "./schemas/profile.js";
import { factoryHomeOf, loadLayers, resolveProfile } from "./config.js";

const USAGE = `usage:
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
              (--run starts the services its checks need, §6.12)
  factory ci-stub --ref <tag>
              (prints .github/workflows/factory.yml for a pinned factory ref; doctor checks its hash)
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

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
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
    if (command === "ci-stub") {
      const { values } = parseArgs({ args: rest, options: { ref: { type: "string" } } });
      if (!values.ref) {
        io.err(USAGE);
        return 2;
      }
      io.out(renderCiStub(values.ref));
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
        { factoryHome: factoryHomeOf(), repo: values.repo, profile: values.profile, ping: values.ping, services: values.services, json: values.json },
        io,
      );
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
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal },
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
          { runner, github: new GhCli(), profile, sandbox: sandboxFor(profile, io), factoryHome, signal: controller.signal },
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
