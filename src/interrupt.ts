import { killRunningCommands } from "./exec.js";

/** The run was stopped by SIGINT/SIGTERM. Ends the run as `failed` with result.json written. */
export class Interrupted extends Error {
  constructor(readonly signalName: string) {
    super(`interrupted by ${signalName}`);
    this.name = "Interrupted";
  }
}

export interface SignalHandlerOptions {
  log?: (text: string) => void;
  /** Second signal while the first is still being handled; default: exit immediately. */
  onSecond?: (signal: NodeJS.Signals) => void;
}

/**
 * SIGINT/SIGTERM: kill every running command's process group, abort the run (agent sessions abort
 * through the signal and kill their own tool processes) and let it write result.json. A second
 * signal exits at once.
 */
export function installSignalHandlers(controller: AbortController, opts: SignalHandlerOptions = {}): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handler = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      (opts.onSecond ?? ((s) => process.exit(s === "SIGINT" ? 130 : 143)))(signal);
      return;
    }
    opts.log?.(`factory: ${signal} received, stopping the run and writing result.json (send again to exit now)\n`);
    killRunningCommands(signal);
    controller.abort(new Interrupted(signal));
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
