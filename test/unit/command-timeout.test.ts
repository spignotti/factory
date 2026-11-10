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

  it("includes stderr so an auth or already-exists failure is not only the command line", async () => {
    const bin = mkdtempSync(join(tmpdir(), "cmd-stderr-"));
    const script = join(bin, "gh");
    writeFileSync(script, "#!/bin/sh\necho 'a pull request for branch already exists' >&2\nexit 1\n");
    chmodSync(script, 0o755);
    await expect(ghCommand(bin, ["pr", "create"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } })).rejects.toThrow(
      /gh pr failed: a pull request for branch already exists/,
    );
  });
});

describe("execFileTimed output decoding", () => {
  it("keeps a multi-byte character that is split across chunks", async () => {
    const { execFileTimed } = await import("../../src/exec.js");
    // Write the two bytes of "ä" (0xC3 0xA4) in separate writes with a pause between them.
    const script = "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa4])), 50);";
    const out = await execFileTimed(process.execPath, ["-e", script], { timeoutMs: 10_000 });
    expect(out.stdout).toBe("ä");
  });
});
