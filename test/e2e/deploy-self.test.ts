import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "scripts", "deploy-self.sh");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A fake factory: `dist/cli.js` is copied from `cli.js` by the build; `lib.txt` is read lazily.
const CLI = `const fs = require("fs"), path = require("path");
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

function commit(version: string, extra: Record<string, string> = {}): string {
  writeFileSync(join(upstream, "VERSION"), version);
  writeFileSync(join(upstream, "cli.js"), CLI);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(upstream, f), c);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", version, "--allow-empty");
  return git(upstream, "rev-parse", "HEAD").slice(0, 12);
}

function deploy(cmd = "once", extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [SCRIPT, cmd], { env: { ...env, ...extraEnv }, encoding: "utf8" });
}

const state = () => JSON.parse(readFileSync(join(rel, "state.json"), "utf8")) as Record<string, string>;
const runBin = (...args: string[]) => execFileSync("node", [bin, ...args], { encoding: "utf8" }).trim();
const releases = () => readdirSync(rel).filter((n) => /^[0-9a-f]{12}$/.test(n));

beforeEach(() => {
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
    FACTORY_DEPLOY_PROC_RE: `${tmp}/bin/factory( |$)`,
  };
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("scripts/deploy-self.sh", () => {
  it("builds the first release, links current and the bin, and is idempotent", () => {
    const a = git(upstream, "rev-parse", "HEAD").slice(0, 12);
    const r = deploy();
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(rel, "current"))).toBe(a);
    expect(readlinkSync(bin)).toBe(join(rel, "current", "dist", "cli.js"));
    expect(runBin("--version")).toBe("1.0.0-a");
    // node resolves the bin link to the release's real path
    expect(runBin("where")).toBe(join(realpathSync(rel), a, "dist", "cli.js"));
    expect(state()).toMatchObject({ last_result: "deployed", current: a });
    expect(deploy().status).toBe(0);
    expect(state().last_result).toBe("up_to_date");
  });

  it("keeps the current release when a build fails", () => {
    const a = git(upstream, "rev-parse", "HEAD").slice(0, 12);
    deploy();
    const b = commit("1.0.0-b", { FAIL_BUILD: "1" });
    const r = deploy();
    expect(r.status).toBe(1);
    expect(readlinkSync(join(rel, "current"))).toBe(a);
    expect(runBin("--version")).toBe("1.0.0-a");
    expect(state()).toMatchObject({ last_result: "build_failed", failed_sha: b, current: a });
  });

  it("defers the switch while a factory run holds a live lock", () => {
    const a = git(upstream, "rev-parse", "HEAD").slice(0, 12);
    deploy();
    const b = commit("1.0.0-b");
    mkdirSync(join(fhome, "locks"), { recursive: true });
    writeFileSync(join(fhome, "locks", "repo.lock"), `${process.pid}\nrun-1`);
    expect(deploy().status).toBe(0);
    expect(state()).toMatchObject({ last_result: "deferred", pending: b });
    expect(readlinkSync(join(rel, "current"))).toBe(a);
    // a stale lock (dead pid) does not block
    writeFileSync(join(fhome, "locks", "repo.lock"), `999999999\nrun-1`);
    expect(deploy().status).toBe(0);
    expect(readlinkSync(join(rel, "current"))).toBe(b);
    expect(runBin("--version")).toBe("1.0.0-b");
  });

  it("defers the switch while a factory process runs", async () => {
    deploy();
    commit("1.0.0-b");
    const p = spawn("node", [bin, "late", "1500"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(deploy().status).toBe(0);
    expect(state().last_result).toBe("deferred");
    await new Promise((r) => p.on("exit", r));
  });

  it("leaves a process started on the old release on its files after the switch", async () => {
    deploy();
    commit("1.0.0-b");
    const p = spawn("node", [bin, "late", "1500"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 300));
    // switch while it runs (process detection disabled for this check)
    expect(deploy("once", { FACTORY_DEPLOY_PROC_RE: "^no-such-process$" }).status).toBe(0);
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
    expect(r.stderr).toMatch(/node not found on PATH/);
    expect(existsSync(join(rel, "current"))).toBe(false);
    expect(existsSync(bin)).toBe(false);
  });
});
