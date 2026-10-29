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
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 1_000_000) output = output.slice(-500_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
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
