import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bashSpawnHook } from "../../src/agents/pi-runner.js";
import { sh } from "../../src/exec.js";
import { PathDenied, PathGuard } from "../../src/sandbox/guard.js";
import {
  createSandbox,
  hostProbe,
  type Jail,
  jailedArgv,
  pathBinds,
  type Sandbox,
  type SandboxProbe,
  SandboxUnavailable,
} from "../../src/sandbox/sandbox.js";

const probe = (p: Partial<SandboxProbe>): SandboxProbe => ({ platform: "linux", bwrap: () => true, pasta: () => true, ...p });

describe("sandbox decision (Amendment j)", () => {
  it("required needs bwrap and pasta", () => {
    expect(createSandbox("required", probe({}))).toEqual({ mode: "required", fs: "bwrap", net: "isolated", warnings: [] });
    expect(() => createSandbox("required", probe({ pasta: () => false }))).toThrow(SandboxUnavailable);
    expect(() => createSandbox("required", probe({ bwrap: () => false }))).toThrow(/bwrap/);
    expect(() => createSandbox("required", probe({ platform: "darwin" }))).toThrow(/Linux only/);
  });

  it("preferred degrades with warnings", () => {
    expect(createSandbox("preferred", probe({ pasta: () => false }))).toMatchObject({ fs: "bwrap", net: "shared", warnings: [expect.stringMatching(/host network/)] });
    expect(createSandbox("preferred", probe({ bwrap: () => false }))).toMatchObject({ fs: "none", net: "shared", warnings: [expect.stringMatching(/bwrap/)] });
    expect(createSandbox("preferred", probe({ platform: "darwin" }))).toMatchObject({ fs: "none", warnings: [expect.stringMatching(/Linux only/)] });
    expect(createSandbox("off", probe({}))).toMatchObject({ fs: "none", net: "shared" });
  });
});

describe("jail command line", () => {
  const sb = (s: Partial<Sandbox>): Sandbox => ({ mode: "required", fs: "bwrap", net: "isolated", warnings: [], ...s });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jail-")));
  const wt = join(dir, "runs", "r1", "worktree");
  const home = join(dir, "runs", "r1", "home");
  mkdirSync(wt, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
  const jail = (s: Partial<Sandbox> = {}): Jail => ({ sandbox: sb(s), rw: [wt, home], ro: [], hide: [dir] });

  it("isolated: pasta without host loopback or port forwards, then bwrap", () => {
    const argv = jailedArgv(jail(), "sh", "make test", wt, { PATH: "/usr/bin" });
    expect(argv.slice(0, 8)).toEqual(["pasta", "--config-net", "--quiet", "--no-map-gw", "-T", "none", "-U", "none"]);
    expect(argv.indexOf("bwrap")).toBeGreaterThan(0);
    expect(argv.slice(-3)).toEqual(["sh", "-c", "make test"]);
    const s = argv.join(" ");
    expect(s).toContain(`--bind ${wt} ${wt}`);
    expect(s).toContain(`--ro-bind ${wt}/.git ${wt}/.git`);
    expect(s).toContain("--unshare-user --unshare-pid");
    expect(s).toContain(`--chdir ${wt}`);
    expect(s).not.toMatch(/--(ro-)?bind(-try)? \/ /);
    expect(s).not.toMatch(/ \/run\b/);
    expect(s).toContain("blackhole");
  });

  it("shared net: bwrap only; sandbox none: plain shell", () => {
    expect(jailedArgv(jail({ net: "shared" }), "sh", "x", wt)[0]).toBe("bwrap");
    expect(jailedArgv(jail({ fs: "none" }), "sh", "x", wt)).toEqual(["sh", "-c", "x"]);
    expect(jailedArgv(undefined, "sh", "x", wt)).toEqual(["sh", "-c", "x"]);
  });

  it("PATH binds: /usr skipped, a home bin dir alone, a prefix outside home whole, hidden paths never", () => {
    const h = join(dir, "h");
    mkdirSync(join(h, ".local", "bin"), { recursive: true });
    mkdirSync(join(dir, "opt", "tool", "bin"), { recursive: true });
    mkdirSync(join(dir, "fh", "bin"), { recursive: true });
    const path = ["/usr/bin", join(h, ".local", "bin"), join(dir, "opt", "tool", "bin"), join(dir, "fh", "bin"), "relative/bin"].join(":");
    expect(pathBinds(path, [join(dir, "fh")], h)).toEqual([join(h, ".local", "bin"), join(dir, "opt", "tool")]);
  });

  it("PATH binds never expose a home dir or its ancestors, and /opt is not bound whole", () => {
    const h = join(dir, "h2", "me");
    mkdirSync(join(h, "bin"), { recursive: true });
    const path = [h, dirname(h), join(h, "bin")].join(":");
    expect(pathBinds(path, [], h)).toEqual([join(h, "bin")]);
    const args = jailedArgv(jail({}), "sh", "x", wt);
    expect(args.join(" ")).not.toMatch(/--ro-bind(-try)? \/opt \/opt/);
  });
});

describe("PathGuard (in-process tools)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-")));
  const wt = join(root, "wt");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "a.ts"), "a");
  writeFileSync(join(wt, ".git"), "gitdir: x");
  writeFileSync(join(root, "secret.json"), "SECRET");
  symlinkSync(join(root, "secret.json"), join(wt, "link.json"));
  symlinkSync(root, join(wt, "up"));
  symlinkSync(join(root, "nope"), join(wt, "dangling"));
  const g = new PathGuard([wt]);

  it("reads inside, denies outside and symlinks leading outside", async () => {
    expect((await g.readOps().readFile(join(wt, "src", "a.ts"))).toString()).toBe("a");
    await expect(g.readOps().readFile(join(root, "secret.json"))).rejects.toThrow(PathDenied);
    await expect(g.readOps().readFile(join(wt, "link.json"))).rejects.toThrow(/outside/);
    await expect(g.readOps().readFile(join(wt, "up", "secret.json"))).rejects.toThrow(/outside/);
    await expect(g.readOps().readFile(join(wt, "..", "secret.json"))).rejects.toThrow(/outside/);
    await expect(g.grepOps().isDirectory(root)).rejects.toThrow(PathDenied);
  });

  it("writes inside (new dirs too), never into .git or through a dangling symlink", async () => {
    await g.writeOps().mkdir(join(wt, "new", "deep"));
    await g.writeOps().writeFile(join(wt, "new", "deep", "b.ts"), "b");
    expect(readFileSync(join(wt, "new", "deep", "b.ts"), "utf8")).toBe("b");
    await expect(g.writeOps().writeFile(join(wt, ".git"), "gitdir: /evil")).rejects.toThrow(/git internals/);
    await expect(g.editOps().writeFile(join(wt, "sub", ".git", "config"), "x")).rejects.toThrow(/git internals/);
    await expect(g.writeOps().writeFile(join(wt, "dangling"), "x")).rejects.toThrow(/dangling/);
    await expect(g.writeOps().writeFile(join(wt, "link.json"), "x")).rejects.toThrow(/outside/);
    expect(existsSync(join(root, "nope"))).toBe(false);
    expect(readFileSync(join(root, "secret.json"), "utf8")).toBe("SECRET");
  });

  it("find and ls stay inside", async () => {
    const found = await g.findOps().glob("*.json", wt, { ignore: [], limit: 100 });
    expect(found).not.toContain("link.json");
    expect(found.some((f) => f.startsWith("up/"))).toBe(false);
    expect(await g.findOps().exists(root)).toBe(false);
    expect(await g.lsOps().readdir(wt)).toContain("link.json");
    await expect(g.lsOps().readdir(join(wt, "up"))).rejects.toThrow(PathDenied);
  });
});

const real = (() => {
  try {
    return createSandbox("required", hostProbe);
  } catch {
    return undefined;
  }
})();

describe.skipIf(!real)("real jail (bwrap + pasta on this host)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "realjail-")));
  const fh = join(base, "factory");
  const repo = join(base, "repo");
  const wt = join(fh, "runs", "r1", "worktree");
  const home = join(fh, "runs", "r1", "home");
  mkdirSync(join(fh, "pi"), { recursive: true });
  writeFileSync(join(fh, "pi", "auth.json"), "SECRET-AUTH");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  git(repo, "worktree", "add", "-q", "-b", "w", wt);
  const jail: Jail = { sandbox: real!, rw: [wt, home], ro: [join(repo, ".git")], hide: [fh] };
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
  const run = (cmd: string) => sh(cmd, { cwd: wt, env, jail, timeoutMs: 30_000 });

  it("writes the worktree and HOME, nothing else; secrets and the docker socket are invisible", async () => {
    expect((await run("echo hi > out.txt && echo h > $HOME/x && cat out.txt")).output).toBe("hi\n");
    expect(readFileSync(join(wt, "out.txt"), "utf8")).toBe("hi\n");
    expect((await run(`cat ${join(fh, "pi", "auth.json")}`)).code).not.toBe(0);
    // The repo dir is not bound: a write lands in the jail's private tmpfs at most, never on the host.
    await run(`echo x > ${join(repo, "evil.txt")}`);
    expect(existsSync(join(repo, "evil.txt"))).toBe(false);
    expect((await run("test -e /run/docker.sock || test -e /var/run/docker.sock")).code).not.toBe(0);
    // The host HOME is at most a skeleton of bound PATH dirs (e.g. ~/.local/bin).
    const hostHome = process.env.HOME ?? "/root";
    expect((await run(`test -e ${hostHome}/.factory || test -e ${hostHome}/.ssh || test -e ${hostHome}/.gitconfig`)).code).not.toBe(0);
  });

  it("git metadata is read-only: no gitdir rewrite, no config (fsmonitor), status still works", async () => {
    expect((await run("echo 'gitdir: /tmp/evil' > .git")).code).not.toBe(0);
    expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/gitdir: .*worktrees/);
    expect((await run("git config core.fsmonitor 'touch /tmp/pwned'")).code).not.toBe(0);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("fsmonitor");
  }, 30_000);

  it("network: host loopback and host interface addresses are unreachable", async () => {
    const server = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    const port = (server.address() as { port: number }).port;
    try {
      const hosts = ["127.0.0.1", ...Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4").map((i) => i!.address)];
      for (const h of new Set(hosts)) {
        const probeCmd = `node -e "const s=require('net').connect(${port},'${h}');s.setTimeout(3000,()=>process.exit(4));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3))"`;
        const r = await run(probeCmd);
        expect({ h, code: r.code }).not.toEqual({ h, code: 0 });
      }
    } finally {
      server.close();
    }
  }, 60_000);

  it("own pid namespace: host processes are invisible", async () => {
    expect((await run(`kill -0 ${process.pid}`)).code).not.toBe(0);
  });

  it("Pi bash hook wraps the command into the same jail", async () => {
    const hook = bashSpawnHook(env, jail);
    const out = hook({ command: `echo ok > hook.txt; cat ${join(fh, "pi", "auth.json")}`, cwd: wt, env: { GH_TOKEN: "leak" } });
    expect(out.env).toEqual(env);
    const r = await sh(out.command, { cwd: wt, env: out.env });
    expect(readFileSync(join(wt, "hook.txt"), "utf8")).toBe("ok\n");
    expect(r.output).not.toContain("SECRET-AUTH");
  });
});
