import { execFileSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Io } from "./gates.js";
import { resolveNode } from "../node-runtime.js";
import { activateHandoff, defaultStartWorker, planHandoff, renderHandoffPlan, renderReleaseStatus, releaseStatus, type StartWorker } from "../release/handoff.js";
import { candidateExists, listCandidates, readCandidate } from "../release/state.js";
import { approveCandidate, stageCandidate } from "../release/stage.js";

/**
 * `factory release`: stage a tested, version-pinned candidate, approve it, then activate it through
 * the single-worker handoff. Building and testing happen outside the executing installation, and
 * activation is always an explicit call that names one exact artifact (#187).
 */

export interface ReleaseCommandDeps {
  factoryHome: string;
  io: Io;
  /** Runs one build or test command inside the staged tree. Tests inject a fake; the CLI shells out. */
  run?: (cmd: string, cwd: string) => void;
  /** Starts the new worker. The default spawns the candidate's own `queue run --stay`. */
  startWorker?: StartWorker;
}

const USAGE = "factory: usage: factory release stage|list|approve|plan|activate|status\n";
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Runs a command with the resolved node first on PATH, as the box launcher does. */
function runCommand(cmd: string, cwd: string): void {
  const node = resolveNode();
  const env = "error" in node ? process.env : { ...process.env, PATH: `${node.path.replace(/[/\\]node$/, "")}:${process.env.PATH ?? ""}` };
  execFileSync("bash", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000 });
}

/** `--commit`, else the commit recorded by a staging build in `BUILD.json`, else git in `--source`. */
function resolveCommit(opts: { commit?: string; from?: string; source?: string; ref?: string }): string | undefined {
  if (opts.commit) return opts.commit;
  if (opts.from) {
    try {
      const build = JSON.parse(readFileSync(join(opts.from, "BUILD.json"), "utf8")) as { commit?: string };
      if (typeof build.commit === "string" && FULL_SHA.test(build.commit)) return build.commit;
    } catch {
      // no BUILD.json: the source decides
    }
  }
  if (opts.source) {
    try {
      const sha = execFileSync("git", ["rev-parse", opts.ref ?? "HEAD"], { cwd: opts.source, encoding: "utf8" }).trim();
      return FULL_SHA.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function releaseCommand(argv: string[], deps: ReleaseCommandDeps): Promise<number> {
  const [sub, ...rest] = argv;
  const io = deps.io;
  const home = deps.factoryHome;
  const run = deps.run ?? runCommand;

  if (sub === "status" || sub === "list") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
    if (positionals.length) {
      io.err(USAGE);
      return 2;
    }
    if (sub === "status") {
      const status = releaseStatus(home);
      io.out(values.json ? JSON.stringify(status) + "\n" : renderReleaseStatus(status));
      return 0;
    }
    const rows = listCandidates(home);
    if (values.json) io.out(JSON.stringify({ candidates: rows }) + "\n");
    else io.out(rows.length ? rows.map((c) => `${c.id} tested:${c.tested ? c.checks_passed.join(",") || "no" : "no"} approved:${c.approval ? "yes" : "no"}`).join("\n") + "\n" : "no staged candidates\n");
    return 0;
  }

  if (sub === "stage") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        commit: { type: "string" },
        ref: { type: "string" },
        source: { type: "string" },
        from: { type: "string" },
        build: { type: "string", multiple: true },
        test: { type: "string", multiple: true },
        approve: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    if (positionals.length) {
      io.err(USAGE);
      return 2;
    }
    const from = values.from ? resolve(values.from) : undefined;
    const source = values.source ? resolve(values.source) : undefined;
    if (!from && !source) {
      io.err("factory: release stage needs --from <built tree> or --source <git checkout>\n");
      return 2;
    }
    const commit = resolveCommit({ ...(values.commit ? { commit: values.commit } : {}), ...(from ? { from } : {}), ...(source ? { source, ref: values.ref } : {}) });
    if (!commit) {
      io.err("factory: no full commit sha to pin: pass --commit <sha>, or a --source/--from that names one\n");
      return 2;
    }
    if (!FULL_SHA.test(commit)) {
      io.err(`factory: "${commit}" is not a full commit sha; a candidate is pinned to one exact build\n`);
      return 2;
    }
    try {
      const staged = await stageCandidate({
        home,
        commit,
        ...(values.ref ? { ref: values.ref } : {}),
        install: (dir) => {
          if (from) cpSync(from, dir, { recursive: true });
          else execFileSync("bash", ["-c", `git -C ${JSON.stringify(source!)} archive ${JSON.stringify(commit)} | tar -x -C ${JSON.stringify(dir)}`], { stdio: ["ignore", "pipe", "pipe"] });
        },
        checks: [
          ...(values.build ?? []).map((cmd) => ({ name: `build: ${cmd}`, run: (candidateDir: string) => run(cmd, candidateDir) })),
          ...(values.test ?? []).map((cmd) => ({ name: `test: ${cmd}`, run: (candidateDir: string) => run(cmd, candidateDir) })),
        ],
      });
      const candidate = values.approve ? approveCandidate(home, staged.id) : staged;
      if (values.json) io.out(JSON.stringify(candidate) + "\n");
      else {
        io.out(`staged ${candidate.id} (tested: ${candidate.tested ? candidate.checks_passed.join(", ") : "no checks"})\n`);
        io.out(candidate.approval ? `approved ${candidate.id}: factory release activate ${candidate.id} --yes\n` : `not approved: factory release approve ${candidate.id}, then activate\n`);
      }
      return 0;
    } catch (e) {
      io.err(`factory: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (sub === "approve") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
    if (positionals.length !== 1 || !candidateExists(home, positionals[0]!)) {
      io.err(positionals.length === 1 ? `factory: candidate ${positionals[0]} is not staged\n` : USAGE);
      return positionals.length === 1 ? 1 : 2;
    }
    try {
      const candidate = approveCandidate(home, positionals[0]!);
      io.out(values.json ? JSON.stringify(candidate) + "\n" : `approved ${candidate.id} for activation\n`);
      return 0;
    } catch (e) {
      io.err(`factory: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (sub === "plan") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
    if (positionals.length !== 1) {
      io.err(USAGE);
      return 2;
    }
    const plan = planHandoff({ home, id: positionals[0]! });
    io.out(values.json ? JSON.stringify(plan) + "\n" : renderHandoffPlan(plan));
    return plan.ready ? 0 : 1;
  }

  if (sub === "activate") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { yes: { type: "boolean", default: false }, "allow-migration": { type: "boolean", default: false }, "drain-timeout": { type: "string" }, json: { type: "boolean", default: false } },
    });
    if (positionals.length !== 1) {
      io.err(USAGE);
      return 2;
    }
    if (!values.yes) {
      io.err("factory: activation is a controlled operation; read factory release plan, then re-run with --yes\n");
      return 2;
    }
    const id = positionals[0]!;
    if (!readCandidate(home, id)) {
      io.err(`factory: candidate ${id} is not staged\n`);
      return 1;
    }
    const drainTimeoutMs = values["drain-timeout"] === undefined ? undefined : Number(values["drain-timeout"]);
    if (drainTimeoutMs !== undefined && (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0)) {
      io.err(`factory: invalid --drain-timeout ${values["drain-timeout"]}\n`);
      return 2;
    }
    const res = await activateHandoff({
      home,
      id,
      io,
      startWorker: deps.startWorker ?? defaultStartWorker(home),
      ...(values["allow-migration"] ? { allowMigration: true } : {}),
      ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
    });
    if (values.json) io.out(JSON.stringify(res) + "\n");
    return res.ok ? 0 : 1;
  }

  io.err(USAGE);
  return sub === undefined || sub === "--help" ? 0 : 2;
}
