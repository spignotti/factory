import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACTORY_NODE_FALLBACK,
  NODE_ENGINE,
  nodeCheck,
  parseNodeVersion,
  resolveNode,
  satisfiesNodeEngine,
} from "../../src/node-runtime.js";

describe("node resolution", () => {
  it("honours FACTORY_NODE over PATH", () => {
    const r = resolveNode({
      env: { FACTORY_NODE: "/opt/node", PATH: "/usr/bin" },
      exists: (p) => p === "/opt/node" || p === "/usr/bin/node",
      versionOf: () => "v22.19.0",
    });
    expect(r).toMatchObject({ path: "/opt/node", source: "FACTORY_NODE" });
  });

  it("uses PATH when FACTORY_NODE is unset", () => {
    const r = resolveNode({
      env: { PATH: "/usr/bin" },
      exists: (p) => p === "/usr/bin/node",
      versionOf: () => "v22.20.0",
    });
    expect(r).toMatchObject({ path: "/usr/bin/node", source: "PATH" });
  });

  it("falls back to ~/.local/share/factory-node/bin/node", () => {
    const r = resolveNode({
      env: { PATH: "" },
      exists: (p) => p === FACTORY_NODE_FALLBACK,
      versionOf: () => "v22.19.0",
    });
    expect(r).toMatchObject({ path: FACTORY_NODE_FALLBACK, source: "fallback" });
  });

  it("returns a one-line fix hint when nothing resolves", () => {
    const r = resolveNode({ env: { PATH: "" }, exists: () => false });
    expect(r).toMatchObject({ error: expect.stringMatching(/node not found: set FACTORY_NODE/) });
  });

  it("parses versions and enforces engines.node", () => {
    expect(parseNodeVersion("v22.18.9")).toMatchObject({ major: 22, minor: 18, patch: 9 });
    expect(satisfiesNodeEngine("v22.19.0", NODE_ENGINE)).toBe(true);
    expect(satisfiesNodeEngine("v22.18.0", NODE_ENGINE)).toBe(false);
  });

  it("doctor node check fails on old node", () => {
    const c = nodeCheck({
      env: { FACTORY_NODE: "/n" },
      exists: () => true,
      versionOf: () => "v20.0.0",
    });
    expect(c).toMatchObject({ status: "fail", detail: expect.stringMatching(/requires node/) });
  });

  it("doctor node check ok reports path and version", () => {
    const c = nodeCheck({
      env: { FACTORY_NODE: "/n" },
      exists: () => true,
      versionOf: () => "v22.19.1",
    });
    expect(c).toMatchObject({ status: "ok", detail: expect.stringMatching(/^\/n \(v22\.19\.1, via FACTORY_NODE\)/) });
  });
});

describe("factory doctor: node check", () => {
  it("includes the node check in doctor output", async () => {
    const { doctorCommand } = await import("../../src/commands/doctor.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    const view = {
      resolve: () => ({ baseUrl: "https://opencode.ai/inference", api: "x" }),
      auth: () => ({ configured: true, subscription: true, source: "stored" }),
      modelsJsonBaseUrls: () => [],
      ping: async () => {},
    };
    let out = "";
    await doctorCommand(
      { factoryHome: home, json: true, probe: { platform: "linux", bwrap: () => true, pasta: () => true }, view },
      { out: (s) => (out += s), err: () => {} },
    );
    const r = JSON.parse(out) as { checks: { name: string; status: string }[]; ok: boolean };
    expect(r.checks.find((c) => c.name === "node")?.status).toBe("ok");
  });
});
