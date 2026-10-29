import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRunner } from "../../src/agents/pi-runner.js";
import { isZenEndpoint, piProviderView, type ProviderView } from "../../src/agents/provider-guard.js";
import { doctorCommand, type DoctorReport } from "../../src/commands/doctor.js";
import { FakeGitHub } from "../../src/gh.js";
import { createFixtureRepo } from "../helpers/repo.js";

const probe = { platform: "linux" as const, bwrap: () => true, pasta: () => true };

/** Everything logged in and resolving to the subscription endpoints. */
function fakeView(over: Partial<ProviderView> = {}): ProviderView & { pinged: string[] } {
  const pinged: string[] = [];
  return {
    pinged,
    resolve: (m) => ({ baseUrl: m.startsWith("openai/") ? "https://api.openai.com/v1" : m.startsWith("opencode-go/") ? "https://opencode.ai/inference/go/v1" : "https://opencode.ai/inference", api: "x" }),
    auth: (p) => ({ configured: true, subscription: p === "openai", source: p === "openai" ? "stored, oauth" : "stored" }),
    modelsJsonBaseUrls: () => [],
    ping: async (m) => void pinged.push(m),
    ...over,
  };
}
const view = fakeView();

/** A factory home whose Pi agent dir has the given auth.json / models.json (fake credentials). */
function piHome(files: { auth?: unknown; models?: unknown }): string {
  const home = mkdtempSync(join(tmpdir(), "fh-"));
  mkdirSync(join(home, "pi"));
  if (files.auth) writeFileSync(join(home, "pi", "auth.json"), JSON.stringify(files.auth));
  if (files.models) writeFileSync(join(home, "pi", "models.json"), JSON.stringify(files.models));
  return home;
}
const SUBSCRIPTIONS = {
  openai: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 9_999_999_999_999 },
  "opencode-go": { type: "api_key", key: "fake-go-key" },
};
const check = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name);

const capture = () => {
  let out = "";
  return { io: { out: (s: string) => void (out += s), err: (s: string) => void (out += s) }, text: () => out };
};

describe("factory doctor: model layers", () => {
  it("prints the effective model per role and its layer", async () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(home, "profile.yaml"), "roles:\n  pr_writer: [{ model: opencode-go/grok-4.7 }]\n");
    const c = capture();
    expect(await doctorCommand({ factoryHome: home, json: false, probe, view }, c.io)).toBe(0);
    expect(c.text()).toMatch(/pr_writer\s+opencode-go\/grok-4.7\s+← user/);
    expect(c.text()).toMatch(/implement\s+opencode-go\/deepseek-v4.1-flash \(high\) → opencode-go\/mimo-v2.6-flash \[capacity-only\]\s+← built-in/);
  });

  it("includes the repo layer with --repo and fails on a broken merge (JSON)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    const repo = createFixtureRepo((c) => void (c.models = { evaluate: [{ model: "opencode-go/grok-4.7" }] }));
    const c = capture();
    expect(await doctorCommand({ factoryHome: home, repo, json: true, probe, view, github: new FakeGitHub() }, c.io)).toBe(0);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(r.models.find((m) => m.role === "evaluate")).toMatchObject({ layer: "repo", models: ["opencode-go/grok-4.7"] });

    const bad = createFixtureRepo((c) => void (c.models = { implement: [{ model: "openai/gpt-6-luna" }] }));
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: home, repo: bad, json: true, probe, view, github: new FakeGitHub() }, c2.io)).toBe(1);
    expect((JSON.parse(c2.text()) as DoctorReport).checks[0]).toMatchObject({ status: "fail" });
  });

  it("reports the sandbox: required but unavailable fails, preferred degraded warns", async () => {
    const strict = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(strict, "profile.yaml"), "sandbox: required\n");
    const c = capture();
    expect(await doctorCommand({ factoryHome: strict, json: true, probe: { ...probe, pasta: () => false }, view }, c.io)).toBe(1);
    expect((JSON.parse(c.text()) as DoctorReport).checks.find((x) => x.name === "sandbox")).toMatchObject({ status: "fail", detail: expect.stringMatching(/pasta/) });
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe: { ...probe, pasta: () => false }, view }, c2.io)).toBe(0);
    expect((JSON.parse(c2.text()) as DoctorReport).checks.find((x) => x.name === "sandbox")).toMatchObject({ status: "warn", detail: expect.stringMatching(/network shared/) });
  });
});

describe("factory doctor: Zen guard (real Pi registry, offline, fake credentials)", () => {
  const env = { ...process.env };
  const run = async (home: string, extra: Record<string, unknown> = {}) => {
    const c = capture();
    const code = await doctorCommand({ factoryHome: home, json: true, probe, ...extra }, c.io);
    return { code, r: JSON.parse(c.text()) as DoctorReport, text: c.text() };
  };

  it("default models on ChatGPT login + OpenCode Go: guard ok, Extra Usage warning, no secret in the output", async () => {
    const { code, r, text } = await run(piHome({ auth: SUBSCRIPTIONS }));
    expect(code).toBe(0);
    expect(check(r, "zen guard")).toMatchObject({ status: "ok" });
    expect(check(r, "openai login")).toMatchObject({ status: "ok", detail: "ChatGPT login (subscription)" });
    expect(check(r, "opencode-go auth")).toMatchObject({ status: "ok" });
    expect(check(r, "extra usage")).toMatchObject({ status: "warn", detail: expect.stringMatching(/Extra Usage/) });
    expect(r.providers_in_use).toEqual(["openai", "opencode-go"]);
    expect(text).not.toMatch(/fake-(access|refresh|go-key)/);
  });

  it("a models.json baseUrl override onto Zen fails, naming the model and the file entry", async () => {
    const home = piHome({ auth: SUBSCRIPTIONS, models: { providers: { "opencode-go": { baseUrl: "https://opencode.ai/inference/v1" } } } });
    const { code, r } = await run(home);
    expect(code).toBe(1);
    const d = check(r, "zen guard")!;
    expect(d.status).toBe("fail");
    expect(d.detail).toMatch(/opencode-go\/deepseek-v4.1-flash resolves to the pay-per-use OpenCode Zen endpoint/);
    expect(d.detail).toMatch(/models\.json\.providers\.opencode-go\.baseUrl points at the Zen endpoint/);
  });

  it("OpenAI on an API key (stored or env) fails: only the ChatGPT login is allowed", async () => {
    const { code, r, text } = await run(piHome({ auth: { ...SUBSCRIPTIONS, openai: { type: "api_key", key: "fake-openai-key" } } }));
    expect(code).toBe(1);
    expect(check(r, "openai login")).toMatchObject({ status: "fail", detail: expect.stringMatching(/not the ChatGPT login/) });
    expect(text).not.toContain("fake-openai-key");
    process.env.OPENAI_API_KEY = "fake-env-key";
    try {
      const viaEnv = await run(piHome({ auth: { "opencode-go": SUBSCRIPTIONS["opencode-go"] } }));
      expect(check(viaEnv.r, "openai login")).toMatchObject({ status: "fail", detail: expect.stringMatching(/environment.*not the ChatGPT login/) });
    } finally {
      if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
  });

  it("missing provider credentials fail", async () => {
    const saved = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const { r } = await run(piHome({ auth: { openai: SUBSCRIPTIONS.openai } }));
      expect(check(r, "opencode-go auth")).toMatchObject({ status: "fail" });
    } finally {
      if (saved !== undefined) process.env.OPENCODE_API_KEY = saved;
    }
  });

  it("the runtime refuses the same configurations before any request (PiRunner)", async () => {
    const base = { role: "implement", cwd: tmpdir(), system: "s", prompt: "p", tools: "none" as const, env: {} };
    const zen = piHome({ auth: SUBSCRIPTIONS, models: { providers: { "opencode-go": { baseUrl: "https://opencode.ai/inference/v1" } } } });
    await expect(new PiRunner(join(zen, "pi")).run({ ...base, model: "opencode-go/deepseek-v4.1-flash" })).rejects.toThrow(/refused: .*Zen endpoint/);
    const key = piHome({ auth: { openai: { type: "api_key", key: "fake-openai-key" } } });
    await expect(new PiRunner(join(key, "pi")).run({ ...base, model: "openai/gpt-6-luna" })).rejects.toThrow(/refused: .*ChatGPT login/);
  });

  it("piProviderView reads models.json base URLs anywhere in the file", async () => {
    const home = piHome({ models: { providers: { x: { models: [{ id: "m", baseUrl: "https://zen.opencode.ai/v1" }] } } } });
    const v = await piProviderView(join(home, "pi"));
    expect(v.modelsJsonBaseUrls()).toEqual([{ path: "models.json.providers.x.models[0].baseUrl", baseUrl: "https://zen.opencode.ai/v1" }]);
  });
});

describe("factory doctor: Zen guard rules", () => {
  it("isZenEndpoint: OpenCode hosts outside /go are Zen", () => {
    expect(isZenEndpoint("https://opencode.ai/inference/v1")).toBe(true);
    expect(isZenEndpoint("https://opencode.ai/inference")).toBe(true);
    expect(isZenEndpoint("https://api.opencode.ai/zen/v1")).toBe(true);
    expect(isZenEndpoint("https://opencode.ai/inference/go/v1")).toBe(false);
    expect(isZenEndpoint("https://opencode.ai/inference/go")).toBe(false);
    expect(isZenEndpoint("https://opencode.ai/inference/gopher/v1")).toBe(true);
    expect(isZenEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isZenEndpoint("https://notopencode.ai/v1")).toBe(false);
    expect(isZenEndpoint("https://opencode.ai./inference/v1")).toBe(true);
    expect(isZenEndpoint("https://opencode.ai/inference/v1/go")).toBe(true);
    expect(isZenEndpoint("https://opencode.ai/inference/go/../v1")).toBe(true);
    expect(isZenEndpoint("https://opencode.ai/zen/go/v1")).toBe(false);
    expect(isZenEndpoint("not a url")).toBe(false);
  });

  it("opencode/* only when providers.allow names opencode explicitly, then as a warning", async () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(home, "profile.yaml"), "providers: { allow: [opencode-go, openai, opencode], deny: [] }\nroles:\n  pr_writer: [{ model: opencode/kimi-k3 }]\n");
    const c = capture();
    expect(await doctorCommand({ factoryHome: home, json: true, probe, view }, c.io)).toBe(0);
    expect(check(JSON.parse(c.text()) as DoctorReport, "zen guard")).toMatchObject({ status: "warn", detail: expect.stringMatching(/opencode\/kimi-k3/) });

    const star = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(star, "profile.yaml"), "providers: { allow: ['*'], deny: [] }\nroles:\n  pr_writer: [{ model: opencode/kimi-k3 }]\n");
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: star, json: true, probe, view }, c2.io)).toBe(1);
    // Rejected already when the profile is loaded (same rule as the runtime), so no run can start.
    const r2 = JSON.parse(c2.text()) as DoctorReport;
    expect(r2.checks.find((x) => x.status === "fail")).toMatchObject({ detail: expect.stringMatching(/OpenCode Zen/) });
  });

  it("an opencode-go model off the /go/ path fails; an unknown model fails", async () => {
    const c = capture();
    const bad = fakeView({ resolve: (m) => (m.includes("mimo") ? undefined : { baseUrl: m.startsWith("opencode-go/") ? "https://proxy.example/v1" : "https://api.openai.com/v1", api: "x" }) });
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe, view: bad }, c.io)).toBe(1);
    const d = check(JSON.parse(c.text()) as DoctorReport, "zen guard")!.detail;
    expect(d).toMatch(/deepseek-v4.1-flash resolves to https:\/\/proxy.example\/v1, not the OpenCode Go \/go\/ endpoint/);
    expect(d).toMatch(/mimo-v2.6-flash is unknown to Pi/);
  });

  it("--ping: one request per configured model; failures warn; skipped while the guard fails", async () => {
    const v = fakeView({ ping: async (m) => { if (m === "openai/gpt-6-luna") throw new Error("429 usage limit"); } });
    const c = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe, view: v, ping: true }, c.io)).toBe(0);
    expect(check(JSON.parse(c.text()) as DoctorReport, "live ping")).toMatchObject({ status: "warn", detail: expect.stringMatching(/^3\/4 answered; openai\/gpt-6-luna: 429 usage limit$/) });

    const ok = fakeView();
    const c1 = capture();
    await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe, view: ok, ping: true }, c1.io);
    expect(ok.pinged.sort()).toEqual(["openai/gpt-6-luna", "openai/gpt-6.1-sol", "opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.6-flash"]);
    expect(check(JSON.parse(c1.text()) as DoctorReport, "live ping")).toMatchObject({ status: "ok" });

    const guarded = fakeView({ modelsJsonBaseUrls: () => [{ path: "models.json.providers.opencode-go.baseUrl", baseUrl: "https://opencode.ai/inference/v1" }] });
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe, view: guarded, ping: true }, c2.io)).toBe(1);
    expect(guarded.pinged).toEqual([]);
    expect(check(JSON.parse(c2.text()) as DoctorReport, "live ping")).toMatchObject({ status: "warn", detail: expect.stringMatching(/skipped/) });
  });

  it("a ping that hangs is cut off by the timeout", async () => {
    const v = fakeView({ ping: (_m, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
    const c = capture();
    await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe, view: v, ping: true, pingTimeoutMs: 20 }, c.io);
    expect(check(JSON.parse(c.text()) as DoctorReport, "live ping")!.detail).toMatch(/no answer within 0.02s/);
  });
});

describe("factory doctor: GitHub hints (no admin token, no GitHub Pro needed)", () => {
  it("a repo without repo.yaml: the model table still shows, the repo check names the missing file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "norepo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const c = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo, json: true, probe, view, github: new FakeGitHub() }, c.io)).toBe(1);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(check(r, "model config")).toMatchObject({ status: "ok" });
    expect(r.models.length).toBeGreaterThan(0);
    expect(check(r, "repo.yaml")).toMatchObject({ status: "fail", detail: expect.stringMatching(/missing/) });
  });

  it("fails on credentials embedded in a remote URL without printing them", async () => {
    const repo = createFixtureRepo();
    execFileSync("git", ["remote", "add", "origin", "https://x-access-token:s3cr3t-value@github.com/o/r.git"], { cwd: repo });
    execFileSync("git", ["remote", "add", "mirror", "git@github.com:o/r.git"], { cwd: repo });
    const c = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo, json: true, probe, view, github: new FakeGitHub() }, c.io)).toBe(1);
    expect(check(JSON.parse(c.text()) as DoctorReport, "git remotes")).toMatchObject({ status: "fail", detail: expect.stringMatching(/remote origin;/) });
    expect(c.text()).not.toContain("s3cr3t-value");
  });

  it("gh not logged in fails", async () => {
    const gh = new FakeGitHub();
    gh.authOk = false;
    const c = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo: createFixtureRepo(), json: true, probe, view, github: gh }, c.io)).toBe(1);
    expect(check(JSON.parse(c.text()) as DoctorReport, "gh")).toMatchObject({ status: "fail" });
  });

  it("unprotected private branch and auto-merge off are hints only (exit 0)", async () => {
    const gh = new FakeGitHub();
    const repo = createFixtureRepo((c) => void (c.merge = { auto_merge_max_risk: "low" }));
    const c = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo, json: true, probe, view, github: gh }, c.io)).toBe(0);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(check(r, "auto-merge")).toMatchObject({ status: "info", detail: expect.stringMatching(/Allow auto-merge/) });
    expect(check(r, "branch protection")).toMatchObject({ status: "info", detail: expect.stringMatching(/GitHub Pro/) });

    gh.settings = { private: false, auto_merge_allowed: true, branch_protected: true, required_checks: ["factory / done"] };
    const c2 = capture();
    await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo, json: true, probe, view, github: gh }, c2.io);
    const r2 = JSON.parse(c2.text()) as DoctorReport;
    expect(r2.checks.filter((x) => x.status === "info")).toEqual([]);

    gh.settings = { private: null, auto_merge_allowed: null, branch_protected: null, required_checks: null, error: "HTTP 404" };
    const c3 = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo, json: true, probe, view, github: gh }, c3.io)).toBe(0);
    expect(check(JSON.parse(c3.text()) as DoctorReport, "github settings")).toMatchObject({ status: "info" });
  });
});

describe("factory doctor: services and ui (§15)", () => {
  const SERVE = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(Number(process.argv[1]),'0.0.0.0')"`;
  const services = (c: Record<string, unknown>) => {
    c.services = [
      { name: "web", start: `${SERVE} {port:web}` },
      { name: "db", start: "exit 3", host: true },
      { name: "spare", start: "sleep 60" },
    ];
    c.ui = { start: `${SERVE} {port:ui}`, url: "http://127.0.0.1:{port:ui}/", services: ["web"] };
    c.checks = [...((c.checks as unknown[]) ?? []), { name: "uses-db", run: "true", tier: "manual", services: ["db"] }];
  };

  it("static: host services warn, unused ones are noted; nothing starts without --services", async () => {
    const c = capture();
    await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo: createFixtureRepo(services), json: true, probe, view, github: new FakeGitHub() }, c.io);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(r.checks.filter((x) => x.name.startsWith("service "))).toEqual([
      { name: "service db", status: "warn", detail: expect.stringMatching(/outside the sandbox/) },
      { name: "service spare", status: "info", detail: expect.stringMatching(/never starts/) },
    ]);
    expect(check(r, "services")).toMatchObject({ status: "info", detail: expect.stringMatching(/--services/) });
  });

  it.runIf(process.platform === "linux")("--services: each service and the ui start and stop once in a clean base worktree (sandboxed)", async () => {
    const repo = createFixtureRepo(services);
    writeFileSync(join(repo, "UNCOMMITTED.txt"), "local only");
    const c = capture();
    const fh = mkdtempSync(join(tmpdir(), "fh-"));
    expect(await doctorCommand({ factoryHome: fh, repo, services: true, json: true, probe, view, github: new FakeGitHub() }, c.io)).toBe(1);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(check(r, "service web")).toMatchObject({ status: "ok", detail: expect.stringMatching(/started in .*s and stopped/) });
    expect(r.checks.find((x) => x.name === "service db" && x.status === "fail")?.detail).toMatch(/env_missing: service db/);
    expect(check(r, "ui")).toMatchObject({ status: "ok", detail: expect.stringMatching(/reachable at http:\/\/127\.0\.0\.1:\d+\//) });
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(execFileSync("ls", [join(fh, "ports")], { encoding: "utf8" }).trim()).toBe(""); // slot released
  }, 60_000);
});
