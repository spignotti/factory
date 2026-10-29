import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detect } from "../../src/adopt/detect.js";
import { draftRepoYaml } from "../../src/adopt/draft.js";
import { secretsChecks } from "../../src/commands/doctor.js";
import { EventLog } from "../../src/events.js";
import { agentEnv, commandEnv } from "../../src/pipeline/context.js";
import { parseRepoConfig, type RepoConfig } from "../../src/schemas/repo.js";
import { jailedArgv } from "../../src/sandbox/sandbox.js";
import { parseDotenv, redactTree, resolveSecrets, SecretsError, wrapperEnv } from "../../src/secrets.js";
import { loadProfile } from "../../src/schemas/profile.js";
import { FIXTURES } from "../helpers/repo.js";
import { gitIn } from "../helpers/repo.js";
import { makeRepo } from "../helpers/adopt-repo.js";

const DB = "db-password-value-91c4e7";
const CRED = "wrapper-client-secret-5b8d02";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "factory-secrets-"));
}

function secretFile(dir: string, name: string, text: string, mode = 0o600): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
}

/** A generic wrapper: refuses without its credential, injects DB_PASSWORD, then runs the command. */
function fakeWrapper(dir: string): string {
  const f = join(dir, "wrap.sh");
  writeFileSync(
    f,
    [
      "#!/bin/sh",
      `[ "$WRAP_CLIENT_SECRET" = "${CRED}" ] || { echo "auth failed" >&2; exit 3; }`,
      '[ -z "$GH_TOKEN" ] || { echo "wrapper got GH_TOKEN" >&2; exit 4; }',
      'echo "injecting 1 secret"',
      `export DB_PASSWORD="${DB}"`,
      'exec "$@"',
      "",
    ].join("\n"),
  );
  return f;
}

describe("dotenv", () => {
  it("parses export, quotes, comments and blank lines", () => {
    expect(parseDotenv("# c\n\nexport A=1\nB='two words'\nC=\"x\\ny\"\nD=plain # note\nnot a line\n")).toEqual({ A: "1", B: "two words", C: "x\ny", D: "plain" });
  });
});

describe("resolveSecrets", () => {
  it("env_file: default path per repo, only the configured names, redaction list", async () => {
    const home = tmp();
    const repoDir = join(tmp(), "shop");
    mkdirSync(repoDir);
    secretFile(join(home, "secrets"), "shop.env", `DB_PASSWORD=${DB}\nUNLISTED=zzzzzzzzzz\nSHORT=abc\n`);
    const r = await resolveSecrets({ provider: "env_file", names: ["DB_PASSWORD", "SHORT", "MISSING"] }, { repoDir, factoryHome: home });
    expect(r.env).toEqual({ DB_PASSWORD: DB, SHORT: "abc" });
    expect(r.missing).toEqual(["MISSING"]);
    expect(r.redact).toEqual([DB]);
    expect(r.short).toEqual(["SHORT"]);
    expect(r.files).toEqual([join(home, "secrets", "shop.env")]);
  });

  it("env_file: refuses a file inside the repo or readable by others, without printing values", async () => {
    const repoDir = tmp();
    const inside = secretFile(repoDir, ".env", `DB_PASSWORD=${DB}\n`);
    await expect(resolveSecrets({ provider: "env_file", path: inside, names: ["DB_PASSWORD"] }, { repoDir, factoryHome: tmp() })).rejects.toThrow(/inside the repo/);
    const loose = secretFile(tmp(), "x.env", `DB_PASSWORD=${DB}\n`, 0o644);
    const err = await resolveSecrets({ provider: "env_file", path: loose, names: ["DB_PASSWORD"] }, { repoDir, factoryHome: tmp() }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as Error).message).toContain("chmod 600");
    expect((err as Error).message).not.toContain(DB);
  });

  it("command: credentials reach only the wrapper; the agent-facing env and the result never hold them", async () => {
    const dir = tmp();
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    const wrap = fakeWrapper(dir);
    const creds = secretFile(join(dir, "secrets"), "repo.env", `WRAP_CLIENT_SECRET=${CRED}\n`);
    const cfg = { provider: "command" as const, command: `sh ${wrap}`, credentials: creds, names: ["DB_PASSWORD"] };
    const r = await resolveSecrets(cfg, { repoDir, factoryHome: dir, parentEnv: { ...process.env, GH_TOKEN: "gh-token-should-not-pass" } });
    expect(r.env).toEqual({ DB_PASSWORD: DB });
    expect(r.missing).toEqual([]);
    expect(r.redact).toEqual(expect.arrayContaining([DB, CRED]));
    expect(r.names).toEqual(["DB_PASSWORD", "WRAP_CLIENT_SECRET"]);
    expect(wrapperEnv({ PATH: "/bin", GH_TOKEN: "x", HOME: "/h" }, { A: "b" })).toEqual({ PATH: "/bin", HOME: "/h", A: "b" });
  });

  it("command: a failing wrapper reports its exit and stderr tail, never stdout or credentials", async () => {
    const dir = tmp();
    const wrap = join(dir, "bad.sh");
    writeFileSync(wrap, `#!/bin/sh\necho "DB_PASSWORD=${DB}"\necho "denied for $WRAP_CLIENT_SECRET" >&2\nexit 2\n`);
    const creds = secretFile(join(dir, "s"), "c.env", `WRAP_CLIENT_SECRET=${CRED}\n`);
    const err = (await resolveSecrets({ provider: "command", command: `sh ${wrap}`, credentials: creds, names: ["DB_PASSWORD"] }, { repoDir: tmp(), factoryHome: dir }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("exited 2");
    expect(err.message).toContain("denied for [redacted]");
    expect(err.message).not.toContain(DB);
    expect(err.message).not.toContain(CRED);
  });

  it("command: names may not list the wrapper's credentials", async () => {
    const dir = tmp();
    const creds = secretFile(join(dir, "s"), "c.env", `WRAP_CLIENT_SECRET=${CRED}\n`);
    await expect(resolveSecrets({ provider: "command", command: "true", credentials: creds, names: ["WRAP_CLIENT_SECRET"] }, { repoDir: tmp(), factoryHome: dir })).rejects.toThrow(/wrapper credentials/);
  });

  it("schema: provider shape, reserved names", () => {
    expect(() => parseRepoConfig("secrets: { provider: env_file, names: [PATH] }")).toThrow(/may not include/);
    expect(() => parseRepoConfig("secrets: { provider: command, names: [A] }")).toThrow();
    expect(() => parseRepoConfig("secrets: { provider: vault, names: [A] }")).toThrow();
    expect(parseRepoConfig('secrets: { provider: command, command: "x run --", credentials: ~/c.env, names: [A] }').secrets).toMatchObject({ provider: "command" });
  });
});

describe("secrets never reach agents", () => {
  const profile = loadProfile(join(FIXTURES, "profile.yaml"));
  const repo = parseRepoConfig("agent_env: [DB_PASSWORD, WRAP_CLIENT_SECRET, OTHER]\nsecrets: { provider: env_file, names: [DB_PASSWORD] }") as RepoConfig;
  const secrets = { env: { DB_PASSWORD: DB }, missing: [], redact: [DB, CRED], short: [], files: [], names: ["DB_PASSWORD", "WRAP_CLIENT_SECRET"] };
  const ctx = { deps: { profile, parentEnv: { PATH: "/bin", DB_PASSWORD: DB, WRAP_CLIENT_SECRET: CRED, OTHER: "ok" }, factoryHome: "/f" } as never, repo, agentHome: "/h", secrets };

  it("agentEnv drops secret and credential names even when agent_env lists them; commandEnv adds the secrets", () => {
    const a = agentEnv(ctx, "implement");
    expect(a.DB_PASSWORD).toBeUndefined();
    expect(a.WRAP_CLIENT_SECRET).toBeUndefined();
    expect(a.OTHER).toBe("ok");
    const c = commandEnv(ctx);
    expect(c.DB_PASSWORD).toBe(DB);
    expect(c.WRAP_CLIENT_SECRET).toBeUndefined();
  });

  it("a sandboxed check gets the values through the process env only, never on the bwrap/pasta argv; the secret file is hidden", () => {
    const wt = tmp();
    const env = commandEnv(ctx);
    const jail = { sandbox: { mode: "required" as const, fs: "bwrap" as const, net: "isolated" as const, warnings: [] }, rw: [wt], ro: [], hide: ["/f", "/home/u/.factory/secrets/app.env"] };
    const argv = jailedArgv(jail, "sh", "make test", wt, env);
    expect(argv.join(" ")).not.toContain(DB);
    expect(argv.join(" ")).not.toContain("app.env");
  });

  it("the event log redacts added secrets; redactTree rewrites child-written logs", () => {
    const dir = tmp();
    const log = new EventLog(dir, "r1");
    log.addSecrets([DB, CRED]);
    log.emit({ step: "gates", event: "progress", data: { out: `pw ${DB} and ${CRED}` } });
    const text = readFileSync(log.path, "utf8");
    expect(text).not.toContain(DB);
    expect(text).not.toContain(CRED);
    mkdirSync(join(dir, "services"));
    mkdirSync(join(dir, "worktree"));
    writeFileSync(join(dir, "services", "db.log"), `started with ${DB}\n`);
    writeFileSync(join(dir, "worktree", "x.txt"), DB);
    redactTree(dir, (t) => log.redact(t), ["worktree"]);
    expect(readFileSync(join(dir, "services", "db.log"), "utf8")).toBe("started with [redacted]\n");
    expect(readFileSync(join(dir, "worktree", "x.txt"), "utf8")).toBe(DB);
  });
});

describe("doctor secrets", () => {
  it("reports file, mode and resolved names, never a value", async () => {
    const home = tmp();
    const repoDir = join(tmp(), "app");
    mkdirSync(repoDir);
    const repo = parseRepoConfig("secrets: { provider: env_file, names: [DB_PASSWORD, API_URL] }");
    let r = await secretsChecks(repoDir, repo, home);
    expect(r.checks[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("missing") });
    const f = secretFile(join(home, "secrets"), "app.env", `DB_PASSWORD=${DB}\n`, 0o644);
    r = await secretsChecks(repoDir, repo, home);
    expect(r.checks[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("chmod 600") });
    chmodSync(f, 0o600);
    r = await secretsChecks(repoDir, repo, home);
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "fail"]);
    expect(r.checks[1]!.detail).toContain("1/2 names");
    expect(r.checks[1]!.detail).toContain("API_URL");
    writeFileSync(f, `DB_PASSWORD=${DB}\nAPI_URL=http://localhost:1234\n`);
    r = await secretsChecks(repoDir, repo, home);
    expect(r.checks.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(r.resolved?.env.DB_PASSWORD).toBe(DB);
    expect(JSON.stringify(r.checks)).not.toContain(DB);
  });

  it("command provider: credentials file 0600 and the wrapper resolves the names", async () => {
    const dir = tmp();
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    const wrap = fakeWrapper(dir);
    const creds = secretFile(join(dir, "secrets"), "repo.env", `WRAP_CLIENT_SECRET=${CRED}\n`);
    const repo = parseRepoConfig(`secrets: { provider: command, command: "sh ${wrap}", credentials: ${creds}, names: [DB_PASSWORD] }`);
    const r = await secretsChecks(repoDir, repo, dir);
    expect(r.checks.map((c) => [c.name, c.status])).toEqual([["secrets credentials", "ok"], ["secrets", "ok"]]);
    writeFileSync(creds, "WRAP_CLIENT_SECRET=wrong-value-000\n");
    const bad = await secretsChecks(repoDir, repo, dir);
    expect(bad.checks[1]).toMatchObject({ status: "fail", detail: expect.stringContaining("exited 3") });
    expect(JSON.stringify([...r.checks, ...bad.checks])).not.toMatch(new RegExp(`${DB}|${CRED}`));
  });
});

describe("adopt drafts a secrets block (names only)", () => {
  const files = (dir: string) => gitIn(dir, "ls-files").split("\n").filter(Boolean);
  const env = "# copy to .env\nDATABASE_URL=postgres://user:pass@localhost/db\nexport STRIPE_KEY=sk_test_placeholder\nPATH=/nope\n";

  it(".infisical.json → command provider with a per-repo credentials file", () => {
    const dir = makeRepo({ ".env.example": env, ".infisical.json": '{"workspaceId":"x"}', "package.json": "{}" });
    const d = detect(dir, files(dir));
    expect(d.secrets).toEqual({ names: ["DATABASE_URL", "STRIPE_KEY", "PATH"], sources: [".env.example"], infisical: true });
    const { text, config } = draftRepoYaml({ detection: d, checks: [], baseBranch: "main", date: "2026-10-29", repoName: "shop" });
    expect(config.secrets).toEqual({ provider: "command", command: "infisical run --env=dev --", credentials: "~/.factory/secrets/shop.env", names: ["DATABASE_URL", "STRIPE_KEY"] });
    expect(text).toContain("# secrets: names from .env.example; .infisical.json found");
    expect(text).not.toContain("sk_test_placeholder");
    expect(text).not.toContain("user:pass");
  });

  it("env template only → env_file provider; none → no block", () => {
    const dir = makeRepo({ ".env.example": env, "package.json": "{}" });
    const { config } = draftRepoYaml({ detection: detect(dir, files(dir)), checks: [], baseBranch: "main", date: "2026-10-29", repoName: "shop" });
    expect(config.secrets).toEqual({ provider: "env_file", names: ["DATABASE_URL", "STRIPE_KEY"] });
    const bare = makeRepo({ "package.json": "{}" });
    expect(draftRepoYaml({ detection: detect(bare, files(bare)), checks: [], baseBranch: "main", date: "2026-10-29" }).config.secrets).toBeUndefined();
  });
});
