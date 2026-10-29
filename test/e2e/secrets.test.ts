import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context7Client, type FetchLike } from "../../src/docs/context7.js";
import { runScenario } from "../helpers/scenario.js";

const VALUE = "app-secret-value-7f3a9c2e51";

/** Every file under the run dir except the worktree and agent HOME (what the factory wrote). */
function runFiles(dir: string, skip = ["worktree", "home", "plan-base", "eval-base"]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.includes(e.name)) out.push(...runFiles(p, skip));
    } else if (statSync(p).size < 5_000_000) out.push(p);
  }
  return out;
}

function writeSecrets(factoryHome: string, repo: string, text: string, mode = 0o600): void {
  mkdirSync(join(factoryHome, "secrets"), { recursive: true });
  const file = join(factoryHome, "secrets", `${repo.split("/").pop()}.env`);
  writeFileSync(file, text);
  chmodSync(file, mode);
}

describe("repo secrets in a run (env_file provider)", () => {
  it("checks get the value; agents, prompts, events, run files and the PR never do", async () => {
    const r = await runScenario({
      script: "gate-fail-fix.json",
      patch: (cfg) => {
        cfg.secrets = { provider: "env_file", names: ["APP_SECRET"] };
        // Listing it for agents too must not leak it (secrets win).
        cfg.agent_env = ["APP_SECRET"];
        const checks = cfg.checks as { name: string; run: string }[];
        // Fails in round 1 (syntax error) and prints the value: the failure goes into the fix prompt.
        checks[0]!.run = `test "$APP_SECRET" = "${VALUE}" || exit 9; echo "token=$APP_SECRET"; node --check src/math.js`;
      },
      before: (repo, home) => writeSecrets(home, repo, `# test\nexport APP_SECRET="${VALUE}"\n`),
      deps: { parentEnv: { ...process.env, APP_SECRET: VALUE } },
      // The PR writer echoes it as if it had seen it: the PR body is redacted anyway.
      steps: (steps) => steps.map((s) => (s.role === "pr_writer" ? { ...s, raw: `${s.raw} (${VALUE})` } : s)),
    });
    expect(r.result.result).toBe("done");
    // The check saw the value (exit 9 otherwise) and round 2 is green.
    const gate1 = JSON.parse(r.file("gates-1.json"));
    expect(gate1.checks.find((c: { name: string }) => c.name === "syntax").output_tail).toContain("token=[redacted]");
    expect(JSON.parse(r.file("gates-2.json")).green).toBe(true);
    const fix = r.runner.calls.filter((c) => c.role === "implement")[1]!;
    expect(fix.prompt).toContain("token=[redacted]");
    for (const call of r.runner.calls) {
      expect(call.prompt).not.toContain(VALUE);
      expect(call.env.APP_SECRET).toBeUndefined();
      expect(Object.values(call.env)).not.toContain(VALUE);
    }
    expect(r.eventsText).not.toContain(VALUE);
    const ev = r.events.find((e) => (e.data as { secrets?: unknown }).secrets);
    expect(ev?.data).toEqual({ secrets: { provider: "env_file", resolved: 1, missing: [] } });
    for (const f of runFiles(r.runDir)) expect(readFileSync(f, "utf8"), f).not.toContain(VALUE);
    const pr = r.github.prs[0]!;
    expect(pr.body).toContain("[redacted]");
    expect(pr.body + pr.title).not.toContain(VALUE);
  });

  it("factory tool results (docs, browser) are redacted before they reach the model", async () => {
    const fetch: FetchLike = async (href) => ({
      status: 200,
      headers: { get: () => null },
      text: async () => (new URL(href).pathname.endsWith("/search") ? JSON.stringify({ results: [{ id: "/x/y", title: "Y" }] }) : `config example: KEY=${VALUE}`),
    });
    const r = await runScenario({
      script: "clean.json",
      patch: (cfg) => void (cfg.secrets = { provider: "env_file", names: ["APP_SECRET"] }),
      before: (repo, home) => writeSecrets(home, repo, `APP_SECRET=${VALUE}\n`),
      deps: { docs: new Context7Client({ fetch }) },
      steps: (steps) => steps.map((s) => (s.role === "implement" ? { ...s, tool_calls: [{ tool: "docs_lookup", args: { library: "y", topic: "config" } }] } : s)),
    });
    expect(r.result.result).toBe("done");
    const text = r.runner.calls.find((c) => c.role === "implement")!.toolResults![0]!.text;
    expect(text).toContain("KEY=[redacted]");
    expect(text).not.toContain(VALUE);
  });

  it("a name that does not resolve stops the run before any agent call (needs_human)", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (cfg) => void (cfg.secrets = { provider: "env_file", names: ["APP_SECRET", "OTHER_KEY"] }),
      before: (repo, home) => writeSecrets(home, repo, `APP_SECRET=${VALUE}\n`),
    });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toContain("OTHER_KEY");
    expect(r.runner.calls).toHaveLength(0);
    expect(r.eventsText).not.toContain(VALUE);
  });

  it("a group-readable secrets file is refused", async () => {
    const r = await runScenario({
      script: "clean.json",
      patch: (cfg) => void (cfg.secrets = { provider: "env_file", names: ["APP_SECRET"] }),
      before: (repo, home) => writeSecrets(home, repo, `APP_SECRET=${VALUE}\n`, 0o640),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toContain("chmod 600");
    expect(r.runner.calls).toHaveLength(0);
  });
});
