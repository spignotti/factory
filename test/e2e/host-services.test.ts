import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRequest } from "../../src/agents/runner.js";
import { createSandbox, hostProbe, type Sandbox } from "../../src/sandbox/sandbox.js";
import { runScenario } from "../helpers/scenario.js";

/**
 * Host services with fixed ports and env_from (e.g. a Docker DB stack started outside the sandbox):
 * a jailed check reaches exactly the fixed host ports and gets the env_from values; agents get neither;
 * the values are redacted everywhere; stop runs at run end (success and failure).
 */

const KEY = "svc-role-key-4b8e1f0c9d27a6";

const realSandbox = ((): Sandbox | undefined => {
  try {
    return createSandbox("required", hostProbe);
  } catch {
    return undefined;
  }
})();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

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

const FETCH = `node -e "fetch(process.env.DB_URL).then(r=>r.text()).then(t=>process.exit(t==='stack'?0:1),e=>{console.log(String(e));process.exit(8)})"`;

function hostDb(port: number, marks: string, envFrom: string) {
  return (cfg: Record<string, unknown>) => {
    cfg.services = [
      {
        name: "db",
        host: true,
        // Foreground host process on a fixed loopback port (a stand-in for `supabase start`).
        start: `touch ${marks}/started; node -e "require('http').createServer((q,r)=>r.end('stack')).listen(${port},'127.0.0.1')"`,
        stop: `touch ${marks}/restored`,
        ports: [port],
        env_from: { command: envFrom, map: { DB_URL: "API_URL", DB_KEY: "SERVICE_ROLE_KEY" } },
        ready_timeout_s: 20,
      },
    ];
    const checks = cfg.checks as Record<string, unknown>[];
    // Fails in round 1 (syntax error) and prints the key: the failure goes into the fix prompt.
    checks[0]!.run = `test "$DB_KEY" = "${KEY}" || exit 9; ${FETCH} || exit 8; echo "key=$DB_KEY"; node --check src/math.js`;
    checks[0]!.services = ["db"];
    checks[0]!.local_only = true;
  };
}

describe("host services: fixed ports and env_from", () => {
  for (const jailed of [false, true]) {
    it.skipIf(jailed && !realSandbox)(`checks reach the fixed port and get env_from; agents never; values redacted; stop at run end${jailed ? " (sandboxed)" : ""}`, async () => {
      const port = await freePort();
      const marks = mkdtempSync(join(tmpdir(), "hostsvc-marks-"));
      const envFrom = `echo "Stopped services: none" >&2; printf 'API_URL="http://127.0.0.1:${port}/"\\nSERVICE_ROLE_KEY="${KEY}"\\nANON_KEY=other-anon-value-91c\\n'`;
      const reqs: AgentRequest[] = [];
      const r = await runScenario({
        script: "gate-fail-fix.json",
        onCall: (req) => void reqs.push(req),
        patch: hostDb(port, marks, envFrom),
        deps: jailed ? { sandbox: realSandbox } : {},
        steps: (steps) => steps.map((s) => (s.role === "pr_writer" ? { ...s, raw: `${s.raw} (${KEY})` } : s)),
      });
      expect(r.result.result).toBe("done");
      const gate1 = JSON.parse(r.file("gates-1.json"));
      expect(gate1.checks.find((c: { name: string }) => c.name === "syntax").output_tail).toContain("key=[redacted]");
      expect(JSON.parse(r.file("gates-2.json")).green).toBe(true);
      const fix = r.runner.calls.filter((c) => c.role === "implement")[1]!;
      expect(fix.prompt).toContain("key=[redacted]");
      for (const call of r.runner.calls) {
        expect(call.prompt).not.toContain(KEY);
        expect(call.env.DB_KEY).toBeUndefined();
        expect(call.env.DB_URL).toBeUndefined();
        expect(Object.values(call.env)).not.toContain(KEY);
      }
      // agents get no port forwards (jailed) and no env_from values
      expect(reqs.length).toBeGreaterThan(0);
      for (const req of reqs) {
        if (jailed) expect(req.jail).toBeDefined();
        expect(req.jail?.ports).toBeUndefined();
        expect(Object.values(req.env)).not.toContain(KEY);
      }
      expect(r.eventsText).not.toContain(KEY);
      expect(r.eventsText).not.toContain("other-anon-value-91c");
      for (const f of runFiles(r.runDir)) expect(readFileSync(f, "utf8"), f).not.toContain(KEY);
      const pr = r.github.prs[0]!;
      expect(pr.body + pr.title).not.toContain(KEY);
      const svc = r.events.filter((e) => e.event === "service").map((e) => e.data.action);
      expect(svc).toEqual(["service_starting", "service_env", "service_ready", "service_stopped"]);
      const env = r.events.find((e) => e.event === "service" && e.data.action === "service_env")!;
      expect(env.data.names).toEqual(["DB_URL", "DB_KEY"]);
      expect(r.events.find((e) => e.event === "service" && e.data.action === "service_starting")!.data.ports).toEqual([port]);
      expect(existsSync(join(marks, "restored"))).toBe(true);
      expect(readdirSync(join(r.factoryHome, "ports"))).toEqual([]);
    }, 120_000);
  }

  it("env_from without a mapped key ends the run needs_human (env_missing); stop still runs, the claim is released", async () => {
    const port = await freePort();
    const marks = mkdtempSync(join(tmpdir(), "hostsvc-marks-"));
    const r = await runScenario({
      script: "gate-fail-fix.json",
      patch: hostDb(port, marks, `printf 'API_URL=http://127.0.0.1:${port}/\\n'`),
    });
    expect(r.result).toMatchObject({ result: "needs_human" });
    expect(r.result.reason).toMatch(/^env_missing: service db env_from: the command printed no SERVICE_ROLE_KEY/);
    expect(existsSync(join(marks, "restored"))).toBe(true);
    expect(readdirSync(join(r.factoryHome, "ports"))).toEqual([]);
  }, 60_000);
});
