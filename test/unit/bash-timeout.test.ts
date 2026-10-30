import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveTimeoutS, toolDefinitions, withCommandTimeout } from "../../src/agents/pi-runner.js";
import { RepoConfigSchema } from "../../src/schemas/repo.js";

type Exec = (id: string, params: { command: string; timeout?: number }, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function bashTool(commandTimeoutMs?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "bash-timeout-"));
  const [def] = toolDefinitions({ cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, commandTimeoutMs }, ["bash"]) as unknown as { name: string; description: string; execute: Exec }[];
  return def!;
}

describe("agent bash command timeout", () => {
  it("defaults to 10 minutes in repo.yaml, below the 15 min watchdog", () => {
    const limits = RepoConfigSchema.parse({}).limits;
    expect(limits.command_timeout_minutes).toBe(10);
    expect(limits.command_timeout_minutes).toBeLessThan(limits.stall_minutes);
  });

  it("uses the limit when the model sets none, and caps a larger one", () => {
    expect(effectiveTimeoutS(undefined, 600)).toBe(600);
    expect(effectiveTimeoutS(30, 600)).toBe(30);
    expect(effectiveTimeoutS(3600, 600)).toBe(600);
    expect(effectiveTimeoutS(0, 600)).toBe(600);
    expect(effectiveTimeoutS(Number.NaN, 600)).toBe(600);
  });

  it("passes the effective timeout to the wrapped tool and names it in the description", async () => {
    const seen: (number | undefined)[] = [];
    const def = { description: "Run bash.", execute: async (_id: string, p: { command: string; timeout?: number }) => (seen.push(p.timeout), p.command) };
    const wrapped = withCommandTimeout(def, 600_000);
    await wrapped.execute("1", { command: "a" });
    await wrapped.execute("2", { command: "b", timeout: 5 });
    await wrapped.execute("3", { command: "c", timeout: 9999 });
    expect(seen).toEqual([600, 5, 600]);
    expect(wrapped.description).toMatch(/killed after 600 seconds/);
  });

  it("a command that never exits returns a timeout error to the model instead of hanging", async () => {
    const bash = bashTool(1000);
    const started = Date.now();
    await expect(bash.execute("t", { command: "echo started; sleep 30" })).rejects.toThrow(/started[\s\S]*Command timed out after 1 seconds/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("stdin is closed: a command waiting for input gets EOF", async () => {
    const bash = bashTool(5000);
    const r = await bash.execute("s", { command: "read -r x || echo eof" });
    expect(r.content[0]!.text).toContain("eof");
  }, 20_000);

  it("without a limit the Pi default (no timeout) stays", () => {
    expect(bashTool(undefined).description).not.toMatch(/killed after/);
  });
});
