import { spawn } from "node:child_process";
import { constants } from "node:os";
import { type Jail, jailedArgv } from "./sandbox/sandbox.js";

export interface ShResult {
  code: number;
  /** Set when the process died by signal. Absent means it exited; do not infer a signal from `code`. */
  signal?: NodeJS.Signals | null;
  output: string;
  durationMs: number;
}

/** POSIX status for a signal death (`128 + n`). `sh` must report this itself; a shell would map it to 1. */
export function signalExitCode(signal: NodeJS.Signals): number {
  const n = constants.signals[signal];
  return n === undefined ? 128 : 128 + n;
}

/** Process groups of commands still running, so a signal handler can kill them all. */
const running = new Set<number>();
let killedBy: string | undefined;

/** Kills every running command's process group; later `sh` calls return at once without running. */
export function killRunningCommands(reason: string): void {
  killedBy = reason;
  for (const pid of running) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Registers a long-lived process group (a service) so killRunningCommands reaches it too.
 * Returns the unregister function.
 */
export function trackProcessGroup(pid: number): () => void {
  running.add(pid);
  return () => void running.delete(pid);
}

/** Why commands are refused (killRunningCommands was called), or undefined. */
export function commandsKilled(): string | undefined {
  return killedBy;
}

/** Test hook: allow commands again after killRunningCommands. */
export function resetKilledCommands(): void {
  killedBy = undefined;
}

/** Runs a shell command, capturing stdout and stderr interleaved. Never throws on non-zero exit. */
export function sh(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; jail?: Jail },
): Promise<ShResult> {
  const started = Date.now();
  if (killedBy) return Promise.resolve({ code: 130, signal: null, output: `[factory] not started: ${killedBy}\n`, durationMs: 0 });
  return new Promise((resolve) => {
    // Own process group, so a timeout kills everything the command started.
    const [file, ...args] = jailedArgv(opts.jail, "sh", command, opts.cwd, opts.env);
    const child = spawn(file!, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid !== undefined) running.add(child.pid);
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 1_000_000) output = output.slice(-500_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            output += `\n[factory] timed out after ${Math.round(opts.timeoutMs! / 1000)}s\n`;
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, opts.timeoutMs)
        : undefined;
    child.on("error", (e) => {
      output += String(e);
    });
    child.on("close", (code, signal) => {
      if (child.pid !== undefined) running.delete(child.pid);
      if (timer) clearTimeout(timer);
      if (killedBy) output += `\n[factory] killed: ${killedBy}\n`;
      // A signal death has `code === null`. Mapping that to 1 makes a SIGKILL look like a failing test.
      resolve({
        code: signal ? signalExitCode(signal) : (code ?? 1),
        signal: signal ?? null,
        output,
        durationMs: Date.now() - started,
      });
    });
  });
}

export function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** Human-readable duration for a command timeout (`60s`, or `300ms` below 1s). */
export function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export function commandTimeoutMessage(file: string, args: string[], timeoutMs: number): string {
  const sub = args[0] ?? "";
  return `${file}${sub ? ` ${sub}` : ""} timed out after ${formatDuration(timeoutMs)} (process killed)`;
}

/** A command killed because it exceeded its wall-clock cap. The process group is already dead. */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(file: string, args: string[], timeoutMs: number) {
    super(commandTimeoutMessage(file, args, timeoutMs));
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isCommandTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = err; cur instanceof Error && !seen.has(cur); cur = cur.cause) {
    if (cur instanceof CommandTimeoutError) return true;
    seen.add(cur);
  }
  return false;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a binary and kills its process group when `timeoutMs` elapses.
 * A missing cwd or binary still rejects with Node's `spawn <file> ENOENT`.
 */
export function execFileTimed(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let untrack = () => {};
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so a timeout kills helpers (ssh, git-remote) and not just the parent.
      detached: true,
    });
    untrack = child.pid !== undefined ? trackProcessGroup(child.pid) : () => {};
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
    }, opts.timeoutMs);
    timer.unref();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      untrack();
      fn();
    };
    // setEncoding gives each stream a stateful UTF-8 decoder, so a character split across chunks stays intact.
    const take = (chunk: string, which: "stdout" | "stderr") => {
      const next = (which === "stdout" ? stdout : stderr) + chunk;
      if (Buffer.byteLength(next) > maxBuffer) {
        killProcessGroup(child.pid);
        finish(() => reject(Object.assign(new Error(`${file} ${args[0] ?? ""} exceeded maxBuffer`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout, stderr })));
        return;
      }
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => take(d, "stdout"));
    child.stderr?.on("data", (d: string) => take(d, "stderr"));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(() => reject(new CommandTimeoutError(file, args, opts.timeoutMs)));
        return;
      }
      if (code === 0 && !signal) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }
      const exit = signal ? signalExitCode(signal) : (code ?? 1);
      const why = signal ? `killed by ${signal}` : `exit ${exit}`;
      finish(() => reject(Object.assign(new Error(`Command failed: ${file} ${args.join(" ")} (${why})`), { code: exit, stdout, stderr, killed: Boolean(signal), signal: signal ?? null })));
    });
  });
}
