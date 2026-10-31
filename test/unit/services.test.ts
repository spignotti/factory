import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createSandbox, hostProbe, type Jail } from "../../src/sandbox/sandbox.js";
import { parseRepoConfig, type RepoConfig } from "../../src/schemas/repo.js";
import { spawn } from "node:child_process";
import { serviceConfigChecks } from "../../src/commands/doctor.js";
import { createServer } from "node:net";
import { allocatePorts, claimHostPorts, EnvMissing, expandPlaceholders, isPortFree, mapEnvFrom, portRefs, Services, slotPorts } from "../../src/services.js";
import { runChecks } from "../../src/steps/gates.js";

const home = () => mkdtempSync(join(tmpdir(), "factory-ports-"));
const SERVE = `node -e "require('http').createServer((q,r)=>r.end(process.env.GREETING||'ok')).listen(Number(process.argv[1]),'0.0.0.0')"`;
const FETCH = `node -e "fetch(process.env.WEB_URL).then(r=>r.text()).then(t=>{console.log(t);process.exit(t==='hello'?0:1)},e=>{console.log(String(e));process.exit(2)})"`;

function repoWith(yaml: string): RepoConfig {
  return parseRepoConfig(yaml);
}

describe("service placeholders and port scheme", () => {
  it("collects named and numeric port references in first-use order", () => {
    expect(portRefs(["a {port:db} {port:54322} {port:web}", "{port:db} {run_id} {port_offset}"])).toEqual({ names: ["db", "web"], numbers: [54322] });
  });

  it("slot k: offset k·100, named ports from 20000+offset, numeric ports shifted by the offset", () => {
    const p = slotPorts(3, { names: ["db", "web"], numbers: [54322] });
    expect(p).toEqual({ slot: 3, offset: 300, named: { db: 20300, web: 20301 }, all: [20300, 20301, 54622] });
    expect(expandPlaceholders("x {run_id} {port_offset} {port:web} {port:54322} {files}", "r1", p)).toBe("x r1 300 20301 54622 {files}");
    expect(() => expandPlaceholders("{port:nope}", "r1", p)).toThrow(/unknown port/);
  });

  it("parallel runs get different slots; busy ports skip a slot; release frees it; dead holders are reclaimed", async () => {
    const fh = home();
    const refs = { names: ["db"], numbers: [] };
    const a = await allocatePorts(fh, "a", refs, async () => true);
    const b = await allocatePorts(fh, "b", refs, async () => true);
    expect([a.plan.slot, b.plan.slot]).toEqual([1, 2]);
    // slot 3's port is busy → slot 4
    const c = await allocatePorts(fh, "c", refs, async (port) => port !== slotPorts(3, refs).all[0]);
    expect(c.plan.slot).toBe(4);
    expect(existsSync(join(fh, "ports", "slot-3.json"))).toBe(false);
    a.release();
    expect((await allocatePorts(fh, "d", refs, async () => true)).plan.slot).toBe(1);
    // a claim of a process that is gone
    const dead = spawnSync("true").pid!;
    writeFileSync(join(fh, "ports", "slot-3.json"), JSON.stringify({ run_id: "old", pid: dead }));
    expect((await allocatePorts(fh, "e", refs, async () => true)).plan.slot).toBe(3);
    await expect(allocatePorts(fh, "f", refs, async () => false)).rejects.toThrow(EnvMissing);
  });

  it("repo.yaml validation: unknown service in a check, reserved name ui, bad placeholders", () => {
    expect(() => repoWith(`checks: [{name: a, run: x, tier: fast, services: [db]}]`)).toThrow(/check a: unknown service db/);
    expect(() => repoWith(`services: [{name: ui, start: x}]`)).toThrow(/reserved/);
    // only exact `{port:<name|number>}` forms are placeholders; other braces stay as they are
    expect(expandPlaceholders("{port:a.b} {port: 1}", "r", undefined)).toBe("{port:a.b} {port: 1}");
    expect(() => repoWith(`services: [{name: db, start: "x {port:65000}"}]`)).toThrow(/must be 1\.\.55635/);
    expect(() => repoWith(`services: [{name: db, start: x}, {name: db, start: y}]`)).toThrow(/duplicate service/);
    expect(repoWith(`services: [{name: db, start: x}]`).services[0]).toMatchObject({ env: {}, ready_timeout_s: 120, host: false });
  });
});

describe("host services: fixed ports, env_from, local_only (config)", () => {
  it("ports and env_from need host: true; env_from may not set reserved or agent_env names", () => {
    expect(() => repoWith(`services: [{name: db, start: x, ports: [54322]}]`)).toThrow(/ports needs host: true/);
    expect(() => repoWith(`services: [{name: db, start: x, env_from: {command: s, map: {A: B}}}]`)).toThrow(/env_from needs host: true/);
    expect(() => repoWith(`services: [{name: db, host: true, start: x, env_from: {command: s, map: {PATH: B}}}]`)).toThrow(/may not set PATH/);
    expect(() => repoWith(`agent_env: [DB_URL]\nservices: [{name: db, host: true, start: x, env_from: {command: s, map: {DB_URL: B}}}]`)).toThrow(/agent_env passes to agents/);
    expect(() => repoWith(`services: [{name: db, host: true, start: x, env_from: {command: s, map: {}}}]`)).toThrow(/at least one entry/);
    expect(() => repoWith(`services: [{name: db, host: true, start: x, ports: [70000]}]`)).toThrow();
    const ok = repoWith(`services: [{name: db, host: true, start: x, ports: [54321, 54322], env_from: {command: s, map: {DB_URL: DB_URL}}}]\nchecks: [{name: t, run: x, tier: full, services: [db], local_only: true}]`);
    expect(ok.services[0]).toMatchObject({ ports: [54321, 54322], env_from: { command: "s", map: { DB_URL: "DB_URL" } } });
    expect(ok.checks[0]!.local_only).toBe(true);
  });

  it("env_from output: dotenv lines, quotes, noise ignored; target ← key; missing keys named", () => {
    const out = 'Stopped services: [x]\nAPI_URL="http://127.0.0.1:54321"\nexport ANON_KEY=\'abc.def\'\nnot a line\n';
    expect(mapEnvFrom(out, { URL: "API_URL", ANON: "ANON_KEY", ROLE: "SERVICE_ROLE_KEY" })).toEqual({
      env: { URL: "http://127.0.0.1:54321", ANON: "abc.def" },
      missing: ["SERVICE_ROLE_KEY"],
      values: ["http://127.0.0.1:54321", "abc.def"],
    });
  });

  it("fixed host ports: one claim per box; a live other process blocks, dead or own stale claims are taken over", async () => {
    const fh = home();
    const release = claimHostPorts(fh, "r1", "db", [54322, 54321]);
    expect(readdirSync(join(fh, "ports")).sort()).toEqual(["host-54321.json", "host-54322.json"]);
    release();
    expect(readdirSync(join(fh, "ports"))).toEqual([]);
    const other = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(fh, "ports", "host-54322.json"), JSON.stringify({ run_id: "other-run", pid: other.pid }));
      expect(() => claimHostPorts(fh, "r2", "db", [54321, 54322])).toThrow(/host port 54322 is held by other-run \(pid \d+\)/);
      // nothing of the failed claim stays behind
      expect(readdirSync(join(fh, "ports"))).toEqual(["host-54322.json"]);
    } finally {
      other.kill();
    }
    const dead = spawnSync("true").pid!;
    writeFileSync(join(fh, "ports", "host-54322.json"), JSON.stringify({ run_id: "old", pid: dead }));
    claimHostPorts(fh, "r3", "db", [54322])();
    writeFileSync(join(fh, "ports", "host-54322.json"), JSON.stringify({ run_id: "mine", pid: process.pid }));
    claimHostPorts(fh, "r4", "db", [54322])();
  });
});

describe("doctor: host service and local_only config", () => {
  it("names fixed ports, env_from targets (no values), local_only checks, and warns about a CI check that needs a fixed-port stack", () => {
    const repo = repoWith(`
services: [{name: db, host: true, start: x, ports: [54321, 54322], env_from: {command: s, map: {DB_URL: DB_URL, DB_KEY: K}}}]
checks:
  - {name: local, run: x, tier: full, services: [db], local_only: true}
  - {name: ci, run: x, tier: full, services: [db]}
`);
    const details = serviceConfigChecks(repo).map((c) => `${c.status} ${c.name}: ${c.detail}`);
    expect(details).toEqual([
      expect.stringMatching(/^warn service db: host: true/),
      "info service db: fixed host ports 54321, 54322: forwarded only to the checks that need it, one instance per box",
      "info service db: env_from sets DB_URL, DB_KEY for its checks (values redacted, never agents)",
      "info check local: local_only: runs in factory runs and local factory gates, never in CI",
      "warn check ci: needs db (fixed host ports) but is not local_only: CI must provide that stack itself",
    ]);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const hostStack = (port: number, extra = "") =>
  repoWith(stringify({
    services: [{
      name: "db",
      host: true,
      start: `node -e "require('http').createServer((q,r)=>r.end('hello')).listen(${port},'127.0.0.1')"`,
      stop: "echo restored >> restores.log",
      ports: [port],
      env_from: { command: `printf 'API_URL=http://127.0.0.1:${port}/\\nKEY=host-key-value-123${extra}\\n'`, map: { WEB_URL: "API_URL", DB_KEY: "KEY" } },
      ready_timeout_s: 20,
    }],
    checks: [{ name: "db-test", run: `test "$DB_KEY" = host-key-value-123${extra} && ${FETCH}`, tier: "full", services: ["db"], local_only: true }],
  }));

function services(repo: RepoConfig, cwd: string, jail?: Jail, onSecrets?: (values: string[]) => void) {
  const events: { action: string; data: Record<string, unknown> }[] = [];
  const logDir = join(mkdtempSync(join(tmpdir(), "svc-logs-")), "services");
  const svc = new Services(repo, {
    runId: "r-test",
    logDir,
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    factoryHome: home(),
    jail,
    pollMs: 100,
    onEvent: (action, data) => void events.push({ action, data }),
    onSecrets,
  });
  return { svc, events, logDir };
}

const WEB = stringify({
  services: [
    { name: "web", start: `${SERVE} {port:web}`, env: { WEB_URL: "http://127.0.0.1:{port:web}/", GREETING: "hello" }, ready_timeout_s: 20 },
  ],
  checks: [
    { name: "web-test", run: FETCH, tier: "fast", services: ["web"] },
    { name: "plain", run: "echo run {run_id}", tier: "fast" },
  ],
});

describe("Services on the host (no sandbox)", () => {
  it("starts a service before its check, passes its env, logs, stops it and frees the slot", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "svc-wt-"));
    const repo = repoWith(WEB);
    const { svc, events, logDir } = services(repo, cwd);
    const results = await runChecks(repo.checks, { cwd, env: { PATH: process.env.PATH! }, envCommand: "", services: svc });
    expect(results.map((r) => [r.name, r.status])).toEqual([["web-test", "pass"], ["plain", "pass"]]);
    const port = Number((events.find((e) => e.action === "ports")!.data.ports as Record<string, number>).web);
    expect(port).toBeGreaterThanOrEqual(20100);
    expect(events.map((e) => e.action)).toEqual(["ports", "service_starting", "service_ready"]);
    await svc.stopAll();
    expect(events.at(-1)!.action).toBe("service_stopped");
    expect(await isPortFree(port)).toBe(true);
    expect(readFileSync(join(logDir, "web.log"), "utf8")).toContain("[factory] start web");
  }, 30_000);

  it("a service that dies is env_missing with its log tail; stop commands run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "svc-wt-"));
    const repo = repoWith(`
services:
  - { name: bad, start: "echo boom-detail; exit 3" }
  - { name: daemon, start: "true", stop: "touch stopped-{run_id}" }
checks:
  - { name: a, run: "true", tier: fast, services: [daemon] }
  - { name: b, run: "true", tier: fast, services: [bad] }
`);
    const { svc } = services(repo, cwd);
    const err = await runChecks(repo.checks, { cwd, env: { PATH: process.env.PATH! }, envCommand: "", services: svc }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(EnvMissing);
    expect((err as Error).message).toMatch(/env_missing: service bad exited with code 3[\s\S]*boom-detail/);
    await svc.stopAll();
    expect(existsSync(join(cwd, "stopped-r-test"))).toBe(true);
  }, 30_000);

  it("a fixed-port host service: probe on its ports, env_from for its checks, redaction values, one start per process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "svc-wt-"));
    const port = await freePort();
    const repo = hostStack(port);
    const secrets: string[] = [];
    const { svc, events } = services(repo, cwd, undefined, (v) => void secrets.push(...v));
    const svc2 = new Services(repo, { runId: "r-base", logDir: join(cwd, "logs2"), cwd, env: { PATH: process.env.PATH! }, factoryHome: home(), pollMs: 100 });
    try {
      const results = await runChecks(repo.checks, { cwd, env: { PATH: process.env.PATH! }, envCommand: "", services: svc });
      expect(results[0]).toMatchObject({ name: "db-test", status: "pass" });
      expect(events.map((e) => e.action)).toEqual(["service_starting", "service_env", "service_ready"]);
      expect(events[0]!.data.ports).toEqual([port]);
      expect(svc.reachOf(["db"])).toEqual([port]);
      expect(secrets).toContain("host-key-value-123");
      expect(svc.redactValues).toContain("host-key-value-123");
      // a second Services in this process (the base capture) shares the instance: no second start, no stop
      await svc2.ensure(["db"]);
      expect((await svc2.envOf(["db"])).DB_KEY).toBe("host-key-value-123");
      await svc2.stopAll();
      expect(existsSync(join(cwd, "restores.log"))).toBe(false);
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await svc.stopAll();
    }
    expect(readFileSync(join(cwd, "restores.log"), "utf8")).toBe("restored\n");
  }, 30_000);

  it("a check needing services without a service manager is env_missing", async () => {
    const repo = repoWith(WEB);
    await expect(runChecks(repo.checks, { cwd: tmpdir(), env: {}, envCommand: "" })).rejects.toThrow(/needs services web/);
  });
});

let real: ReturnType<typeof createSandbox> | undefined;
try {
  real = process.platform === "linux" ? createSandbox("required", hostProbe) : undefined;
} catch {
  real = undefined;
}

describe.skipIf(!real)("Services in the sandbox (bwrap + pasta)", () => {
  it("a jailed service is reached by a jailed check through pasta forwards only", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "svc-jail-")));
    const repo = repoWith(WEB);
    const jail: Jail = { sandbox: real!, rw: [cwd], ro: [] };
    const { svc, events } = services(repo, cwd, jail);
    try {
      const results = await runChecks(repo.checks.slice(0, 1), { cwd, env: { PATH: process.env.PATH! }, envCommand: "", services: svc, jail });
      expect(results[0]).toMatchObject({ name: "web-test", status: "pass" });
      expect(events.find((e) => e.action === "service_starting")!.data.sandboxed).toBe(true);
      // without the forward, a jailed check cannot reach it
      const blind = await runChecks([{ ...repo.checks[0]!, services: undefined }], {
        cwd, env: { PATH: process.env.PATH!, WEB_URL: (await svc.envOf(["web"])).WEB_URL! }, envCommand: "", jail,
      });
      expect(blind[0]!.status).toBe("fail");
    } finally {
      await svc.stopAll();
    }
  }, 60_000);

  it("a jailed check reaches a fixed-port host service and its env_from values; a jailed command without the service reaches neither", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "svc-jail-")));
    const port = await freePort();
    const repo = hostStack(port);
    const jail: Jail = { sandbox: real!, rw: [cwd], ro: [] };
    const { svc, events, logDir } = services(repo, cwd, jail);
    try {
      const results = await runChecks(repo.checks, { cwd, env: { PATH: process.env.PATH! }, envCommand: "", services: svc, jail });
      expect(results[0]).toMatchObject({ name: "db-test", status: "pass" });
      expect(events.find((e) => e.action === "service_starting")!.data.sandboxed).toBe(false);
      // like an agent: same jail, no forwards, the URL known but not the key
      const blind = await runChecks([{ ...repo.checks[0]!, run: FETCH, services: undefined }], {
        cwd, env: { PATH: process.env.PATH!, WEB_URL: `http://127.0.0.1:${port}/` }, envCommand: "", jail,
      });
      expect(blind[0]!.status).toBe("fail");
      expect(readFileSync(join(logDir, "db.log"), "utf8")).not.toContain("host-key-value-123");
    } finally {
      await svc.stopAll();
    }
  }, 60_000);

  it("a jailed service that daemonizes (leaves the foreground) is env_missing", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "svc-jail-")));
    const repo = repoWith(`services: [{ name: d, start: "true" }]`);
    const { svc } = services(repo, cwd, { sandbox: real!, rw: [cwd], ro: [] });
    // "true" exits 0 at once; with no ports the 1 s grace may not pass first
    await expect(svc.ensure(["d"])).rejects.toThrow(/left the foreground/);
    await svc.stopAll();
  }, 30_000);
});
