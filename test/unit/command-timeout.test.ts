import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GH_TIMEOUT_MS, ghCommand } from "../../src/gh.js";

/** Resolves once the fake wrote its pid file; fails if the command errors out first. */
async function readyFile(path: string, run: Promise<unknown>): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > 4_000) throw new Error("fake never started");
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("command timeouts for the github cli", () => {
  it("defaults to 2 minutes", () => {
    expect(GH_TIMEOUT_MS).toBe(2 * 60_000);
  });

  it("kills the process group and names the timeout", async () => {
    const bin = mkdtempSync(join(tmpdir(), "cmd-timeout-"));
    const pidFile = join(bin, "pid");
    const childFile = join(bin, "child");
    const script = join(bin, "gh");
    writeFileSync(script, "#!/bin/sh\necho $$ > " + JSON.stringify(pidFile) + "\nsleep 30 &\necho $! > " + JSON.stringify(childFile) + "\nwait\n");
    chmodSync(script, 0o755);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    // The timeout must fire after the script actually started: wait for its pid file, otherwise a
    // loaded test worker can kill the fake before it wrote anything and the check is vacuous.
    const run = ghCommand(bin, ["api", "user"], { timeoutMs: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    await readyFile(pidFile, run);
    const started = Date.now();
    await expect(run).rejects.toThrow(/gh api timed out after 10s \(process killed\)/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(alive(Number(readFileSync(childFile, "utf8")))).toBe(false);
  });
});
