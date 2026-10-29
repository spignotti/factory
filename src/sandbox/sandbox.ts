import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/**
 * Process sandbox for agent bash and repo commands (setup, checks, tests): bubblewrap for the
 * filesystem, pasta for the network (SPEC Amendment j). Linux only.
 *
 * - Filesystem: system dirs read-only; read-write only the run's worktree and agent HOME (bound at the
 *   same paths, so in-process tools and bash agree on paths); the worktree's `.git` file and the main
 *   repo's git dir read-only (git is read-only for agents; a writable gitdir could set hooks or
 *   `core.fsmonitor` that would run on the host); a private /tmp. Never bound: /run (docker socket),
 *   other homes, `$FACTORY_HOME` (auth.json) except the run's own dirs.
 * - Network: own namespace through pasta without host loopback (`--no-map-gw`, no port forwards) and
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
}

export const NO_SANDBOX: Sandbox = { mode: "off", fs: "none", net: "shared", warnings: [] };

/** Runs inside pasta's namespace (root there), before bwrap: routes, then exec bwrap. */
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

export const PASTA_ARGS = ["--config-net", "--quiet", "--no-map-gw", "-T", "none", "-U", "none"];

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
  bwrap: () => ok("bwrap", ["--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "true"]),
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
    if (target === "/" || never.some((n) => inside(target, n) || inside(n, target))) continue;
    out.add(target);
  }
  return [...out];
}

/** bwrap argv (without the command) for a jail. */
export function bwrapArgs(jail: Jail, cwd: string, env: { PATH?: string } = process.env): string[] {
  const a = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
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
  a.push("--ro-bind-try", "/opt", "/opt");
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
export function jailedArgv(jail: Jail | undefined, shell: string, command: string, cwd: string, env?: { PATH?: string }): string[] {
  const inner = [shell, "-c", command];
  if (!jail || jail.sandbox.fs === "none") return inner;
  const bw = ["bwrap", ...bwrapArgs(jail, cwd, env), "--", ...inner];
  if (jail.sandbox.net === "shared") return bw;
  return ["pasta", ...PASTA_ARGS, "--", "sh", "-c", NET_SETUP, "factory-net", ...bw];
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
