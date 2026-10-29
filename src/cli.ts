#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gatesCommand, type Io } from "./commands/gates.js";

const USAGE = `usage:
  factory run --repo <path> (--issue <n> | --plan <file> | --text <file>) [--lane standard|fast]
              [--plan-effort none|medium|high] [--no-pr] [--profile <name>]
  factory gates (--select | --run <check|selected>) [--tier fast|full|manual] [--base <ref>] [--repo <path>] [--json]
`;

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
