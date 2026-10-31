import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { commandsKilled, sh, tail, trackProcessGroup } from "./exec.js";
import { MIN_REDACT_LENGTH, parseDotenv } from "./secrets.js";
import { type Jail, jailedArgv } from "./sandbox/sandbox.js";
import { MAX_NAMED_PORTS, MAX_PORT_OFFSET, placeholderTexts, type RepoConfig, type Service } from "./schemas/repo.js";

/**
 * Services: one instance per run per declared service, started before the first check that
 * needs it, stopped at run end, logs in `<logDir>/<name>.log`.
 *
 * Port scheme: a run claims a slot k (1..99, the lowest free one) under `$FACTORY_HOME/ports/`:
 * - `{port_offset}` = k·100 (for tools with a port-offset flag, e.g. Supabase's default ports + offset);
 * - `{port:<number>}` = number + `{port_offset}` (a tool's default port, shifted per run);
 * - `{port:<name>}` = 20000 + `{port_offset}` + i, i = index of the name in first-use order over repo.yaml.
 * A slot is taken only when every port it yields is free on 127.0.0.1; the claim file names run and pid
 * and is reclaimed when the pid is dead. Parallel runs (other repos, `factory gates`) never share ports.
 *
 * Sandbox: a jailed service gets pasta forwards host 127.0.0.1:p → jail :p for its own ports (it must
 * listen on 0.0.0.0 inside its namespace and stay in the foreground); a jailed check reaches exactly the
 * ports of its services (jail 127.0.0.1:p → host 127.0.0.1:p). `host: true` services run unjailed.
 *
 * Fixed host ports (`host: true` + `ports`): not shifted per run, so one instance per box. The service claims
 * `ports/host-<port>.json` for each port while it runs; another process (a second run, a manual `factory
 * gates`, doctor) gets env_missing instead of sharing or restarting the stack under a running check. A
 * second Services in the same process (the evaluator's base capture) shares the running instance and
 * neither starts nor stops it. `env_from` values are resolved once per start and redacted like secrets.
 */
export const PORT_SLOTS = 99;
export const SLOT_SIZE = 100;
export const NAMED_PORT_BASE = 20000;

/** A required service could not start: the run stops with needs_human (env_missing). */
export class EnvMissing extends Error {
  constructor(message: string) {
    super(`env_missing: ${message}`);
    this.name = "EnvMissing";
  }
}

export interface PortPlan {
  slot: number;
  offset: number;
  named: Record<string, number>;
}

const PLACEHOLDER = /\{(run_id|port_offset|port:([A-Za-z0-9_-]+))\}/g;

/** Port names (in first-use order) and numeric default ports referenced in texts. */
export function portRefs(texts: string[]): { names: string[]; numbers: number[] } {
  const names: string[] = [];
  const numbers: number[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(PLACEHOLDER)) {
      const arg = m[2];
      if (arg === undefined) continue;
      if (/^\d+$/.test(arg)) {
        if (!numbers.includes(Number(arg))) numbers.push(Number(arg));
      } else if (!names.includes(arg)) names.push(arg);
    }
  }
  return { names, numbers };
}

/** The ports slot k yields for these references. */
export function slotPorts(slot: number, refs: { names: string[]; numbers: number[] }): PortPlan & { all: number[] } {
  const offset = slot * SLOT_SIZE;
  const named = Object.fromEntries(refs.names.map((n, i) => [n, NAMED_PORT_BASE + offset + i]));
  return { slot, offset, named, all: [...Object.values(named), ...refs.numbers.map((n) => n + offset)] };
}

/** Replaces `{run_id}`, `{port_offset}`, `{port:x}`; other braces (e.g. `{files}`) stay. */
export function expandPlaceholders(text: string, runId: string, plan: PortPlan | undefined): string {
  return text.replace(PLACEHOLDER, (whole, ref: string, arg: string | undefined) => {
    if (ref === "run_id") return runId;
    if (!plan) throw new Error(`no ports allocated for ${whole}`);
    if (ref === "port_offset") return String(plan.offset);
    if (/^\d+$/.test(arg!)) return String(Number(arg) + plan.offset);
    const p = plan.named[arg!];
    if (p === undefined) throw new Error(`unknown port ${whole}`);
    return String(p);
  });
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Claims the lowest free port slot; returns the plan and its release function. */
export async function allocatePorts(
  factoryHome: string,
  runId: string,
  refs: { names: string[]; numbers: number[] },
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<{ plan: PortPlan; release: () => void }> {
  if (refs.names.length > MAX_NAMED_PORTS) throw new Error(`more than ${MAX_NAMED_PORTS} named ports`);
  const dir = join(factoryHome, "ports");
  mkdirSync(dir, { recursive: true });
  for (let slot = 1; slot <= PORT_SLOTS; slot++) {
    const file = join(dir, `slot-${slot}.json`);
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch {
      try {
        const holder = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
        if (typeof holder.pid === "number" && pidAlive(holder.pid)) continue;
        unlinkSync(file); // stale claim of a dead process
        fd = openSync(file, "wx");
      } catch {
        continue;
      }
    }
    writeSync(fd, JSON.stringify({ run_id: runId, pid: process.pid }) + "\n");
    closeSync(fd);
    const plan = slotPorts(slot, refs);
    const free = await Promise.all(plan.all.map((p) => (p > 65535 ? Promise.resolve(false) : probe(p))));
    if (free.every(Boolean)) {
      return {
        plan: { slot: plan.slot, offset: plan.offset, named: plan.named },
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    }
    unlinkSync(file);
  }
  throw new EnvMissing(`no free port slot (1..${PORT_SLOTS}, offset ≤ ${MAX_PORT_OFFSET}) under ${dir}`);
}

function claimFile(dir: string, file: string, runId: string): "taken" | { run_id?: string; pid: number } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ run_id: runId, pid: process.pid }) + "\n");
      closeSync(fd);
      return "taken";
    } catch {
      let holder: { run_id?: string; pid?: number } = {};
      try {
        holder = JSON.parse(readFileSync(file, "utf8")) as typeof holder;
      } catch {
        // half-written or gone: retry
      }
      // A live other process holds it; our own pid means a stale claim of an earlier instance in this process.
      if (typeof holder.pid === "number" && holder.pid !== process.pid && pidAlive(holder.pid)) return { run_id: holder.run_id, pid: holder.pid };
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
  throw new EnvMissing(`could not claim ${file} under ${dir}`);
}

/**
 * Claims fixed host ports for one service instance; throws EnvMissing naming the holder when another live
 * process has one. Returns the release function.
 */
export function claimHostPorts(factoryHome: string, runId: string, service: string, ports: number[]): () => void {
  const dir = join(factoryHome, "ports");
  mkdirSync(dir, { recursive: true });
  const taken: string[] = [];
  const release = () => {
    for (const f of taken.splice(0)) {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    }
  };
  for (const port of [...new Set(ports)].sort((a, b) => a - b)) {
    const file = join(dir, `host-${port}.json`);
    const r = claimFile(dir, file, runId);
    if (r !== "taken") {
      release();
      throw new EnvMissing(
        `service ${service}: host port ${port} is held by ${r.run_id ?? "another factory process"} (pid ${r.pid}); fixed-port host services run one instance per box, retry when it has finished`,
      );
    }
    taken.push(file);
  }
  return release;
}

/** Target env → value from a `KEY=VALUE` (dotenv) output; names of mapped keys that are missing. */
export function mapEnvFrom(output: string, map: Record<string, string>): { env: Record<string, string>; missing: string[]; values: string[] } {
  const parsed = parseDotenv(output);
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const [target, key] of Object.entries(map)) {
    if (parsed[key] === undefined) missing.push(key);
    else env[target] = parsed[key];
  }
  return { env, missing, values: Object.values(parsed) };
}

/** Readiness probe: the port accepts a connection and holds it (pasta closes forwards to nobody at once). */
export function portHolds(port: number, holdMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => end(false), 3000);
    s.once("connect", () => {
      clearTimeout(timer);
      setTimeout(() => end(true), holdMs);
    });
    s.once("error", () => end(false));
    s.once("end", () => end(false));
    s.once("close", () => end(false));
  });
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

interface Def extends Service {
  /** ui only: ready when GET url answers below 500. */
  url?: string;
}

interface Started {
  def: Def;
  child: ChildProcess;
  exited: { code: number | null } | undefined;
  untrack: () => void;
  ports: number[];
  /** `env_from` values (checks of this service only). */
  fromEnv: Record<string, string>;
  /** Fixed host port claim. */
  releaseClaim?: () => void;
  /** Shared instance of another Services in this process: never started or stopped here. */
  borrowed?: boolean;
}

/** Running fixed-port host services of this process, by service name and ports. */
const hostInstances = new Map<string, Started>();
const hostKey = (def: Def) => `${def.name}:${[...new Set(def.ports)].sort((a, b) => a - b).join(",")}`;

export interface ServicesOptions {
  runId: string;
  /** `runs/<id>/services/`. */
  logDir: string;
  /** Working dir of services and checks (the run worktree). */
  cwd: string;
  /** Base env (agent allowlist in a run, the caller's env for `factory gates`). */
  env: Record<string, string>;
  factoryHome: string;
  /** Sandbox for the run worktree; undefined = unjailed. Ports are added per command. */
  jail?: Jail;
  /** Poll interval of readiness checks. */
  pollMs?: number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  probe?: (port: number) => Promise<boolean>;
  /** Values to redact from now on (`env_from` output), called before any check gets them. */
  onSecrets?: (values: string[]) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Services of one run (or one `factory gates` call). */
export class Services {
  private plan?: PortPlan;
  private release?: () => void;
  private allocating?: Promise<PortPlan>;
  private readonly started = new Map<string, Started>();
  private readonly defs: Map<string, Def>;
  private readonly refs: { names: string[]; numbers: number[] };
  private readonly secrets: string[] = [];

  constructor(
    readonly repo: Pick<RepoConfig, "services" | "checks" | "ui"> & { verify?: { run?: string } },
    private readonly opts: ServicesOptions,
  ) {
    this.defs = new Map(repo.services.map((s) => [s.name, s]));
    if (repo.ui) {
      const ui = repo.ui;
      this.defs.set("ui", { name: "ui", start: ui.start, env: {}, ready_timeout_s: ui.ready_timeout_s, host: false, url: ui.url });
    }
    this.refs = portRefs(placeholderTexts(repo).map((t) => t.text));
  }

  get names(): string[] {
    return [...this.defs.keys()];
  }

  /** `env_from` values resolved so far (for redaction by callers without an event log), longest first. */
  get redactValues(): string[] {
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  private needsPorts(text: string): boolean {
    return [...text.matchAll(PLACEHOLDER)].some((m) => m[1] !== "run_id");
  }

  private async ports(): Promise<PortPlan> {
    if (this.plan) return this.plan;
    this.allocating ??= allocatePorts(this.opts.factoryHome, this.opts.runId, this.refs, this.opts.probe).then(({ plan, release }) => {
      this.plan = plan;
      this.release = release;
      this.opts.onEvent?.("ports", { slot: plan.slot, port_offset: plan.offset, ports: plan.named });
      return plan;
    });
    return this.allocating;
  }

  /** Expands placeholders (allocating the run's port slot on first need). */
  async expand(text: string): Promise<string> {
    const plan = this.needsPorts(text) ? await this.ports() : this.plan;
    return expandPlaceholders(text, this.opts.runId, plan);
  }

  /** Ports a service names in its commands, env and (ui) url. */
  private async portsOf(def: Def): Promise<number[]> {
    const texts = [def.start, def.stop ?? "", def.ready ?? "", ...Object.values(def.env), def.url ?? ""];
    const out = new Set<number>();
    const plan = texts.some((t) => this.needsPorts(t)) ? await this.ports() : undefined;
    const refs = portRefs(texts);
    for (const n of refs.names) out.add(plan!.named[n]!);
    for (const n of refs.numbers) out.add(n + plan!.offset);
    if (def.url) {
      const u = new URL(await this.expand(def.url));
      if (u.port) out.add(Number(u.port));
    }
    if (def.host) for (const p of def.ports ?? []) out.add(p);
    return [...out];
  }

  /** Expanded env of these services plus their `env_from` values once started (for their checks). */
  async envOf(names: string[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const n of names) {
      for (const [k, v] of Object.entries(this.defs.get(n)?.env ?? {})) env[k] = await this.expand(v);
      Object.assign(env, this.started.get(n)?.fromEnv ?? {});
    }
    return env;
  }

  /** Ports a check needing these services may reach. */
  reachOf(names: string[]): number[] {
    return [...new Set(names.flatMap((n) => this.started.get(n)?.ports ?? []))];
  }

  /** Jail for a command with these forwards; undefined when unjailed. */
  jailWith(ports: Jail["ports"]): Jail | undefined {
    return this.opts.jail ? { ...this.opts.jail, ports } : undefined;
  }

  /** Starts the services not running yet, in order; throws EnvMissing when one does not come up. */
  async ensure(names: string[]): Promise<void> {
    for (const name of names) {
      if (this.started.has(name)) continue;
      const def = this.defs.get(name);
      if (!def) throw new EnvMissing(`unknown service ${name}`);
      await this.start(def);
    }
  }

  private async start(def: Def): Promise<void> {
    const killed = commandsKilled();
    if (killed) throw new EnvMissing(`service ${def.name} not started: ${killed}`);
    mkdirSync(this.opts.logDir, { recursive: true });
    const logFile = join(this.opts.logDir, `${def.name}.log`);
    const key = def.host && def.ports?.length ? hostKey(def) : undefined;
    const shared = key ? hostInstances.get(key) : undefined;
    if (shared) {
      this.started.set(def.name, { ...shared, borrowed: true, untrack: () => {} });
      this.opts.onEvent?.("service_shared", { service: def.name, ports: shared.ports });
      return;
    }
    const ports = await this.portsOf(def);
    const others = [...this.started.values()].flatMap((s) => s.ports);
    const cmd = await this.expand(def.start);
    const env = { ...this.opts.env, ...(await this.envOf([def.name])) };
    const jail = def.host ? undefined : this.jailWith({ expose: ports, reach: others });
    const [file, ...args] = jailedArgv(jail, "sh", cmd, this.opts.cwd, env);
    const releaseClaim = key ? claimHostPorts(this.opts.factoryHome, this.opts.runId, def.name, def.ports!) : undefined;
    const log = openSync(logFile, "a");
    writeSync(log, `[factory] start ${def.name}${jail ? " (sandboxed)" : def.host ? " (host)" : ""}: ${cmd}\n`);
    const child = spawn(file!, args, { cwd: this.opts.cwd, env, stdio: ["ignore", log, log], detached: true });
    closeSync(log);
    const st: Started = { def, child, exited: undefined, untrack: child.pid ? trackProcessGroup(child.pid) : () => {}, ports, fromEnv: {}, releaseClaim };
    child.on("exit", (code) => (st.exited = { code }));
    child.on("error", () => (st.exited = { code: 127 }));
    this.started.set(def.name, st);
    this.opts.onEvent?.("service_starting", { service: def.name, ports, sandboxed: !!jail });

    const t0 = Date.now();
    const deadline = t0 + def.ready_timeout_s * 1000;
    const jailed = !!jail && jail.sandbox.fs !== "none";
    const fail = async (why: string): Promise<never> => {
      await this.stopOne(st);
      this.started.delete(def.name);
      let logTail = "";
      try {
        logTail = tail(readFileSync(logFile, "utf8"), 20);
      } catch {
        // no log
      }
      this.opts.onEvent?.("service_failed", { service: def.name, reason: why });
      throw new EnvMissing(`service ${def.name} ${why} (log ${logFile})\n${logTail}`);
    };
    for (;;) {
      if (st.exited) {
        if (st.exited.code !== 0) return fail(`exited with code ${st.exited.code} before it was ready`);
        if (jailed) return fail("left the foreground; in the sandbox a service must keep running (or set host: true)");
      }
      if (await this.ready(def, ports, st, Date.now() - t0)) break;
      if (Date.now() > deadline) return fail(`not ready after ${def.ready_timeout_s}s`);
      await sleep(this.opts.pollMs ?? 250);
    }
    if (def.env_from) {
      const why = await this.resolveEnvFrom(def, st, logFile);
      if (why) return fail(why);
    }
    if (key) hostInstances.set(key, st);
    this.opts.onEvent?.("service_ready", { service: def.name, ms: Date.now() - t0 });
  }

  /** Runs `env_from.command` on the host; the values never reach the log. Returns why it failed, if it did. */
  private async resolveEnvFrom(def: Def, st: Started, logFile: string): Promise<string | undefined> {
    const from = def.env_from!;
    const cmd = await this.expand(from.command);
    const r = await sh(cmd, { cwd: this.opts.cwd, env: { ...this.opts.env, ...(await this.envOf([def.name])) }, timeoutMs: 60_000 });
    const { env, missing, values } = mapEnvFrom(r.output, from.map);
    // Every printed value is redacted (not only the mapped ones): the output is a status dump of the stack.
    const secret = [...new Set([...values, ...Object.values(env)].filter((v) => v.length >= MIN_REDACT_LENGTH))];
    for (const v of secret) if (!this.secrets.includes(v)) this.secrets.push(v);
    if (secret.length) this.opts.onSecrets?.(secret);
    const scrub = (t: string) => this.redactValues.reduce((acc, v) => acc.split(v).join("[redacted]"), t);
    try {
      writeFileSync(logFile, `[factory] env_from ${def.name}: exit ${r.code}, ${Object.keys(env).length}/${Object.keys(from.map).length} mapped (values not shown)\n${r.code === 0 ? "" : scrub(tail(r.output, 10))}`, { flag: "a" });
    } catch {
      // log dir gone
    }
    if (r.code !== 0) return `env_from command exited with code ${r.code}`;
    if (missing.length) return `env_from: the command printed no ${missing.join(", ")}`;
    st.fromEnv = env;
    this.opts.onEvent?.("service_env", { service: def.name, names: Object.keys(env) });
    return undefined;
  }

  private async ready(def: Def, ports: number[], st: Started, elapsed: number): Promise<boolean> {
    if (def.ready) {
      const cmd = await this.expand(def.ready);
      const jail = def.host ? undefined : this.jailWith({ reach: ports });
      const r = await sh(cmd, { cwd: this.opts.cwd, env: { ...this.opts.env, ...(await this.envOf([def.name])) }, jail, timeoutMs: 30_000 });
      return r.code === 0;
    }
    if (def.url) return httpReady(await this.expand(def.url));
    if (ports.length) return (await Promise.all(ports.map((p) => portHolds(p)))).every(Boolean);
    // Nothing to probe: running for a second (or a host command that finished) counts as ready.
    return st.exited?.code === 0 || elapsed >= 1000;
  }

  private async stopOne(st: Started): Promise<void> {
    if (st.borrowed) return;
    try {
      await this.stopProcess(st);
    } finally {
      for (const [k, v] of hostInstances) if (v === st) hostInstances.delete(k);
      st.releaseClaim?.();
    }
  }

  private async stopProcess(st: Started): Promise<void> {
    const { def } = st;
    const logFile = join(this.opts.logDir, `${def.name}.log`);
    if (def.stop) {
      const cmd = await this.expand(def.stop);
      const jail = def.host ? undefined : this.jailWith({ reach: st.ports });
      const r = await sh(cmd, { cwd: this.opts.cwd, env: { ...this.opts.env, ...(await this.envOf([def.name])) }, jail, timeoutMs: 120_000 });
      try {
        writeFileSync(logFile, `[factory] stop ${def.name}: exit ${r.code}\n${r.output}`, { flag: "a" });
      } catch {
        // log dir gone
      }
    }
    const pid = st.child.pid;
    if (pid !== undefined && !st.exited) {
      const kill = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          // gone
        }
      };
      kill("SIGTERM");
      for (let i = 0; i < 50 && !st.exited; i++) await sleep(100);
      if (!st.exited) kill("SIGKILL");
    }
    st.untrack();
  }

  /** Stops every started service (reverse order) and releases the port slot. Never throws. */
  async stopAll(): Promise<void> {
    for (const st of [...this.started.values()].reverse()) {
      try {
        await this.stopOne(st);
        this.opts.onEvent?.("service_stopped", { service: st.def.name });
      } catch (e) {
        this.opts.onEvent?.("service_failed", { service: st.def.name, reason: `stop: ${(e as Error).message}` });
      }
    }
    this.started.clear();
    if (this.allocating) await this.allocating.catch(() => undefined);
    this.release?.();
    this.release = undefined;
    this.plan = undefined;
    this.allocating = undefined;
  }
}
