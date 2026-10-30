import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { describeToolchains, detectToolchains, resolveToolchains } from "../../src/toolchains.js";

const repoWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-toolchains-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};

describe("CI toolchains", () => {
  it("bare repo: node 22 only", () => {
    expect(detectToolchains(repoWith({}))).toEqual({ node: "22", pnpm: false, pnpm_version: "", python: "", uv: false, uv_version: "" });
  });

  it("uv repo (uv.lock or [tool.uv]) gets uv; .python-version sets python", () => {
    expect(detectToolchains(repoWith({ "uv.lock": "", "pyproject.toml": "[project]\nname='x'\n" }))).toMatchObject({ uv: true, python: "" });
    expect(detectToolchains(repoWith({ "pyproject.toml": "[tool.uv]\ndev-dependencies = []\n", ".python-version": "3.12\n" }))).toMatchObject({ uv: true, python: "3.12" });
    expect(detectToolchains(repoWith({ "pyproject.toml": "[project]\nname='x'\n" }))).toMatchObject({ uv: false });
  });

  it("pnpm: packageManager wins (no second version for pnpm/action-setup); a bare lockfile gets pnpm 10", () => {
    expect(detectToolchains(repoWith({ "package.json": JSON.stringify({ packageManager: "pnpm@10.34.6" }), "pnpm-lock.yaml": "" }))).toMatchObject({ pnpm: true, pnpm_version: "" });
    expect(detectToolchains(repoWith({ "package.json": "{}", "pnpm-lock.yaml": "" }))).toMatchObject({ pnpm: true, pnpm_version: "10" });
    expect(detectToolchains(repoWith({ "package.json": "{}", "package-lock.json": "{}" }))).toMatchObject({ pnpm: false });
  });

  it("node from .nvmrc/.node-version, never below the factory's floor", () => {
    expect(detectToolchains(repoWith({ ".nvmrc": "v24.1.0\n" })).node).toBe("24.1.0");
    const notes: string[] = [];
    expect(detectToolchains(repoWith({ ".node-version": "20\n" }), notes).node).toBe("22");
    expect(notes[0]).toMatch(/\.node-version asks for node 20; CI uses node 22/);
    expect(detectToolchains(repoWith({ ".nvmrc": "lts/*\n" })).node).toBe("22");
  });

  it("repo.yaml ci.toolchains overrides field by field", () => {
    const dir = repoWith({ "uv.lock": "", "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }) });
    const cfg = parseRepoConfig("ci:\n  toolchains:\n    uv: '0.9.5'\n    python: '3.13'\n    pnpm: '10.1.0'\n    node: '24'\n");
    const { toolchains, notes } = resolveToolchains(dir, cfg);
    expect(toolchains).toEqual({ node: "24", pnpm: true, pnpm_version: "", python: "3.13", uv: true, uv_version: "0.9.5" });
    expect(notes).toEqual([expect.stringMatching(/packageManager pins pnpm/)]);
    expect(resolveToolchains(dir, parseRepoConfig("ci:\n  toolchains:\n    uv: false\n    pnpm: false\n")).toolchains).toMatchObject({ uv: false, pnpm: false, pnpm_version: "" });
    expect(resolveToolchains(repoWith({}), parseRepoConfig("ci:\n  toolchains:\n    pnpm: true\n")).toolchains).toMatchObject({ pnpm: true, pnpm_version: "10" });
    expect(describeToolchains(toolchains)).toBe("node 24, pnpm (packageManager), python 3.13, uv 0.9.5");
  });

  it("repo.yaml rejects unknown toolchains and unsafe versions", () => {
    expect(() => parseRepoConfig("ci:\n  toolchains:\n    ruby: '3'\n")).toThrow();
    expect(() => parseRepoConfig("ci:\n  toolchains:\n    node: '22; rm -rf /'\n")).toThrow(/toolchain versions/);
  });

  it("factory gates --toolchains --json prints the resolved object", async () => {
    const dir = repoWith({ ".factory/repo.yaml": "checks: []\n", "uv.lock": "" });
    let out = "";
    expect(await main(["gates", "--toolchains", "--json", "--repo", dir], { out: (s) => void (out += s), err: () => {} })).toBe(0);
    expect(JSON.parse(out)).toEqual({ node: "22", pnpm: false, pnpm_version: "", python: "", uv: true, uv_version: "" });
  });
});
