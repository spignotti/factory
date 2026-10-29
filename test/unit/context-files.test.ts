import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ancestorContextFiles, isolatedContextFiles, worktreeRoot } from "../../src/agents/context-files.js";
import { PiRunner } from "../../src/agents/pi-runner.js";
import { contextFileChecks } from "../../src/commands/doctor.js";

/** base/{AGENTS.md, CLAUDE.md} above a repo with its own AGENTS.md, a .git dir and a src/ subdir. */
function layout(): { base: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), "ctx-"));
  writeFileSync(join(base, "AGENTS.md"), "ANCESTOR RULE\n");
  writeFileSync(join(base, "CLAUDE.md"), "ANCESTOR CLAUDE\n");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "AGENTS.md"), "\uFEFFREPO RULE\n");
  return { base, repo };
}

describe("agent context isolation", () => {
  it("only the worktree root's AGENTS.md, also from a subdirectory; no ancestors", () => {
    const { repo } = layout();
    expect(worktreeRoot(join(repo, "src"))).toBe(repo);
    expect(isolatedContextFiles(join(repo, "src"))).toEqual({ files: [{ path: join(repo, "AGENTS.md"), content: "REPO RULE\n" }], warnings: [] });
  });

  it("AGENTS.override.md is ignored with a warning; no AGENTS.md means no context", () => {
    const { repo } = layout();
    writeFileSync(join(repo, "AGENTS.override.md"), "OVERRIDE\n");
    const r = isolatedContextFiles(repo);
    expect(r.files.map((f) => f.content)).toEqual(["REPO RULE\n"]);
    expect(r.warnings).toEqual([expect.stringMatching(/AGENTS\.override\.md ignored/)]);
    const bare = mkdtempSync(join(tmpdir(), "ctx-bare-"));
    mkdirSync(join(bare, ".git"));
    expect(isolatedContextFiles(bare)).toEqual({ files: [], warnings: [] });
  });

  it("the Pi session gets the worktree AGENTS.md once and nothing from ancestors or the agent dir", async () => {
    const { base, repo } = layout();
    const home = join(base, "home");
    mkdirSync(join(home, "pi"), { recursive: true });
    writeFileSync(join(home, "pi", "AGENTS.md"), "AGENT DIR RULE\n");
    writeFileSync(join(home, "pi", "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "fake-go-key" } }));
    writeFileSync(join(repo, "AGENTS.override.md"), "OVERRIDE\n");
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        bodies.push(b);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(join(home, "pi", "models.json"), JSON.stringify({ providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${port}/inference/go/v1` } } }));
      const activity: string[] = [];
      const runner = new PiRunner(join(home, "pi"));
      await expect(
        runner.run({ role: "plan_high", model: "opencode-go/deepseek-v4.1-flash", cwd: repo, system: "SYSTEM", prompt: "hi", tools: "none", env: {}, onActivity: (a) => activity.push(a.detail ?? "") }),
      ).rejects.toThrow();
      const sent = bodies.join("\n");
      expect(sent.split("REPO RULE").length - 1).toBe(1);
      for (const leak of ["ANCESTOR RULE", "ANCESTOR CLAUDE", "AGENT DIR RULE", "OVERRIDE"]) expect(sent).not.toContain(leak);
      expect(activity).toContain("warning: AGENTS.override.md ignored: the factory reads only AGENTS.md at the worktree root");
    } finally {
      server.close();
    }
  });

  it("doctor warns about context files plain Pi would load (agent dir, run-worktree ancestors, override)", () => {
    const { base, repo } = layout();
    const home = join(base, "home");
    mkdirSync(join(home, "pi"), { recursive: true });
    expect(ancestorContextFiles(join(home, "runs", "_"))).toEqual([join(base, "AGENTS.md"), join(base, "CLAUDE.md")]);
    writeFileSync(join(home, "pi", "AGENTS.md"), "x\n");
    writeFileSync(join(repo, "AGENTS.override.md"), "x\n");
    const checks = contextFileChecks(home, repo);
    expect(checks.map((c) => c.status)).toEqual(["warn", "warn"]);
    expect(checks[0]!.detail).toContain(join(home, "pi", "AGENTS.md"));
    expect(checks[0]!.detail).toContain(join(base, "CLAUDE.md"));
    expect(checks[1]!.detail).toMatch(/AGENTS\.override\.md is ignored/);
    const clean = mkdtempSync(join(tmpdir(), "ctx-clean-"));
    expect(contextFileChecks(join(clean, "home")).map((c) => c.status)).toEqual(tmpHasContext() ? ["warn"] : ["ok"]);
  });
});

/** The temp dir's own ancestors could hold a context file on a dev machine; tolerate that. */
function tmpHasContext(): boolean {
  return ancestorContextFiles(join(tmpdir(), "x"), {}).length > 0;
}
