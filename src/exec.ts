import { spawn } from "node:child_process";

export interface ShResult {
  code: number;
  output: string;
  durationMs: number;
}

/** Runs a shell command, capturing stdout and stderr interleaved. Never throws on non-zero exit. */
export function sh(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<ShResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group, so a timeout kills everything the command started.
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, output, durationMs: Date.now() - started });
    });
  });
}

export function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
