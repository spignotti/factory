#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiRunner } from "./agents/pi-runner.js";
import { gatesCommand, type Io } from "./commands/gates.js";
import { GhCli } from "./gh.js";
import { installSignalHandlers, Interrupted } from "./interrupt.js";
import { runFactory } from "./pipeline/run.js";
import { loadProfile } from "./schemas/profile.js";

const USAGE = `usage:
  factory run --repo <path> (--issue <n> | --plan <file> | --text <file>) [--lane standard|fast]
              [--plan-effort none|medium|high] [--no-pr] [--profile <name>]
  factory gates (--select | --run <check|selected>) [--tier fast|full|manual] [--base <ref>] [--repo <path>] [--json]
`;

function exitCode(result: string, signal: AbortSignal): number {
  const reason: unknown = signal.reason;
  if (reason instanceof Interrupted) return reason.signalName === "SIGINT" ? 130 : 143;
  return result === "failed" ? 1 : 0;
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
          profile: { type: "string", default: "default" },
        },
      });
      if (!values.repo || [values.issue, values.plan, values.text].filter(Boolean).length !== 1) {
        io.err(USAGE);
        return 2;
      }
      const effort = values["plan-effort"];
      if (effort !== undefined && !["none", "medium", "high"].includes(effort)) throw new Error(`invalid --plan-effort ${effort}`);
      if (!["standard", "fast"].includes(values.lane)) throw new Error(`invalid --lane ${values.lane}`);
      const factoryHome = process.env.FACTORY_HOME ?? join(homedir(), ".factory");
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
          },
          { runner, github: new GhCli(), profile: loadProfile(values.profile), factoryHome, signal: controller.signal },
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
