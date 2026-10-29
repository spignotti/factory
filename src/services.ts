import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { commandsKilled, sh, tail, trackProcessGroup } from "./exec.js";
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
}

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
    return [...out];
  }

  /** Expanded env of these services (for their checks). */
  async envOf(names: string[]): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const n of names) for (const [k, v] of Object.entries(this.defs.get(n)?.env ?? {})) env[k] = await this.expand(v);
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
    const ports = await this.portsOf(def);
    const others = [...this.started.values()].flatMap((s) => s.ports);
    const cmd = await this.expand(def.start);
    const env = { ...this.opts.env, ...(await this.envOf([def.name])) };
    const jail = def.host ? undefined : this.jailWith({ expose: ports, reach: others });
    const [file, ...args] = jailedArgv(jail, "sh", cmd, this.opts.cwd, env);
    const log = openSync(logFile, "a");
    writeSync(log, `[factory] start ${def.name}${jail ? " (sandboxed)" : def.host ? " (host)" : ""}: ${cmd}\n`);
    const child = spawn(file!, args, { cwd: this.opts.cwd, env, stdio: ["ignore", log, log], detached: true });
    closeSync(log);
    const st: Started = { def, child, exited: undefined, untrack: child.pid ? trackProcessGroup(child.pid) : () => {}, ports };
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
    this.opts.onEvent?.("service_ready", { service: def.name, ms: Date.now() - t0 });
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
