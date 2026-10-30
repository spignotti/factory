import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * Process sandbox for agent bash and repo commands (setup, checks, tests): bubblewrap for the
 * filesystem, pasta for the network. Linux only.
 *
 * - Filesystem: system dirs and PATH toolchain prefixes read-only (never a home dir or `/opt` whole); read-write only the run's worktree and agent HOME (bound at the
 *   same paths, so in-process tools and bash agree on paths); the worktree's `.git` file and the main
 *   repo's git dir read-only (git is read-only for agents; a writable gitdir could set hooks or
 *   `core.fsmonitor` that would run on the host); a private /tmp. Never bound: /run (docker socket),
 *   other homes, `$FACTORY_HOME` (auth.json) except the run's own dirs.
 * - Network: own namespace through pasta without host loopback (`--no-map-gw`, no port forwards in
 *   either direction except a service's explicit ports) and
 *   with blackhole routes for private, link-local and CGNAT ranges, no on-link subnet and IPv6 off, so
 *   internet works (package installs) but host services, the Docker bridge, cloud metadata and the LAN
 *   do not. The DNS servers from
 *   /etc/resolv.conf stay reachable (residual risk, documented).
 */
export type SandboxMode = "required" | "preferred" | "off";

export interface Sandbox {
  mode: SandboxMode;
  /** `bwrap`: commands run jailed; `none`: on the host (mode off, or preferred without bwrap). */
  fs: "bwrap" | "none";
  /** `isolated`: pasta + blackhole routes; `shared`: the host network. */
  net: "isolated" | "shared";
  warnings: string[];
}

export class SandboxUnavailable extends Error {
  constructor(reasons: string[]) {
    super(`sandbox: required but unavailable: ${reasons.join("; ")}`);
    this.name = "SandboxUnavailable";
  }
}

/** Binds of one jailed command. Paths are absolute. */
export interface Jail {
  sandbox: Sandbox;
  /** Read-write at the same path (worktree, agent HOME). */
  rw: string[];
  /** Read-only at the same path (main repo git dir). */
  ro: string[];
  /** Never bound, not even as part of a PATH prefix (`$FACTORY_HOME`). */
  hide?: string[];
  /**
   * Explicit TCP forwards through pasta (services); nothing else crosses the namespace.
   * `expose`: host 127.0.0.1:p → jail :p (a service listening in this jail).
   * `reach`: jail 127.0.0.1:p → host 127.0.0.1:p (a check talking to a service).
   */
  ports?: { expose?: number[]; reach?: number[] };
}

export const NO_SANDBOX: Sandbox = { mode: "off", fs: "none", net: "shared", warnings: [] };

/** Runs inside pasta's namespace (root there, needed for `ip route`), before bwrap: routes, then exec bwrap (which drops to the host uid). */
export const NET_SETUP = [
  "set -e",
  `gw=$(ip -4 route | awk '/^default/{print $3; exit}')`,
  `dev=$(ip -4 route | awk '/^default/{print $5; exit}')`,
  `[ -n "$gw" ] && [ -n "$dev" ]`,
  // No on-link subnet: hosts next to this machine (and the gateway itself) are not reachable either.
  `for r in $(ip -4 route show scope link | awk '{print $1}'); do ip route del "$r" dev "$dev" 2>/dev/null || true; done`,
  `ip route replace default via "$gw" dev "$dev" onlink`,
  `for ns in $(awk '/^nameserver/{print $2}' /etc/resolv.conf | grep -v :); do ip route replace "$ns/32" via "$gw" dev "$dev" onlink; done`,
  `for n in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8; do ip route add blackhole "$n"; done`,
  `ip route add blackhole "$gw/32" 2>/dev/null || true`,
  // IPv4 only: an IPv6 on-link prefix would reach the LAN; without IPv6 support only blackholes remain.
  "{ echo 1 > /proc/sys/net/ipv6/conf/all/disable_ipv6 && echo 1 > /proc/sys/net/ipv6/conf/default/disable_ipv6; } 2>/dev/null ||",
  "  { ip -6 route add blackhole fc00::/7; ip -6 route add blackhole fe80::/10; } 2>/dev/null || true",
  'exec "$@"',
].join("\n");

// pasta forwards every port bound in the namespace to the host (all interfaces) by default (`-t auto`):
// a listener in the jail would be reachable from the LAN. All four directions are off unless a jail asks.
export const PASTA_ARGS = ["--config-net", "--quiet", "--no-map-gw", "-t", "none", "-u", "none", "-T", "none", "-U", "none"];

function validPort(p: number): number {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`sandbox: invalid port ${p}`);
  return p;
}

/** pasta argv for a jail: no forwards, or exactly its `ports` (inbound bound to host loopback only). */
export function pastaArgs(ports: Jail["ports"] = {}): string[] {
  const expose = [...new Set(ports.expose ?? [])].map(validPort);
  const reach = [...new Set(ports.reach ?? [])].map(validPort);
  return [
    "--config-net", "--quiet", "--no-map-gw",
    ...(expose.length ? expose.flatMap((p) => ["-t", `127.0.0.1/${p}`]) : ["-t", "none"]),
    "-u", "none",
    ...(reach.length ? reach.flatMap((p) => ["-T", String(p)]) : ["-T", "none"]),
    "-U", "none",
  ];
}

const ETC = [
  "resolv.conf", "hosts", "nsswitch.conf", "host.conf", "gai.conf", "passwd", "group", "ssl", "ca-certificates",
  "ca-certificates.conf", "pki", "alternatives", "localtime", "ld.so.cache", "ld.so.conf", "ld.so.conf.d",
  "os-release", "mime.types", "protocols", "services",
];

function ok(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
  return r.status === 0;
}

export interface SandboxProbe {
  platform: NodeJS.Platform;
  bwrap: () => boolean;
  pasta: () => boolean;
}

export const hostProbe: SandboxProbe = {
  platform: process.platform,
  bwrap: () => ok("bwrap", ["--unshare-user", "--unshare-pid", "--die-with-parent", "--cap-drop", "ALL", "--ro-bind", "/", "/", "true"]),
  pasta: () => ok("pasta", [...PASTA_ARGS, "--", "sh", "-c", NET_SETUP, "factory-net", "true"]),
};

/** Decides the sandbox for a run; throws SandboxUnavailable when `required` cannot be met. */
export function createSandbox(mode: SandboxMode, probe: SandboxProbe = hostProbe): Sandbox {
  if (mode === "off") return { ...NO_SANDBOX, warnings: ["sandbox: off; agent commands run on the host"] };
  if (probe.platform !== "linux") {
    const why = `sandboxing is Linux only (platform ${probe.platform})`;
    if (mode === "required") throw new SandboxUnavailable([why]);
    return { mode, fs: "none", net: "shared", warnings: [`sandbox: ${why}; agent commands run on the host`] };
  }
  const bwrap = probe.bwrap();
  const pasta = bwrap && probe.pasta();
  if (mode === "required") {
    const missing = [!bwrap && "bwrap (bubblewrap) missing or user namespaces disabled", !pasta && "pasta (passt) or iproute2 missing or not working"].filter(
      (x): x is string => typeof x === "string",
    );
    if (missing.length) throw new SandboxUnavailable(missing);
  }
  if (!bwrap) return { mode, fs: "none", net: "shared", warnings: ["sandbox: bwrap unavailable; agent commands run on the host"] };
  if (!pasta) return { mode, fs: "bwrap", net: "shared", warnings: ["sandbox: pasta unavailable; agent commands share the host network (host services reachable)"] };
  return { mode, fs: "bwrap", net: "isolated", warnings: [] };
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Read-only binds for PATH entries outside /usr. A toolchain prefix (`<prefix>/bin` with its `lib`) is
 * bound whole unless it lies in a home directory; then only the bin dir itself. Entries overlapping a
 * `never` path (factory home, /run, …) are skipped.
 */
export function pathBinds(path: string, never: string[], home = homedir()): string[] {
  const out = new Set<string>();
  for (const raw of path.split(delimiter)) {
    if (!raw.startsWith("/")) continue;
    const dir = realOr(raw);
    if (!existsSync(dir) || inside("/usr", dir)) continue;
    const parent = dirname(dir);
    const target = basename(dir) === "bin" && parent !== "/" && !inside(home, parent) && !inside(parent, home) ? parent : dir;
    // Never a home directory or one of its ancestors (`/home`): other dotfiles (gh, ssh, cloud
    // credentials) would become readable. Never a `never` path or anything overlapping it.
    if (target === "/" || inside(target, home) || never.some((n) => inside(target, n) || inside(n, target))) continue;
    out.add(target);
  }
  return [...out];
}

/** uid/gid a jailed command runs as. */
export interface JailIds {
  uid: number;
  gid: number;
}

/** The factory process's own uid/gid (undefined off POSIX). */
export function hostIds(): JailIds | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : { uid, gid };
}

/**
 * bwrap argv (without the command) for a jail.
 *
 * The command runs as the factory's own uid/gid with every capability dropped. Without `--uid`/`--gid`,
 * bwrap keeps the caller's uid in the new user namespace: inside pasta's namespace that is 0, so repo
 * checks ran as root with CAP_DAC_OVERRIDE (a `chmod 000` file stayed readable, tests that expect a
 * permission error failed in the gate only). `ids` is injectable for tests.
 */
export function bwrapArgs(jail: Jail, cwd: string, env: { PATH?: string } = process.env, ids: JailIds | undefined = hostIds()): string[] {
  const a = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
  if (ids) a.push("--uid", String(ids.uid), "--gid", String(ids.gid));
  a.push("--cap-drop", "ALL");
  a.push("--ro-bind", "/usr", "/usr");
  for (const d of ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]) {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) a.push("--symlink", readlinkSync(d), d);
    else if (st.isDirectory()) a.push("--ro-bind", d, d);
  }
  for (const f of ETC) a.push("--ro-bind-try", `/etc/${f}`, `/etc/${f}`);
  // `/opt` is not bound whole (it can hold keys of unrelated software); toolchains under it come in
  // through their PATH entries below.
  const never = [...jail.rw, ...jail.ro, ...(jail.hide ?? []), "/run", "/var/run", "/proc", "/sys", "/dev", "/tmp", "/etc"].map(realOr);
  for (const d of pathBinds(env.PATH ?? "", never)) a.push("--ro-bind-try", d, d);
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const p of jail.rw) {
    const r = realOr(p);
    a.push("--bind", r, r);
    // A worktree's `.git` is a file naming its gitdir; rewriting it would point git at an
    // agent-controlled config on the next host-side git call.
    const dotGit = join(r, ".git");
    if (existsSync(dotGit)) a.push("--ro-bind", dotGit, dotGit);
  }
  for (const p of jail.ro) {
    const r = realOr(p);
    if (existsSync(r)) a.push("--ro-bind", r, r);
  }
  a.push("--setenv", "TMPDIR", "/tmp", "--chdir", realOr(cwd));
  return a;
}

/** The argv that runs `shell -c command` in the jail (or unjailed when the sandbox is off). */
export function jailedArgv(jail: Jail | undefined, shell: string, command: string, cwd: string, env?: { PATH?: string }, ids?: JailIds): string[] {
  const inner = [shell, "-c", command];
  if (!jail || jail.sandbox.fs === "none") return inner;
  const bw = ["bwrap", ...bwrapArgs(jail, cwd, env, ids ?? hostIds()), "--", ...inner];
  if (jail.sandbox.net === "shared") return bw;
  return ["pasta", ...pastaArgs(jail.ports), "--", "sh", "-c", NET_SETUP, "factory-net", ...bw];
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Same as jailedArgv, as one shell string for a `bash -c` host (Pi's bash tool). */
export function jailedCommand(jail: Jail | undefined, command: string, cwd: string, env?: { PATH?: string }): string {
  if (!jail || jail.sandbox.fs === "none") return command;
  return "exec " + jailedArgv(jail, "bash", command, cwd, env).map(shellQuote).join(" ");
}

/** Git common dir of a worktree (`<repo>/.git`), for the read-only bind. */
export function gitCommonDir(worktree: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8" });
  const dir = r.status === 0 ? r.stdout.trim() : "";
  return dir && statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? resolve(dir) : undefined;
}
