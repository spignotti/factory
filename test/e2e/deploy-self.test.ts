import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "deploy-self.sh");
const FACTORY_BIN = join(__dirname, "..", "..", "scripts", "factory");
const RESOLVE_NODE = join(__dirname, "..", "..", "scripts", "resolve-node.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A fake factory: `dist/cli.js` is copied from `cli.js` by the build; `lib.txt` is read lazily.
const CLI = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
if (process.argv[2] === "--version") { console.log(fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim()); process.exit(0); }
if (process.argv[2] === "where") { console.log(__filename); process.exit(0); }
if (process.argv[2] === "late") { setTimeout(() => console.log(fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim()), Number(process.argv[3])); }
`;
const BUILD = 'test ! -e FAIL_BUILD && mkdir -p dist && cp cli.js dist/cli.js';

let tmp: string;
let upstream: string;
let env: NodeJS.ProcessEnv;
let rel: string;
let bin: string;
let fhome: string;
let kids: ReturnType<typeof spawn>[] = [];

function commit(version: string, extra: Record<string, string> = {}): string {
  writeFileSync(join(upstream, "VERSION"), version);
  writeFileSync(join(upstream, "cli.js"), CLI);
  const scripts = join(upstream, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "factory"), readFileSync(FACTORY_BIN));
  writeFileSync(join(scripts, "resolve-node.sh"), readFileSync(RESOLVE_NODE));
  execFileSync("chmod", ["+x", join(scripts, "factory")]);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(upstream, f), c);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", version, "--allow-empty");
  return git(upstream, "rev-parse", "HEAD").slice(0, 12);
}

function deploy(cmd = "once", extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, cmd], { env: { ...env, ...extraEnv }, encoding: "utf8" });
}

const state = () => JSON.parse(readFileSync(join(rel, "state.json"), "utf8")) as Record<string, string>;
// runs the bin link itself (shebang + exec bit), like a shell does
const runBin = (...args: string[]) => execFileSync(bin, args, { encoding: "utf8" }).trim();
const releases = () => readdirSync(rel).filter((n) => /^[0-9a-f]{12}$/.test(n));
const logText = () => readFileSync(join(rel, "deploy.log"), "utf8");
const hold = (child: ReturnType<typeof spawn>) => {
  kids.push(child);
  return child;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The factory launcher execs node on the same pid; wait until that command line names the release. */
async function waitForCmdline(pid: number, needle: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`).includes(needle)) return;
    } catch {
      // process not visible yet
    }
    await sleep(50);
  }
  throw new Error(`pid ${pid} cmdline never contained ${needle}`);
}
async function waitForCwd(pid: number, dir: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) === dir) return;
    } catch {
      // process not visible yet
    }
    await sleep(50);
  }
  throw new Error(`pid ${pid} cwd never became ${dir}`);
}

beforeEach(() => {
  kids = [];
  tmp = mkdtempSync(join(tmpdir(), "deploy-self-"));
  upstream = join(tmp, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "config", "user.email", "t@t");
  git(upstream, "config", "user.name", "t");
  commit("1.0.0-a");
  const src = join(tmp, "src");
  git(tmp, "clone", "-q", upstream, src);
  rel = join(tmp, "releases");
  bin = join(tmp, "bin", "factory");
  fhome = join(tmp, "fhome");
  env = {
    ...process.env,
    FACTORY_DEPLOY_SRC: src,
    FACTORY_RELEASES: rel,
    FACTORY_DEPLOY_BIN: bin,
    FACTORY_DEPLOY_LIB_LINK: join(tmp, "lib", "node_modules", "factory"),
    FACTORY_HOME: fhome,
    FACTORY_DEPLOY_BUILD: BUILD,
  };
});

afterEach(() => {
  for (const p of kids) if (p.exitCode === null) p.kill();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scripts/deploy-self.sh", () => {
  it("builds the first release, links current and the bin, and is idempotent", () => {
    const a = git(upstream, "rev-parse", "HEAD").slice(0, 12);
    const r = deploy();
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(rel, "current"))).toBe(a);
    expect(readlinkSync(bin)).toBe(join(rel, "current", "scripts", "factory"));
    expect(runBin("--version")).toBe("1.0.0-a");
    // node resolves the bin link to the release's real path
    expect(runBin("where")).toBe(join(realpathSync(rel), a, "dist", "cli.js"));
    expect(state()).toMatchObject({ last_result: "deployed", current: a });
    const u = deploy();
    expect(u.status).toBe(0);
    expect(u.stdout).toMatch(/^deploy: up_to_date /);
    expect(state().last_result).toBe("up_to_date");
  });

  it("keeps the current release when a build fails", () => {
    const a = git(upstream, "rev-parse", "HEAD").slice(0, 12);
    deploy();
    const b = commit("1.0.0-b", { FAIL_BUILD: "1" });
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^deploy: build_failed /);
    expect(readlinkSync(join(rel, "current"))).toBe(a);
    expect(runBin("--version")).toBe("1.0.0-a");
    expect(state()).toMatchObject({ last_result: "build_failed", failed_sha: b, current: a });
  });

  it("switches while an unrelated live lock is held", () => {
    deploy();
    const b = commit("1.0.0-b");
    mkdirSync(join(fhome, "locks"), { recursive: true });
    writeFileSync(join(fhome, "locks", "repo.lock"), `${process.pid}\nrun-1`);
    const d = deploy();
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout).toMatch(/^deploy: deployed /);
    expect(state()).toMatchObject({ last_result: "deployed", current: b, pending: "" });
    expect(readlinkSync(join(rel, "current"))).toBe(b);
    expect(runBin("--version")).toBe("1.0.0-b");
    // a stale lock (dead pid) does not change the result
    writeFileSync(join(fhome, "locks", "repo.lock"), `999999999\nrun-1`);
    expect(deploy().stdout).toMatch(/^deploy: up_to_date /);
  });

  it("switches while a process runs on the old release and prunes it only after exit", async () => {
    deploy();
    const a = readlinkSync(join(rel, "current"));
    const p = hold(spawn(bin, ["late", "60000"], { stdio: "ignore" }));
    await waitForCmdline(p.pid!, join(rel, a));
    let last = "";
    for (const v of ["b", "c", "d"]) {
      last = commit(`1.0.0-${v}`);
      const r = deploy();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^deploy: deployed /);
    }
    expect(readlinkSync(join(rel, "current"))).toBe(last);
    expect(runBin("--version")).toBe("1.0.0-d");
    expect(releases()).toContain(a);
    expect(logText()).toMatch(new RegExp(`in-use releases left in place:.*\\b${a}\\b`));
    p.kill();
    await new Promise((r) => p.on("exit", r));
    const again = deploy();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^deploy: up_to_date /);
    expect(releases()).not.toContain(a);
    expect(releases()).toHaveLength(3);
    expect(logText()).toMatch(new RegExp(`pruning release ${a}`));
  });

  it("keeps a release a live lock's process was started from, then prunes it", async () => {
    deploy();
    const a = readlinkSync(join(rel, "current"));
    // Command line does not name the release; the working directory does. The lock makes that process a run.
    const p = hold(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: join(rel, a), stdio: "ignore" }));
    await waitForCwd(p.pid!, join(rel, a));
    mkdirSync(join(fhome, "locks"), { recursive: true });
    writeFileSync(join(fhome, "locks", "repo.lock"), `${p.pid}\nrun-1`);
    let last = "";
    const shas: string[] = [];
    for (const v of ["b", "c", "d", "e"]) {
      last = commit(`1.0.0-${v}`);
      shas.push(last);
      expect(deploy().status).toBe(0);
    }
    expect(readlinkSync(join(rel, "current"))).toBe(last);
    expect(releases()).toContain(a);
    // A live lock whose process is readable does not block pruning of unused releases (/proc reports size 0).
    expect(logText()).not.toMatch(/prune skipped/);
    expect(releases()).not.toContain(shas[0]);
    p.kill();
    await new Promise((r) => p.on("exit", r));
    // The lock file is still there; its pid is dead, so it no longer protects the release.
    expect(deploy().status).toBe(0);
    expect(releases()).not.toContain(a);
    expect(releases()).toHaveLength(3);
  });

  it("leaves a process started on the old release on its files after the switch", async () => {
    deploy();
    commit("1.0.0-b");
    const p = hold(spawn(bin, ["late", "1500"], { stdio: ["ignore", "pipe", "inherit"] }));
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    await waitForCmdline(p.pid!, join(realpathSync(rel)));
    expect(deploy().status).toBe(0);
    expect(runBin("--version")).toBe("1.0.0-b");
    await new Promise((r) => p.on("exit", r));
    expect(out.trim()).toBe("1.0.0-a");
  });

  it("keeps the newest releases and prunes the rest", () => {
    deploy();
    let last = "";
    for (const v of ["b", "c", "d", "e"]) {
      last = commit(`1.0.0-${v}`);
      expect(deploy().status).toBe(0);
    }
    expect(readlinkSync(join(rel, "current"))).toBe(last);
    expect(releases().length).toBe(3);
    expect(releases()).toContain(last);
  });

  it("fails clearly without node and changes nothing", () => {
    // PATH with everything from /usr/bin except node
    const noNode = join(tmp, "no-node-bin");
    mkdirSync(noNode);
    for (const n of readdirSync("/usr/bin")) if (n !== "node" && n !== "nodejs") symlinkSync(join("/usr/bin", n), join(noNode, n));
    const plain = noNode;
    const r = deploy("once", { PATH: plain });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/node not found: set FACTORY_NODE/);
    expect(existsSync(join(rel, "current"))).toBe(false);
    expect(existsSync(bin)).toBe(false);
  });
});
