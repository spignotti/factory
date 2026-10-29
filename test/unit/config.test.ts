import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeProfile, type Layer, loadLayers, parseLayer, resolveProfile, withRepoModels } from "../../src/config.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const home = (profile?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "fh-"));
  if (profile !== undefined) writeFileSync(join(dir, "profile.yaml"), profile);
  return dir;
};

const SILAS = `
providers: { allow: [opencode-go, openai], deny: [opencode] }
`;

describe("layered model config (Amendment i)", () => {
  it("built-in defaults alone resolve, every role from the built-in layer", () => {
    const p = resolveProfile(loadLayers({ factoryHome: home() }));
    expect(p.roles.implement[0]!.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(new Set(Object.values(p.sources!))).toEqual(new Set(["built-in"]));
    expect(p.providers).toEqual({ allow: ["*"], deny: ["opencode"] });
  });

  it("most specific wins: built-in < user < --profile < repo, per role", () => {
    const dir = home(`roles:\n  pr_writer: [{ model: opencode-go/grok-4.7 }]\n  evaluate: [{ model: openai/gpt-6.1-sol }]\n`);
    const cli = join(dir, "variant.yaml");
    writeFileSync(cli, `roles:\n  evaluate: [{ model: openai/gpt-6-luna, thinking: high }]\nretry: { attempts: 2 }\n`);
    const base = resolveProfile(loadLayers({ factoryHome: dir, profile: cli }));
    const repo = parseRepoConfig(`models:\n  implement: [{ model: opencode-go/mimo-v2.6-flash }]\n`);
    const p = withRepoModels(base, repo.models);
    expect(p.roles.pr_writer[0]!.model).toBe("opencode-go/grok-4.7");
    expect(p.roles.evaluate[0]).toEqual({ model: "openai/gpt-6-luna", thinking: "high" });
    expect(p.roles.implement).toEqual([{ model: "opencode-go/mimo-v2.6-flash" }]);
    expect(p.retry).toEqual({ base_ms: 2000, max_ms: 60_000, attempts: 2 });
    const layerOf = Object.fromEntries(describeProfile(p).map((d) => [d.role, d.layer]));
    expect(layerOf).toMatchObject({ pr_writer: "user", evaluate: "cli", implement: "repo", plan_high: "built-in" });
  });

  it("the user profile pins providers; a repo cannot widen them", () => {
    const base = resolveProfile(loadLayers({ factoryHome: home(SILAS) }));
    expect(() => withRepoModels(base, parseRepoConfig(`models:\n  pr_writer: [{ model: anthropic/claude-x }]\n`).models)).toThrow(
      /provider "anthropic" is not allowed.*pr_writer from repo layer/,
    );
    expect(() => parseRepoConfig(`models:\n  providers: { allow: ["*"] }\n`)).toThrow();
  });

  it("only built-in and user layers may set providers and the sandbox", () => {
    expect(() => parseLayer("cli", "x.yaml", `providers: { deny: [] }`)).toThrow(ConfigError);
    expect(() => parseLayer("cli", "x.yaml", `sandbox: off`)).toThrow(/sandbox can only be set/);
    expect(() => parseRepoConfig(`models:\n  sandbox: off\n`)).toThrow();
    expect(resolveProfile(loadLayers({ factoryHome: home("sandbox: required\n") })).sandbox).toBe("required");
    expect(resolveProfile(loadLayers({ factoryHome: home() })).sandbox).toBe("preferred");
    expect(() => parseLayer("user", "p.yaml", `providers: { deny: [] }`)).not.toThrow();
  });

  it("denies Zen by default and with a pointed message", () => {
    expect(() => resolveProfile(loadLayers({ factoryHome: home(`roles:\n  pr_writer: [{ model: opencode/deepseek-v4.1-flash }]\n`) }))).toThrow(
      /OpenCode Zen \(pay-per-use\)/,
    );
  });

  it("a user may opt into other providers explicitly", () => {
    const p = resolveProfile(loadLayers({ factoryHome: home(`roles:\n  pr_writer: [{ model: anthropic/claude-x }]\n`) }));
    expect(p.roles.pr_writer[0]!.model).toBe("anthropic/claude-x");
  });

  it("safety rules apply after the merge: reviewer family vs a repo's implement override", () => {
    const base = resolveProfile(loadLayers({ factoryHome: home() }));
    // The repo moves implement to the reviewers' family (gpt) → rejected, citing the layers.
    expect(() => withRepoModels(base, { implement: [{ model: "openai/gpt-6-luna" }] })).toThrow(/reviewers must differ.*built-in layer/);
    expect(() => withRepoModels(base, { review_plan: [{ model: "opencode-go/deepseek-v4-pro" }] })).toThrow(/review_plan from repo layer/);
  });

  it("safety rules apply after the merge: cross-family implement backup needs capacity_only", () => {
    const base = resolveProfile(loadLayers({ factoryHome: home() }));
    expect(() =>
      withRepoModels(base, { implement: [{ model: "opencode-go/deepseek-v4.1-flash" }, { model: "opencode-go/grok-4.7" }] }),
    ).toThrow(/capacity_only/);
  });

  it("rejects unknown roles and keys in a layer", () => {
    expect(() => parseLayer("user", "p.yaml", `roles:\n  review: [{ model: openai/x }]\n`)).toThrow(/review/);
    expect(() => parseLayer("user", "p.yaml", `modles: {}\n`)).toThrow(ConfigError);
  });

  it("describeProfile lists every role with its models and layer", () => {
    const layers: Layer[] = loadLayers({ factoryHome: home() });
    const d = describeProfile(resolveProfile(layers));
    expect(d.find((x) => x.role === "implement")).toEqual({
      role: "implement",
      models: ["opencode-go/deepseek-v4.1-flash (high)", "opencode-go/mimo-v2.6-flash [capacity-only]"],
      layer: "built-in",
    });
  });
});
