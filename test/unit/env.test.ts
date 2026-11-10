import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentEnv, prepareAgentHome } from "../../src/agents/env.js";

const parent = {
  PATH: "/usr/bin",
  LANG: "C.UTF-8",
  HOME: "/home/real",
  FOO_TOKEN: "fake-foo-secret-value",
  GH_TOKEN: "fake-gh-secret",
  OPENAI_API_KEY: "fake-openai",
  DATABASE_URL: "postgres://x",
};

describe("agent env allowlist", () => {
  const home = prepareAgentHome(mkdtempSync(join(tmpdir(), "run-")));

  it("drops everything not allowlisted", () => {
    const env = buildAgentEnv(parent, { home });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env).not.toHaveProperty("FOO_TOKEN");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(Object.values(env)).not.toContain("fake-foo-secret-value");
  });

  it("points package caches at $FACTORY_HOME/cache and keeps HOME isolated", () => {
    const fh = mkdtempSync(join(tmpdir(), "fh-cache-"));
    const env = buildAgentEnv(parent, { home, factoryHome: fh });
    const cache = join(fh, "cache");
    expect(env.UV_CACHE_DIR).toBe(cache);
    expect(env.npm_config_cache).toBe(cache);
    expect(env.PIP_CACHE_DIR).toBe(cache);
    expect(env.XDG_CACHE_HOME).toBe(cache);
    expect(env.HOME).toBe(home);
    expect(env.HOME).not.toBe(cache);
    expect(existsSync(cache)).toBe(true);
    rmSync(fh, { recursive: true, force: true });
  });

  it("isolates HOME, git and gh config", () => {
    const env = buildAgentEnv(parent, { home });
    expect(env.HOME).toBe(home);
    expect(env.HOME).not.toBe("/home/real");
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(home, ".gitconfig"));
    expect(env.GH_CONFIG_DIR).toBe(join(home, ".config", "gh"));
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("");
    expect(existsSync(join(home, ".config", "gh"))).toBe(true);
  });

  it("passes explicitly configured names but never gh/git credentials", () => {
    const env = buildAgentEnv(parent, { home, extra: ["DATABASE_URL", "GH_TOKEN"], set: { PORT: "3000" } });
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.PORT).toBe("3000");
    expect(env).not.toHaveProperty("GH_TOKEN");
  });

  it("never passes the factory's own provider credentials, even when a repo asks for them", () => {
    const withKeys = { ...parent, OPENCODE_API_KEY: "k-opencode", OPENAI_API_KEY: "k-openai", FACTORY_HOME: "/f" };
    const env = buildAgentEnv(withKeys, { home, extra: ["OPENCODE_API_KEY", "OPENAI_API_KEY", "FACTORY_HOME"] });
    expect(env).not.toHaveProperty("OPENCODE_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("FACTORY_HOME");
  });
});
