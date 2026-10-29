import { spawn } from "node:child_process";
import { type Jail, jailedArgv } from "./sandbox/sandbox.js";

export interface ShResult {
  code: number;
  output: string;
  durationMs: number;
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
  if (killedBy) return Promise.resolve({ code: 130, output: `[factory] not started: ${killedBy}\n`, durationMs: 0 });
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
    child.on("close", (code) => {
      if (child.pid !== undefined) running.delete(child.pid);
      if (timer) clearTimeout(timer);
      if (killedBy) output += `\n[factory] killed: ${killedBy}\n`;
      resolve({ code: code ?? 1, output, durationMs: Date.now() - started });
    });
  });
}

export function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
