import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, usageFor } from "../../src/cli.js";
import { createFixtureRepo } from "../helpers/repo.js";

const COMMANDS = ["run", "resume", "abandon", "standards", "doctor", "queue", "status", "stats", "gc", "gates", "eval", "experiment", "adopt", "improve", "harden", "audit", "notify", "ci-stub"];

describe("subcommand --help", () => {
  it("prints that command's usage and exits 0 for --help and -h", async () => {
    for (const command of COMMANDS) {
      for (const flag of ["--help", "-h"]) {
        let out = "";
        let err = "";
        expect(await main([command, flag], { out: (s) => void (out += s), err: (s) => void (err += s) }), `${command} ${flag}`).toBe(0);
        expect(out, command).toBe("");
        expect(err, command).toContain(`factory ${command}`);
        expect(err, command).not.toMatch(/Unknown option/);
        if (command !== "queue") expect(err, command).not.toContain("factory queue add");
      }
    }
    let err = "";
    expect(await main(["queue", "--help"], { out: () => {}, err: (s) => void (err += s) })).toBe(0);
    expect(err).toContain("factory queue add");
    expect(err).toContain("factory queue run");
    expect(err).not.toContain("factory ci-stub");
    err = "";
    expect(await main(["queue", "add", "--help"], { out: () => {}, err: (s) => void (err += s) })).toBe(0);
    expect(err).toContain("factory queue add");
    expect(err).not.toContain("factory queue run");
    expect(usageFor(["ci-stub", "--ref", "v0.4.0", "--help"])).toContain("factory ci-stub");
    expect(usageFor(["--help"])).toContain("factory abandon");
    expect(usageFor(["run", "--help"])).not.toMatch(/--lane|fast lane/);
  });

  it("rejects --lane fast and ignores --lane standard", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => void err.push(s) };
    expect(await main(["run", "--repo", "/tmp/nope", "--text", "t.md", "--lane", "fast"], io)).toBe(1);
    expect(err.join("")).toMatch(/fast lane was removed/);

    const home = mkdtempSync(join(tmpdir(), "fh-"));
    const repo = createFixtureRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    err.length = 0;
    try {
      expect(await main(["run", "--repo", repo, "--text", "t.md", "--lane", "standard"], io)).toBe(2);
      expect(err.join("")).toMatch(/notify hook|--no-notify/);
      expect(err.join("")).not.toMatch(/fast lane|invalid --lane/);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });
});
