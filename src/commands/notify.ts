import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ReadStream } from "node:tty";
import { isMap, parseDocument } from "yaml";
import { expandHome } from "../secrets.js";
import { loadNotifyConfig, NotifyConfigError, NotifyConfigSchema, type NotifyDeps, NotifyHookSchema, notifyPath, notifyTest, REPO_KEY } from "../notify.js";
import type { Io } from "./gates.js";

/**
 * `factory notify set|list|remove`: manage `$FACTORY_HOME/notify.yaml` without the URL or key ever being
 * echoed, printed, logged or passed on the command line. Values are read from the controlling terminal
 * (/dev/tty) with echo off; nothing here writes them anywhere but notify.yaml / the key file (both 0600).
 */

export interface Prompter {
  /** One line from the user; `hidden` turns echo off. Rejects when the user aborts (Ctrl-C / Ctrl-D). */
  ask(question: string, hidden: boolean): Promise<string>;
  close(): void;
}

export class PromptAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "PromptAborted";
  }
}

/**
 * Line editing for hidden input, one chunk of raw terminal bytes at a time (pure, for tests). Handles
 * backspace, Ctrl-U, bracketed-paste markers and pasted text with a trailing newline.
 */
export function feedHidden(buf: string, chunk: string): { buf: string; done: boolean; aborted: boolean } {
  const esc = String.fromCharCode(27);
  const s = chunk.split(`${esc}[200~`).join("").split(`${esc}[201~`).join("");
  for (const ch of s) {
    if (ch === "\r" || ch === "\n") return { buf, done: true, aborted: false };
    if (ch === "\x03" || ch === "\x04") return { buf: "", done: false, aborted: true };
    if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
    else if (ch === "\x15") buf = "";
    else if (ch >= " ") buf += ch;
  }
  return { buf, done: false, aborted: false };
}

/** Prompts on /dev/tty (never stdin/stdout, so a pipe or log cannot capture the values). */
export function ttyPrompter(): Prompter {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new NotifyConfigError("factory notify set needs an interactive terminal (no /dev/tty): run it yourself in a terminal");
  }
  const input = new ReadStream(fd);
  const write = (s: string) => writeFileSync(fd, s);
  return {
    ask: (question, hidden) =>
      new Promise<string>((done, fail) => {
        write(question);
        input.setRawMode(true);
        let buf = "";
        const onData = (d: Buffer) => {
          const r = feedHidden(buf, d.toString("utf8"));
          buf = r.buf;
          if (!hidden && !r.aborted) write(d.toString("utf8").replace(/[\r\n].*$/s, ""));
          if (r.done || r.aborted) {
            input.off("data", onData);
            input.setRawMode(false);
            input.pause();
            write(hidden && r.done ? " (hidden, received)\n" : "\n");
            if (r.aborted) fail(new PromptAborted());
            else done(buf.trim());
          }
        };
        input.on("data", onData);
        input.resume();
      }),
    close: () => {
      input.destroy();
      try {
        closeSync(fd);
      } catch {
        /* already closed by the stream */
      }
    },
  };
}

/** Managed key file for a repo: `$FACTORY_HOME/keys/<owner>__<name>`. */
export const keyFileFor = (factoryHome: string, repo: string) => join(factoryHome, "keys", repo.replace("/", "__"));

/** Writes atomically with mode 0600 (temp file in the same directory, then rename). */
function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

function readDoc(factoryHome: string) {
  const file = notifyPath(factoryHome);
  // Validates first (perms, YAML, schema) so a broken file is never silently rewritten.
  loadNotifyConfig(factoryHome);
  return parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
}

function saveDoc(factoryHome: string, doc: ReturnType<typeof parseDocument>): void {
  const text = doc.toString();
  const parsed = NotifyConfigSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) throw new NotifyConfigError("the updated notify.yaml would be invalid; nothing written");
  writePrivate(notifyPath(factoryHome), text);
}

/** A managed key file (under $FACTORY_HOME/keys) that a hook points to, else undefined. */
function managedKeyFile(factoryHome: string, keyFile: unknown): string | undefined {
  if (typeof keyFile !== "string") return undefined;
  const abs = resolve(expandHome(keyFile));
  return abs.startsWith(join(resolve(factoryHome), "keys") + "/") ? abs : undefined;
}

export interface NotifySetOptions {
  factoryHome: string;
  repo: string;
  /** Store the key in $FACTORY_HOME/keys/<owner>__<name> (key_file) instead of inline. */
  keyFile?: boolean;
  header?: string;
  scheme?: string;
  /** true: send the test ping; false: don't; undefined: ask. */
  test?: boolean;
}

const MAX_TRIES = 3;

async function askValid(p: Prompter, io: Io, question: string, check: (v: string) => string | undefined): Promise<string> {
  for (let i = 1; ; i++) {
    const v = await p.ask(question, true);
    const problem = check(v);
    if (!problem) return v;
    io.err(`factory: ${problem}\n`);
    if (i >= MAX_TRIES) throw new NotifyConfigError(`${problem}; nothing written`);
  }
}

export async function notifySet(o: NotifySetOptions, prompter: Prompter, io: Io, deps: Omit<NotifyDeps, "factoryHome"> = {}): Promise<number> {
  if (!REPO_KEY.test(o.repo)) {
    io.err(`factory: repo must be owner/name, got ${o.repo}\n`);
    return 2;
  }
  const header = o.header ?? "Authorization";
  const scheme = o.scheme ?? "Bearer";
  try {
    const doc = readDoc(o.factoryHome);
    const previous = doc.getIn(["repos", o.repo]) as unknown;
    const prevKeyFile = isMap(previous) ? managedKeyFile(o.factoryHome, previous.get("key_file")) : undefined;
    const url = await askValid(prompter, io, `Webhook URL for ${o.repo} (the routine's "POST to", input hidden): `, (v) =>
      NotifyHookSchema.safeParse({ url: v, key: "x", header, scheme }).success ? undefined : "the URL must start with https:// and contain no spaces",
    );
    const key = await askValid(prompter, io, `Sender key for ${o.repo} (input hidden): `, (v) => (!v ? "the key is empty" : /\s/.test(v) ? "the key must not contain spaces" : undefined));
    const hook: Record<string, string> = { url };
    let keyFile: string | undefined;
    if (o.keyFile) {
      keyFile = keyFileFor(o.factoryHome, o.repo);
      hook.key_file = keyFile;
    } else hook.key = key;
    if (header !== "Authorization") hook.header = header;
    if (scheme !== "Bearer") hook.scheme = scheme;
    if (!NotifyHookSchema.safeParse(hook).success) throw new NotifyConfigError("invalid --header or --scheme");
    if (!isMap(doc.get("repos"))) doc.set("repos", doc.createNode({}));
    doc.setIn(["repos", o.repo], doc.createNode(hook));
    if (keyFile) writePrivate(keyFile, `${key}\n`);
    saveDoc(o.factoryHome, doc);
    if (prevKeyFile && prevKeyFile !== keyFile) rmSync(prevKeyFile, { force: true });
    const where = keyFile ? `key in ${keyFile}` : "key inline";
    io.out(`notify: hook for ${o.repo} ${previous === undefined ? "added" : "updated"} in ${notifyPath(o.factoryHome)} (0600; ${where}; header ${header}${scheme ? `: ${scheme} …` : ""})\n`);
    let test = o.test;
    if (test === undefined) test = !/^n/i.test(await prompter.ask("Send a test ping now? [Y/n] ", false));
    if (!test) return 0;
    const r = await notifyTest(o.repo, { ...deps, factoryHome: o.factoryHome });
    (r.ok ? io.out : io.err)(`${r.ok ? "notify: " : "factory: "}${r.message}\n`);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof PromptAborted) {
      io.err("factory: aborted; nothing written\n");
      return 130;
    }
    if (e instanceof NotifyConfigError) {
      io.err(`factory: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    prompter.close();
  }
}

export interface NotifyListEntry {
  repo: string;
  key: "inline" | "key_file";
  header: string;
}

/** `factory notify list`: repos with a hook and how the key is stored; never URLs or keys. */
export function notifyList(factoryHome: string, io: Io, json = false): number {
  let entries: NotifyListEntry[];
  try {
    const cfg = loadNotifyConfig(factoryHome);
    entries = Object.entries(cfg?.repos ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, h]) => ({ repo, key: h.key_file !== undefined ? "key_file" : "inline", header: h.scheme ? `${h.header}: ${h.scheme}` : h.header }));
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
  if (json) io.out(`${JSON.stringify({ file: notifyPath(factoryHome), repos: entries })}\n`);
  else if (!entries.length) io.out(`no hooks in ${notifyPath(factoryHome)} (add one: factory notify set <owner/name>)\n`);
  else io.out(entries.map((e) => `${e.repo}  (${e.key}, ${e.header})`).join("\n") + "\n");
  return 0;
}

/** `factory notify remove <owner/name>`: drops the entry and its managed key file. */
export function notifyRemove(factoryHome: string, repo: string, io: Io): number {
  if (!REPO_KEY.test(repo)) {
    io.err(`factory: repo must be owner/name, got ${repo}\n`);
    return 2;
  }
  try {
    const doc = readDoc(factoryHome);
    const hook = doc.getIn(["repos", repo]) as unknown;
    if (hook === undefined) {
      io.err(`factory: no hook for ${repo} in ${notifyPath(factoryHome)}\n`);
      return 1;
    }
    const kf = isMap(hook) ? managedKeyFile(factoryHome, hook.get("key_file")) : undefined;
    doc.deleteIn(["repos", repo]);
    saveDoc(factoryHome, doc);
    if (kf) rmSync(kf, { force: true });
    io.out(`notify: hook for ${repo} removed${kf ? " (and its key file)" : ""}\n`);
    return 0;
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
}

