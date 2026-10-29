import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { trackProcessGroup } from "../exec.js";
import { type Jail, jailedArgv, shellQuote } from "../sandbox/sandbox.js";

/**
 * The evaluator's browser (§6.5, Amendment x): Playwright's Chromium headless shell. With the
 * sandbox on, the browser runs in its own bwrap/pasta jail like every repo command: it reaches only
 * the app's ports (never host services such as a local Docker API), writes only its private /tmp,
 * and Playwright drives it over CDP through one exposed debug port. pasta closes inherited fds, so
 * Playwright's pipe transport cannot cross it; and Chromium binds its debug port to the loopback of
 * the namespace, which pasta's inbound forward does not reach, so a small Node relay inside the jail
 * listens on 0.0.0.0 and forwards to it. With the sandbox off the browser is a plain local launch.
 */

export const DEFAULT_DEVICE = "Desktop Chrome";

/** Console messages of type error and uncaught page errors. */
export interface ConsoleEntry {
  kind: "console" | "pageerror";
  text: string;
  url: string;
}

/** Responses with status >= 400 and requests that failed outright. */
export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  failure?: string;
}

export interface BrowserOptions {
  /** Jail of the run (sandbox, hide); undefined = unjailed. rw/ro/ports are replaced. */
  jail?: Jail;
  /** Host ports the page may reach (the ui service and its dependencies). */
  reach: number[];
  /** A Playwright device descriptor name (`Desktop Chrome`, `Pixel 7`, `iPhone 15` …). */
  device?: string;
  /** Records a video of every page into this dir (webm). */
  videoDir?: string;
  /** Environment of the browser process (HOME is replaced by its private /tmp). */
  env: Record<string, string>;
  /** Headless shell binary; default: the one matching playwright-core under the browsers path. */
  executable?: string;
  /** Default timeout of page actions (ms). */
  timeoutMs?: number;
}

/** Device names Playwright knows (validated in repo.yaml). */
export function knownDevice(name: string): boolean {
  return Object.hasOwn(devices, name);
}

/** `PLAYWRIGHT_BROWSERS_PATH`, else Playwright's default cache dir. */
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.PLAYWRIGHT_BROWSERS_PATH;
  if (p && p !== "0") return p;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright");
}

export const INSTALL_HINT = "npx playwright-core install --only-shell chromium";

/** The Chromium headless shell matching the installed playwright-core, or undefined. */
export function findHeadlessShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const req = createRequire(import.meta.url);
  const browsers = JSON.parse(readFileSync(join(dirname(req.resolve("playwright-core/package.json")), "browsers.json"), "utf8")) as {
    browsers: { name: string; revision: string }[];
  };
  const rev = browsers.browsers.find((b) => b.name === "chromium-headless-shell")?.revision;
  const dir = join(browsersPath(env), `chromium_headless_shell-${rev}`);
  if (!existsSync(dir)) return undefined;
  for (const sub of readdirSync(dir)) {
    const exe = join(dir, sub, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    if (sub.startsWith("chrome-headless-shell") && existsSync(exe)) return exe;
  }
  return undefined;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const CHROME_ARGS = ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain"];
/** Debug port inside an isolated jail; only the relay's port is forwarded. */
const INNER_DEBUG_PORT = 9222;

/** Inline relay: jail 0.0.0.0:outer → jail 127.0.0.1:inner. */
function relayScript(outer: number, inner: number): string {
  return `const n=require("net");n.createServer(s=>{const c=n.connect(${inner},"127.0.0.1");s.pipe(c);c.pipe(s);c.on("error",()=>s.destroy());s.on("error",()=>c.destroy())}).listen(${outer},"0.0.0.0")`;
}

/** One browser with one context (device, video) and one page; console and network are captured. */
export class EvalBrowser {
  readonly console: ConsoleEntry[] = [];
  readonly network: NetworkEntry[] = [];
  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly child: ChildProcess | undefined,
    private readonly untrack: () => void,
  ) {
    page.on("console", (m) => {
      // "Failed to load resource" duplicates a network entry.
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource:")) this.console.push({ kind: "console", text: m.text(), url: m.location().url });
    });
    page.on("pageerror", (e) => this.console.push({ kind: "pageerror", text: e.message, url: page.url() }));
    page.on("response", (r) => {
      if (r.status() >= 400) this.network.push({ method: r.request().method(), url: r.url(), status: r.status() });
    });
    page.on("requestfailed", (r) => {
      const failure = r.failure()?.errorText ?? "failed";
      // Navigations a later goto superseded are not app errors.
      if (failure !== "net::ERR_ABORTED") this.network.push({ method: r.method(), url: r.url(), status: null, failure });
    });
  }

  static async launch(opts: BrowserOptions): Promise<EvalBrowser> {
    const executable = opts.executable ?? findHeadlessShell();
    if (!executable) throw new Error(`no Chromium headless shell for playwright-core under ${browsersPath()} (install: ${INSTALL_HINT})`);
    const jailed = !!opts.jail && opts.jail.sandbox.fs !== "none";
    let browser: Browser;
    let child: ChildProcess | undefined;
    let untrack = () => {};
    if (!jailed) {
      browser = await chromium.launch({ executablePath: executable, args: CHROME_ARGS.slice(1), headless: true });
    } else {
      ({ browser, child, untrack } = await launchJailed(executable, opts));
    }
    try {
      const device = devices[opts.device ?? DEFAULT_DEVICE];
      if (!device) throw new Error(`unknown device ${opts.device}`);
      const { defaultBrowserType: _, ...descriptor } = device;
      if (opts.videoDir) mkdirSync(opts.videoDir, { recursive: true });
      const context = await browser.newContext({
        ...descriptor,
        ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: descriptor.viewport } } : {}),
      });
      context.setDefaultTimeout(opts.timeoutMs ?? 10_000);
      context.setDefaultNavigationTimeout(Math.max(opts.timeoutMs ?? 10_000, 30_000));
      const page = await context.newPage();
      return new EvalBrowser(browser, context, page, child, untrack);
    } catch (e) {
      await browser.close().catch(() => undefined);
      killGroup(child);
      untrack();
      throw e;
    }
  }

  /** Closes context and browser; returns the finished video files. Never throws. */
  async close(): Promise<string[]> {
    const videos: string[] = [];
    try {
      const pages = this.context.pages();
      await this.context.close();
      for (const p of pages) {
        const path = await p.video()?.path().catch(() => undefined);
        if (path && existsSync(path)) videos.push(path);
      }
    } catch {
      // browser already gone
    }
    await this.browser.close().catch(() => undefined);
    killGroup(this.child);
    this.untrack();
    return videos;
  }
}

function killGroup(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // gone
  }
}

async function launchJailed(executable: string, opts: BrowserOptions): Promise<{ browser: Browser; child: ChildProcess; untrack: () => void }> {
  const base = opts.jail!;
  const isolated = base.sandbox.net === "isolated";
  const port = await freePort();
  const shellDir = dirname(dirname(executable));
  const ro = [shellDir, "/etc/fonts", dirname(process.execPath)];
  const jail: Jail = { sandbox: base.sandbox, hide: base.hide, rw: [], ro, ports: { expose: [port], reach: opts.reach } };
  const chrome = [executable, ...CHROME_ARGS, "--user-data-dir=/tmp/profile", `--remote-debugging-port=${isolated ? INNER_DEBUG_PORT : port}`, "about:blank"].map(shellQuote).join(" ");
  const command = isolated ? `${shellQuote(process.execPath)} -e ${shellQuote(relayScript(port, INNER_DEBUG_PORT))} & exec ${chrome}` : `exec ${chrome}`;
  const env: Record<string, string> = { ...opts.env, HOME: "/tmp" };
  const [file, ...args] = jailedArgv(jail, "sh", command, "/tmp", env);
  const child = spawn(file!, args, { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  const untrack = child.pid ? trackProcessGroup(child.pid) : () => {};
  let stderr = "";
  const listening = new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
      if (stderr.includes("DevTools listening on")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`browser exited (${code}) before it was ready: ${stderr.trim().split("\n").slice(-5).join(" | ")}`)));
    child.once("error", reject);
  });
  const fail = (e: unknown): never => {
    killGroup(child);
    untrack();
    throw e;
  };
  await Promise.race([listening, new Promise((_, reject) => setTimeout(() => reject(new Error("browser not ready after 30s")), 30_000))]).catch(fail);
  child.stderr!.resume();
  let last: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
      return { browser, child, untrack };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return fail(new Error(`browser: no CDP connection on port ${port}: ${(last as Error).message}`));
}
