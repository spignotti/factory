import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feedHidden, keyFileFor, notifyList, notifyRemove, notifySet, PromptAborted, type Prompter } from "../../src/commands/notify.js";
import { loadNotifyConfig } from "../../src/notify.js";

const URL_ = "https://hooks.example.test/automations/webhook/set-secret-id";
const KEY = "crsr_set-sender-key-0123456789abcdef";

const home = () => mkdtempSync(join(tmpdir(), "factory-notify-set-"));
const mode = (f: string) => statSync(f).mode & 0o777;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) }, text: () => out.join("") + err.join(""), out, err };
}

function scripted(answers: (string | Error)[]): Prompter & { asked: { q: string; hidden: boolean }[]; closed: boolean } {
  const p = {
    asked: [] as { q: string; hidden: boolean }[],
    closed: false,
    ask: async (q: string, hidden: boolean) => {
      p.asked.push({ q, hidden });
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected prompt: ${q}`);
      if (a instanceof Error) throw a;
      return a;
    },
    close: () => void (p.closed = true),
  };
  return p;
}


describe("factory notify set", () => {
  it("asks URL and key hidden, writes notify.yaml 0600 (dir 0700), never prints either, then pings when confirmed", async () => {
    const fh = join(home(), "fresh");
    const p = scripted([URL_, KEY, "y"]);
    const c = capture();
    const sent: Record<string, string>[] = [];
    const fetch = async (_u: string, init: { headers: Record<string, string> }) => (sent.push(init.headers), { status: 200 });
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets" }, p, c.io, { fetch, sleep: async () => undefined })).toBe(0);
    expect(p.asked.map((a) => a.hidden)).toEqual([true, true, false]);
    expect(p.closed).toBe(true);
    const file = join(fh, "notify.yaml");
    expect(mode(file)).toBe(0o600);
    expect(mode(fh)).toBe(0o700);
    expect(loadNotifyConfig(fh)!.repos["acme/widgets"]).toMatchObject({ url: URL_, key: KEY, header: "Authorization", scheme: "Bearer" });
    expect(sent[0]!.Authorization).toBe(`Bearer ${KEY}`);
    expect(c.text()).toMatch(/hook for acme\/widgets added/);
    expect(c.text()).toMatch(/test ping for acme\/widgets sent/);
    expect(c.text()).not.toContain(KEY);
    expect(c.text()).not.toContain("set-secret-id");
  });

  it("--key-file stores the key in keys/<owner>__<name> 0600; updating keeps other repos and comments; switching back removes the file", async () => {
    const fh = home();
    writeFileSync(join(fh, "notify.yaml"), `# hooks for the bots\nrepos:\n  acme/other:\n    url: https://other.example.test/x\n    key: other-key\nattempts: 3\n`, { mode: 0o600 });
    const c = capture();
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets", keyFile: true, test: false }, scripted([URL_, KEY]), c.io)).toBe(0);
    const kf = keyFileFor(fh, "acme/widgets");
    expect(kf).toBe(join(fh, "keys", "acme__widgets"));
    expect(readFileSync(kf, "utf8")).toBe(`${KEY}\n`);
    expect(mode(kf)).toBe(0o600);
    const text = readFileSync(join(fh, "notify.yaml"), "utf8");
    expect(text).toContain("# hooks for the bots");
    expect(text).not.toContain(KEY);
    const cfg = loadNotifyConfig(fh)!;
    expect(cfg.attempts).toBe(3);
    expect(Object.keys(cfg.repos).sort()).toEqual(["acme/other", "acme/widgets"]);
    expect(cfg.repos["acme/widgets"]).toMatchObject({ key_file: kf });

    const c2 = capture();
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets", test: false, header: "X-Automation-Key", scheme: "" }, scripted([URL_, "new-key-123"]), c2.io)).toBe(0);
    expect(c2.text()).toMatch(/updated/);
    expect(existsSync(kf)).toBe(false);
    expect(loadNotifyConfig(fh)!.repos["acme/widgets"]).toMatchObject({ key: "new-key-123", header: "X-Automation-Key", scheme: "" });
  });

  it("re-asks a non-https URL up to 3 times, then writes nothing; values never in the error", async () => {
    const fh = home();
    const c = capture();
    const bad = `http://hooks.example.test/${KEY}`;
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets", test: false }, scripted([bad, "nope", "ftp://x"]), c.io)).toBe(1);
    expect(c.err.filter((l) => l.includes("https://"))).toHaveLength(4);
    expect(existsSync(join(fh, "notify.yaml"))).toBe(false);
    expect(c.text()).not.toContain(KEY);
    const ok = capture();
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets", test: false }, scripted(["http://x", URL_, "", KEY]), ok.io)).toBe(0);
  });

  it("refuses to rewrite a loose or broken notify.yaml; Ctrl-C writes nothing; bad repo is usage", async () => {
    const loose = home();
    writeFileSync(join(loose, "notify.yaml"), "repos: {}\n");
    chmodSync(join(loose, "notify.yaml"), 0o644);
    const c = capture();
    expect(await notifySet({ factoryHome: loose, repo: "acme/widgets", test: false }, scripted([URL_, KEY]), c.io)).toBe(1);
    expect(c.text()).toMatch(/chmod 600/);
    expect(readFileSync(join(loose, "notify.yaml"), "utf8")).toBe("repos: {}\n");

    const fh = home();
    const c2 = capture();
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets" }, scripted([URL_, new PromptAborted()]), c2.io)).toBe(130);
    expect(existsSync(join(fh, "notify.yaml"))).toBe(false);
    expect(await notifySet({ factoryHome: fh, repo: "widgets" }, scripted([]), capture().io)).toBe(2);
  });

  it("answering n skips the ping; a failing ping exits 1", async () => {
    const fh = home();
    let calls = 0;
    const counting = async () => (calls++, { status: 200 });
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets" }, scripted([URL_, KEY, "n"]), capture().io, { fetch: counting })).toBe(0);
    expect(calls).toBe(0);
    const c = capture();
    expect(await notifySet({ factoryHome: fh, repo: "acme/widgets", test: true }, scripted([URL_, KEY]), c.io, { fetch: async () => ({ status: 401 }), sleep: async () => undefined })).toBe(1);
    expect(c.text()).toContain("HTTP 401");
  });
});

describe("factory notify list / remove", () => {
  it("lists repos with key storage and header only; remove drops the entry and its managed key file", async () => {
    const fh = home();
    await notifySet({ factoryHome: fh, repo: "acme/widgets", keyFile: true, test: false }, scripted([URL_, KEY]), capture().io);
    await notifySet({ factoryHome: fh, repo: "acme/gadgets", test: false }, scripted([URL_, KEY]), capture().io);
    const c = capture();
    expect(notifyList(fh, c.io)).toBe(0);
    expect(c.text()).toBe("acme/gadgets  (inline, Authorization: Bearer)\nacme/widgets  (key_file, Authorization: Bearer)\n");
    const j = capture();
    notifyList(fh, j.io, true);
    expect(JSON.parse(j.text()).repos.map((r: { repo: string }) => r.repo)).toEqual(["acme/gadgets", "acme/widgets"]);
    expect(j.text()).not.toContain("set-secret-id");

    const r = capture();
    expect(notifyRemove(fh, "acme/widgets", r.io)).toBe(0);
    expect(r.text()).toContain("and its key file");
    expect(existsSync(keyFileFor(fh, "acme/widgets"))).toBe(false);
    expect(Object.keys(loadNotifyConfig(fh)!.repos)).toEqual(["acme/gadgets"]);
    expect(mode(join(fh, "notify.yaml"))).toBe(0o600);
    expect(notifyRemove(fh, "acme/widgets", capture().io)).toBe(1);
    expect(notifyRemove(fh, "bad", capture().io)).toBe(2);
  });

  it("list without a file says how to add one", () => {
    const c = capture();
    expect(notifyList(home(), c.io)).toBe(0);
    expect(c.text()).toMatch(/factory notify set <owner\/name>/);
  });
});

describe("feedHidden", () => {
  it("handles typed and pasted input, backspace, Ctrl-U, bracketed paste and Ctrl-C", () => {
    let s = feedHidden("", "abc");
    expect(s).toEqual({ buf: "abc", done: false, aborted: false });
    s = feedHidden(s.buf, "\x7f\x7fX");
    expect(s.buf).toBe("aX");
    s = feedHidden(s.buf, "\x15");
    expect(s.buf).toBe("");
    expect(feedHidden("", `\x1b[200~${URL_}\x1b[201~\r`)).toEqual({ buf: URL_, done: true, aborted: false });
    expect(feedHidden("abc", "\x03")).toEqual({ buf: "", done: false, aborted: true });
    expect(feedHidden("", "ab\tc\n")).toEqual({ buf: "abc", done: true, aborted: false });
  });
});
