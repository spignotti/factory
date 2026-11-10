import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { killRunningCommands, resetKilledCommands, sh } from "../../src/exec.js";
import { GIT_LOCAL_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS, changedFiles, discardChanges, git, gitTimeoutMs, remoteBranchExists, stageAll, withBaseWorktree } from "../../src/git.js";
import { addOrigin, createFixtureRepo, gitIn } from "../helpers/repo.js";

describe("git helpers", () => {
  it("discardChanges removes staged edits and new files", async () => {
    const dir = createFixtureRepo();
    writeFileSync(join(dir, "src/math.js"), "broken");
    writeFileSync(join(dir, "src/new.js"), "x");
    await stageAll(dir);
    await discardChanges(dir);
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "src/new.js"))).toBe(false);
  });

  it("changedFiles reports both sides of a rename", async () => {
    const dir = createFixtureRepo();
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "mv", "AGENTS.md", "docs-agents.md");
    expect(await changedFiles(dir, base)).toEqual(["AGENTS.md", "docs-agents.md"]);
  });
});

describe("git errors and worktrees", () => {
  it("a missing cwd keeps the spawn error instead of an empty git ls-files message", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "git-missing-")), "nope");
    await expect(git(missing, ["ls-files"])).rejects.toThrow(/git ls-files failed: spawn git ENOENT/);
  });

  it("a relative worktree path is created where the caller asked, and git ls-files works there", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-rel-"));
    const prev = process.cwd();
    try {
      process.chdir(root);
      mkdirSync("repo");
      await git("repo", ["init", "-q", "-b", "main"]);
      writeFileSync("repo/a.txt", "a\n");
      await git("repo", ["add", "a.txt"]);
      await git("repo", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
      const sha = (await git("repo", ["rev-parse", "HEAD"])).trim();
      const listed = await withBaseWorktree("repo", sha, "out/wt", async (dir) => {
        expect(dir).toBe(resolve(root, "out/wt"));
        expect(existsSync("out/wt")).toBe(true);
        expect(existsSync("repo/out/wt")).toBe(false);
        return git(dir, ["ls-files"]);
      });
      expect(listed).toContain("a.txt");
    } finally {
      process.chdir(prev);
    }
  });
});

describe("git timeouts", () => {
  it("uses 1 min for local git and 5 min for network git", () => {
    expect(GIT_LOCAL_TIMEOUT_MS).toBe(60_000);
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(5 * 60_000);
    expect(gitTimeoutMs(["status"])).toBe(GIT_LOCAL_TIMEOUT_MS);
    expect(gitTimeoutMs(["-c", "user.name=t", "commit", "-q"])).toBe(GIT_LOCAL_TIMEOUT_MS);
    expect(gitTimeoutMs(["fetch", "--quiet", "origin", "main"])).toBe(GIT_NETWORK_TIMEOUT_MS);
    expect(gitTimeoutMs(["push", "-q", "-u", "origin", "factory/x"])).toBe(GIT_NETWORK_TIMEOUT_MS);
    expect(gitTimeoutMs(["ls-remote", "--heads", "origin", "refs/heads/main"])).toBe(GIT_NETWORK_TIMEOUT_MS);
  });

  it("kills the process group and reports a timeout", async () => {
    const bin = mkdtempSync(join(tmpdir(), "git-timeout-"));
    const pidFile = join(bin, "pid");
    const childFile = join(bin, "child");
    const script = join(bin, "git");
    writeFileSync(script, `#!/bin/sh\necho $$ > ${pidFile}\nsleep 30 &\necho $! > ${childFile}\nwait\n`);
    chmodSync(script, 0o755);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    // Wait for the fake to actually run before a short timeout can fire, so a loaded worker does
    // not kill a not-started process (which would be a vacuous, passing kill).
    const run = git(bin, ["fetch"], { timeoutMs: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const start = Date.now();
    while (!existsSync(pidFile)) {
      if (Date.now() - start > 4_000) throw new Error("fake git never started");
      run.catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    }
    const started = Date.now();
    await expect(run).rejects.toThrow(/git fetch timed out after 10s \(process killed\)/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(alive(Number(readFileSync(childFile, "utf8")))).toBe(false);
  });
});

describe("remoteBranchExists", () => {
  it("is false without an origin, true/false by ls-remote, and true when origin is unreachable", async () => {
    const dir = createFixtureRepo();
    expect(await remoteBranchExists(dir, "main")).toBe(false);
    addOrigin(dir, ["factory/taken"]);
    expect(await remoteBranchExists(dir, "factory/taken")).toBe(true);
    expect(await remoteBranchExists(dir, "factory/free")).toBe(false);
    gitIn(dir, "remote", "set-url", "origin", join(dir, "does-not-exist.git"));
    expect(await remoteBranchExists(dir, "factory/free")).toBe(true);
  });
});

describe("sh", () => {
  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const r = await sh("sleep 30 & sleep 30; echo never", { cwd: "/", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("killRunningCommands (signal handler)", () => {
  it("kills running process groups and refuses to start new commands", async () => {
    const env = { PATH: process.env.PATH ?? "" };
    const started = Date.now();
    const running = sh("sleep 30 & sleep 30", { cwd: "/", env });
    await new Promise((r) => setTimeout(r, 100));
    killRunningCommands("SIGTERM");
    try {
      const r = await running;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.code).not.toBe(0);
      expect(r.output).toContain("killed: SIGTERM");
      const next = await sh("echo ran", { cwd: "/", env });
      expect(next).toMatchObject({ code: 130 });
      expect(next.output).not.toContain("ran\n");
    } finally {
      resetKilledCommands();
    }
    expect((await sh("echo ran", { cwd: "/", env })).output).toBe("ran\n");
  });
});
