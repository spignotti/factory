import { redact } from "../events.js";
import { sh, tail } from "../exec.js";
import type { UiAuth } from "../schemas/repo.js";
import type { Jail } from "../sandbox/sandbox.js";
import { MIN_REDACT_LENGTH, parseDotenv } from "../secrets.js";
import { type BrowserStorageState, EvalBrowser } from "./browser.js";

/**
 * Deterministic login for `ui.auth`. Playwright fills the form and the storage state is reused for
 * the evaluator session, so the model never types the password. Login is not recorded: a video of
 * the form would show the password being entered.
 */

export class AuthLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthLoginError";
  }
}

export interface LoginSession {
  storageState: BrowserStorageState;
  /** Credential fields too short to redact from logs (they would mangle unrelated text). */
  short: ("user" | "password")[];
}

type CredentialRef = UiAuth["credentials"]["user"];

/** Resolves the two credential names. The message names the missing variable, never a value. */
export function resolveAuthCredentials(auth: UiAuth, secrets: Record<string, string>, setupEnv: Record<string, string>): { user: string; password: string } {
  const one = (which: "user" | "password", ref: CredentialRef): string => {
    if ("secret" in ref) {
      const value = secrets[ref.secret];
      if (!value) throw new AuthLoginError(`ui.auth: ${which} secret ${ref.secret} did not resolve`);
      return value;
    }
    const value = setupEnv[ref.env];
    if (!value) throw new AuthLoginError(`ui.auth: ${which} env ${ref.env} was not printed by the setup command`);
    return value;
  };
  return { user: one("user", auth.credentials.user), password: one("password", auth.credentials.password) };
}

/** Long enough to redact. Shorter values are reported, not substituted (they match inside other words). */
export function valuesToRedact(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length >= MIN_REDACT_LENGTH))].sort((a, b) => b.length - a.length);
}

/** Replaces every credential value in one error string, including short ones (a single message, not the log). */
function scrubAll(text: string, values: string[]): string {
  const all = [...new Set(values.filter((v) => v.length > 0))].sort((a, b) => b.length - a.length);
  return redact(text, all).replace(/\s+/g, " ").trim().slice(0, 500);
}

function successWait(appUrl: string, expected: string): string | ((url: URL) => boolean) {
  if (expected.includes("*")) return expected;
  const target = new URL(expected, appUrl);
  const want = target.pathname.replace(/\/$/, "") || "/";
  return (url) => {
    if (url.origin !== target.origin) return false;
    const got = url.pathname.replace(/\/$/, "") || "/";
    if (want === "/") return got === "/";
    return got === want || got.startsWith(`${want}/`);
  };
}

export interface EstablishLoginOptions {
  auth: UiAuth;
  appUrl: string;
  /** Resolved repo secrets (`name → value`). Only names declared as `secret` are read. */
  secrets: Record<string, string>;
  cwd: string;
  /** Env of the setup command (command env, including repo secrets). Not the browser's env. */
  env: Record<string, string>;
  jail?: Jail;
  reach: number[];
  device?: string;
  /** Browser process env. Must not carry the credentials. */
  browserEnv: Record<string, string>;
  /** Expands `{port:…}` in the setup command. */
  expand?: (text: string) => Promise<string>;
  /** Called with credential values as soon as they are known, before login and before any throw that quotes output. */
  onSecrets: (values: string[]) => void;
  timeoutMs?: number;
  setupTimeoutMs?: number;
}

/**
 * Runs `auth.setup` when set, resolves credentials, then logs in. `onSecrets` runs before the values
 * can show up in a browser error or a failed setup's output.
 */
export async function establishLogin(opts: EstablishLoginOptions): Promise<LoginSession> {
  const { auth } = opts;
  let produced: Record<string, string> = {};
  if (auth.setup) {
    const cmd = opts.expand ? await opts.expand(auth.setup) : auth.setup;
    const r = await sh(cmd, {
      cwd: opts.cwd,
      env: { ...opts.env, BASE_URL: opts.appUrl },
      jail: opts.jail,
      timeoutMs: opts.setupTimeoutMs ?? 5 * 60_000,
    });
    produced = parseDotenv(r.output);
    // Before the failure text is built: the tail is scrubbed, and the values join the run's redaction list.
    opts.onSecrets(valuesToRedact(Object.values(produced)));
    if (r.code !== 0) throw new AuthLoginError(`ui.auth: setup failed (exit ${r.code}): ${scrubAll(tail(r.output, 5), Object.values(produced))}`);
  }
  const creds = resolveAuthCredentials(auth, opts.secrets, produced);
  opts.onSecrets(valuesToRedact([creds.user, creds.password]));
  const storageState = await performLogin({
    auth,
    appUrl: opts.appUrl,
    user: creds.user,
    password: creds.password,
    jail: opts.jail,
    reach: opts.reach,
    device: opts.device,
    env: opts.browserEnv,
    timeoutMs: opts.timeoutMs,
  });
  const short = (["user", "password"] as const).filter((k) => creds[k].length > 0 && creds[k].length < MIN_REDACT_LENGTH);
  return { storageState, short };
}

export async function performLogin(opts: {
  auth: UiAuth;
  appUrl: string;
  user: string;
  password: string;
  jail?: Jail;
  reach: number[];
  device?: string;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<BrowserStorageState> {
  const timeout = opts.timeoutMs ?? 30_000;
  const secrets = [opts.user, opts.password];
  const b = await EvalBrowser.launch({
    jail: opts.jail,
    reach: opts.reach,
    device: opts.device,
    env: opts.env,
    timeoutMs: timeout,
  });
  try {
    const loginUrl = new URL(opts.auth.login_path, opts.appUrl).href;
    await b.page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await b.page.fill(opts.auth.fields.user, opts.user);
    await b.page.fill(opts.auth.fields.password, opts.password);
    const success = opts.auth.success;
    if ("selector" in success) {
      await b.page.click(opts.auth.fields.submit);
      await b.page.waitForSelector(success.selector, { timeout });
    } else {
      // Wait is armed before the click so a fast redirect is not missed.
      await Promise.all([b.page.waitForURL(successWait(opts.appUrl, success.url), { timeout }), b.page.click(opts.auth.fields.submit)]);
    }
    // IndexedDB: some apps (Firebase and the like) keep the session there, not in a cookie.
    return await b.context.storageState({ indexedDB: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AuthLoginError(`ui.auth: login failed: ${scrubAll(msg, secrets)}`);
  } finally {
    await b.close();
  }
}
