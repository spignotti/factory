import { describe, expect, it } from "vitest";
import { main, usageFor } from "../../src/cli.js";

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
  });
});
