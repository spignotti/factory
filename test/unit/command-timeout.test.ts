import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GH_TIMEOUT_MS, ghCommand } from "../../src/gh.js";

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
    const started = Date.now();
    await expect(
      ghCommand(bin, ["api", "user"], { timeoutMs: 300, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } }),
    ).rejects.toThrow(/gh api timed out after 300ms \(process killed\)/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(alive(Number(readFileSync(childFile, "utf8")))).toBe(false);
  });
});
