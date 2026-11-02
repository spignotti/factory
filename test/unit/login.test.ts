import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/events.js";
import { EvalBrowser, findHeadlessShell } from "../../src/evaluate/browser.js";
import { AuthLoginError, establishLogin, performLogin, resolveAuthCredentials, valuesToRedact } from "../../src/evaluate/login.js";
import { writeJson } from "../../src/pipeline/context.js";
import type { UiAuth } from "../../src/schemas/repo.js";
import { createSandbox, hostProbe, type Jail } from "../../src/sandbox/sandbox.js";

const USER = "ada@example.com";
const PASSWORD = "correct-horse-battery";
const WRONG = "wrong-password-value";

function loginPage(err: string): string {
  return `<!doctype html><html><body>
<form id="f" method="post" action="/login">
<input id="user" name="user">
<input id="password" name="password" type="password">
<button id="submit" type="submit">Sign in</button>
</form>
<p id="err">${err}</p>
</body></html>`;
}

const APP = `<!doctype html><html><body><h1 id="ok">Welcome</h1></body></html>`;

const INLINE = `<!doctype html><html><body>
<form id="f">
<input id="user"><input id="password" type="password"><button id="submit" type="submit">Go</button>
</form>
<script>
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const u = document.getElementById("user").value;
  const p = document.getElementById("password").value;
  if (u === ${JSON.stringify(USER)} && p === ${JSON.stringify(PASSWORD)}) {
    const n = document.createElement("p");
    n.id = "ready";
    n.textContent = "in";
    document.body.appendChild(n);
  }
});
</script>
</body></html>`;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function serve(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/login" && req.method === "POST") {
      const params = new URLSearchParams(await readBody(req));
      if (params.get("user") === USER && params.get("password") === PASSWORD) {
        res.writeHead(302, { "set-cookie": "sid=opaque-session-token; Path=/; HttpOnly", location: "/app" }).end();
        return;
      }
      res.writeHead(401, { "content-type": "text/html" }).end(loginPage(`invalid ${params.get("password") ?? ""}`));
      return;
    }
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" }).end(loginPage(""));
      return;
    }
    if (url.pathname === "/inline") {
      res.writeHead(200, { "content-type": "text/html" }).end(INLINE);
      return;
    }
    if (url.pathname === "/app") {
      if (!(req.headers.cookie ?? "").includes("sid=opaque-session-token")) {
        res.writeHead(302, { location: "/login" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(APP);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

const auth = (over: Partial<UiAuth> = {}): UiAuth => ({
  login_path: "/login",
  fields: { user: "#user", password: "#password", submit: "#submit" },
  success: { url: "/app" },
  credentials: { user: { secret: "EVAL_USER" }, password: { secret: "EVAL_PASSWORD" } },
  ...over,
});

const shell = findHeadlessShell();
const real = (() => {
  try {
    return createSandbox("required", hostProbe);
  } catch {
    return undefined;
  }
})();

describe("ui.auth credentials", () => {
  it("resolves secret names or setup env, and only long values are redacted", () => {
    expect(resolveAuthCredentials(auth(), { EVAL_USER: USER, EVAL_PASSWORD: PASSWORD }, {})).toEqual({ user: USER, password: PASSWORD });
    expect(resolveAuthCredentials(auth({ credentials: { user: { env: "SEED_USER" }, password: { env: "SEED_PASSWORD" } }, setup: "seed" }), {}, { SEED_USER: USER, SEED_PASSWORD: PASSWORD })).toEqual({
      user: USER,
      password: PASSWORD,
    });
    expect(() => resolveAuthCredentials(auth(), {}, {})).toThrow(/user secret EVAL_USER did not resolve/);
    expect(() => resolveAuthCredentials(auth({ credentials: { user: { env: "SEED_USER" }, password: { env: "SEED_PASSWORD" } }, setup: "seed" }), {}, {})).toThrow(/was not printed/);
    expect(valuesToRedact(["abc", PASSWORD, PASSWORD])).toEqual([PASSWORD]);
  });

  it("a failing setup is scrubbed, and the values are registered before the error exists", async () => {
    const seen: string[][] = [];
    const cwd = mkdtempSync(join(tmpdir(), "auth-setup-"));
    let msg = "";
    try {
      await establishLogin({
        auth: auth({
          credentials: { user: { env: "SEED_USER" }, password: { env: "SEED_PASSWORD" } },
          setup: `printf '%s\\n' 'SEED_USER=${USER}' 'SEED_PASSWORD=${PASSWORD}'; echo leaked ${PASSWORD}; exit 3`,
        }),
        appUrl: "http://127.0.0.1:9/",
        secrets: {},
        cwd,
        env: { PATH: process.env.PATH ?? "" },
        reach: [],
        browserEnv: {},
        onSecrets: (values) => seen.push(values),
      });
    } catch (e) {
      msg = (e as Error).message;
      expect(e).toBeInstanceOf(AuthLoginError);
    }
    expect(msg).toMatch(/setup failed \(exit 3\)/);
    expect(msg).not.toContain(PASSWORD);
    expect(msg).not.toContain(USER);
    expect(seen[0]).toContain(PASSWORD);
    const dir = mkdtempSync(join(tmpdir(), "auth-log-"));
    const events = new EventLog(dir, "r1");
    events.addSecrets(seen.flat());
    writeJson({ runDir: dir, events }, "evaluate-1-tools.json", { tool: "fill", args: { value: PASSWORD }, text: `filled ${PASSWORD} for ${USER}` });
    events.emit({ step: "evaluate", event: "progress", data: { out: `${USER} ${PASSWORD}` } });
    const written = readFileSync(join(dir, "evaluate-1-tools.json"), "utf8") + readFileSync(events.path, "utf8");
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain(USER);
    expect(written).toContain("[redacted]");
  });
});

describe.skipIf(!shell)("ui.auth login (fixture page, real headless shell)", () => {
  let app: { server: Server; port: number };
  beforeAll(async () => {
    app = await serve();
  });
  afterAll(() => app.server.close());

  const browserEnv = { PATH: process.env.PATH ?? "" };

  async function logged(over: Partial<UiAuth>, secrets: Record<string, string>, jail?: Jail) {
    const seen: string[] = [];
    const session = await establishLogin({
      auth: auth(over),
      appUrl: `http://127.0.0.1:${app.port}/`,
      secrets,
      cwd: mkdtempSync(join(tmpdir(), "auth-cwd-")),
      env: browserEnv,
      jail,
      reach: [app.port],
      browserEnv,
      onSecrets: (values) => seen.push(...values),
      timeoutMs: 15_000,
    });
    return { session, seen };
  }

  async function expectWelcome(storageState: Awaited<ReturnType<typeof logged>>["session"]["storageState"], jail?: Jail): Promise<void> {
    const b = await EvalBrowser.launch({ jail, reach: [app.port], env: browserEnv, storageState });
    try {
      await b.page.goto(`http://127.0.0.1:${app.port}/app`);
      expect(b.page.url()).toMatch(/\/app$/);
      expect(await b.page.textContent("#ok")).toBe("Welcome");
    } finally {
      await b.close();
    }
  }

  it("secret names: logs in, reuses storageState, and the password is not in the state or a tool log", async () => {
    const { session, seen } = await logged({}, { EVAL_USER: USER, EVAL_PASSWORD: PASSWORD });
    expect(seen).toEqual(expect.arrayContaining([USER, PASSWORD]));
    const state = JSON.stringify(session.storageState);
    expect(state).toContain("opaque-session-token");
    expect(state).not.toContain(PASSWORD);
    expect(state).not.toContain(USER);
    await expectWelcome(session.storageState);
    const dir = mkdtempSync(join(tmpdir(), "auth-tools-"));
    const events = new EventLog(dir, "r1");
    events.addSecrets(seen);
    writeJson({ runDir: dir, events }, "evaluate-1-tools.json", { tool: "fill", args: { selector: "#password", value: PASSWORD }, text: PASSWORD });
    expect(readFileSync(join(dir, "evaluate-1-tools.json"), "utf8")).not.toContain(PASSWORD);
  }, 60_000);

  it("setup env: the command prints the credentials and the session is logged in", async () => {
    const { session } = await logged(
      {
        credentials: { user: { env: "SEED_USER" }, password: { env: "SEED_PASSWORD" } },
        setup: `printf '%s\\n' 'SEED_USER=${USER}' 'SEED_PASSWORD=${PASSWORD}'`,
      },
      {},
    );
    expect(JSON.stringify(session.storageState)).not.toContain(PASSWORD);
    await expectWelcome(session.storageState);
  }, 60_000);

  it("success may be a selector or a url glob", async () => {
    await logged({ login_path: "/inline", success: { selector: "#ready" } }, { EVAL_USER: USER, EVAL_PASSWORD: PASSWORD });
    const globbed = await logged({ success: { url: "**/app" } }, { EVAL_USER: USER, EVAL_PASSWORD: PASSWORD });
    expect(JSON.stringify(globbed.session.storageState)).not.toContain(PASSWORD);
  }, 60_000);

  it("a failed login does not echo the password", async () => {
    let msg = "";
    try {
      await performLogin({
        auth: auth(),
        appUrl: `http://127.0.0.1:${app.port}/`,
        user: USER,
        password: WRONG,
        reach: [app.port],
        env: browserEnv,
        timeoutMs: 3_000,
      });
    } catch (e) {
      msg = (e as Error).message;
      expect(e).toBeInstanceOf(AuthLoginError);
    }
    expect(msg).toMatch(/login failed/);
    expect(msg).not.toContain(WRONG);
    expect(msg).not.toContain(PASSWORD);
    expect(msg).not.toContain(USER);
  }, 30_000);

  it.skipIf(!real)("jailed browser: login storageState still opens the app", async () => {
    const jail: Jail = { sandbox: real!, rw: [], ro: [], hide: [] };
    const { session } = await logged({}, { EVAL_USER: USER, EVAL_PASSWORD: PASSWORD }, jail);
    expect(JSON.stringify(session.storageState)).not.toContain(PASSWORD);
    await expectWelcome(session.storageState, jail);
  }, 60_000);
});
