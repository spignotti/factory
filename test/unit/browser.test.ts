import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalBrowser, findHeadlessShell, knownDevice } from "../../src/evaluate/browser.js";
import { videoToGif } from "../../src/evaluate/gif.js";
import { BrowserSession, screenshotFile } from "../../src/evaluate/tools.js";
import { browserToolDefinitions } from "../../src/agents/pi-runner.js";
import { FakeRunner } from "../../src/agents/fake-runner.js";
import { createSandbox, hostProbe, type Jail } from "../../src/sandbox/sandbox.js";

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1 id="t">Hello</h1><button id="b" onclick="document.getElementById('t').textContent='Clicked'">Go</button>
<script>console.error("boom"); fetch("/missing");</script></body></html>`;

function serve(handler: (url: string) => [number, string]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const [status, body] = handler(req.url ?? "/");
      res.writeHead(status, { "content-type": "text/html" }).end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

const shell = findHeadlessShell();
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const real = (() => {
  try {
    return createSandbox("required", hostProbe);
  } catch {
    return undefined;
  }
})();

describe.skipIf(!shell)("evaluator browser (real Chromium headless shell)", () => {
  let app: { server: Server; port: number };
  let other: { server: Server; port: number };
  beforeAll(async () => {
    app = await serve((u) => (u === "/" ? [200, PAGE] : [404, "nope"]));
    other = await serve(() => [200, "host secret"]);
  });
  afterAll(() => {
    app.server.close();
    other.server.close();
  });

  const modes: [string, Jail | undefined][] = [["unjailed", undefined]];
  if (real) modes.push(["jailed (bwrap + pasta)", { sandbox: real, rw: [], ro: [], hide: [] }]);

  for (const [name, jail] of modes) {
    it(`${name}: page, console and network capture, click, video`, async () => {
      const videoDir = join(mkdtempSync(join(tmpdir(), "video-")), "v");
      const b = await EvalBrowser.launch({ jail, reach: [app.port], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, videoDir });
      try {
        await b.page.goto(`http://127.0.0.1:${app.port}/`);
        await b.page.click("#b");
        expect(await b.page.textContent("#t")).toBe("Clicked");
        await b.page.waitForTimeout(300);
        expect(b.console).toEqual([expect.objectContaining({ kind: "console", text: "boom" })]);
        expect(b.network).toEqual([expect.objectContaining({ method: "GET", status: 404, url: `http://127.0.0.1:${app.port}/missing` })]);
      } finally {
        const videos = await b.close();
        expect(videos).toHaveLength(1);
        expect(statSync(videos[0]!).size).toBeGreaterThan(0);
        if (ffmpeg) {
          const gif = join(videoDir, "preview.gif");
          expect(await videoToGif(videos[0]!, gif, { env: { PATH: process.env.PATH ?? "" }, jail })).toBeUndefined();
          expect(readFileSync(gif).subarray(0, 6).toString()).toBe("GIF89a");
        }
      }
    }, 60_000);
  }

  it.skipIf(!real)("jailed: other host ports stay unreachable from the page", async () => {
    const b = await EvalBrowser.launch({ jail: { sandbox: real!, rw: [], ro: [], hide: [] }, reach: [app.port], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    try {
      await expect(b.page.goto(`http://127.0.0.1:${other.port}/`)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("mobile device: viewport, touch and tap (React Native Web / Expo web)", async () => {
    expect(knownDevice("Pixel 7")).toBe(true);
    expect(knownDevice("Nokia 3310")).toBe(false);
    const b = await EvalBrowser.launch({ reach: [app.port], env: {}, device: "Pixel 7" });
    try {
      await b.page.goto(`http://127.0.0.1:${app.port}/`);
      const m = (await b.page.evaluate("({ w: window.innerWidth, touch: navigator.maxTouchPoints, ua: navigator.userAgent })")) as { w: number; touch: number; ua: string };
      expect(m.w).toBeLessThan(500);
      expect(m.touch).toBeGreaterThan(0);
      expect(m.ua).toMatch(/Android/);
      await b.page.tap("#b");
      expect(await b.page.textContent("#t")).toBe("Clicked");
    } finally {
      await b.close();
    }
  }, 60_000);

  it("browser tools: same-origin goto, click, text, screenshot, console, network; Pi definitions and fake tool_calls", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "evidence-"));
    const b = await EvalBrowser.launch({ reach: [app.port], env: {} });
    const tools = new BrowserSession(b, { baseUrl: `http://127.0.0.1:${app.port}/`, evidenceDir, prefix: "eval-1" });
    try {
      expect((await tools.call("goto", { url: `http://127.0.0.1:${other.port}/` })).isError).toBe(true);
      expect((await tools.call("goto", { url: "/" })).text).toMatch(/^200 /);
      expect(await tools.call("click", { selector: "#b" })).toEqual({ text: "clicked" });
      expect((await tools.call("text", { selector: "#t" })).text).toBe("Clicked");
      expect((await tools.call("click", { selector: "#nope" })).isError).toBe(true);
      expect((await tools.call("fill", { selector: 1 })).text).toMatch(/selector must be a string/);
      const shot = await tools.call("screenshot", { name: "A1" });
      expect(shot.image).toBeTruthy();
      expect(existsSync(join(evidenceDir, "eval-1-A1.png"))).toBe(true);
      expect(tools.screenshots.get("A1")).toBe("eval-1-A1.png");
      expect(JSON.parse((await tools.call("console", {})).text)).toEqual([expect.objectContaining({ text: "boom" })]);
      expect(JSON.parse((await tools.call("network", {})).text)).toEqual([expect.objectContaining({ status: 404 })]);

      const defs = browserToolDefinitions(tools);
      expect(defs.map((d) => d.name)).toEqual(["goto", "click", "tap", "fill", "text", "screenshot", "console", "network"]);
      const r = await defs.find((d) => d.name === "screenshot")!.execute("id", { name: "A2" }, undefined, undefined, undefined as never);
      expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);

      const fake = new FakeRunner([{ role: "evaluate", tool_calls: [{ tool: "text", args: { selector: "h1" } }], output: { ok: true } }]);
      await fake.run({ role: "evaluate", model: "m/x", cwd: evidenceDir, system: "", prompt: "", tools: "read_only", env: {}, browser: tools });
      expect(fake.calls[0]!.toolResults).toEqual([{ tool: "text", text: "Clicked" }]);
      await expect(new FakeRunner([{ role: "evaluate", tool_calls: [{ tool: "text", args: {} }] }]).run({ role: "evaluate", model: "m/x", cwd: evidenceDir, system: "", prompt: "", tools: "read_only", env: {} })).rejects.toThrow(/no browser tools/);
    } finally {
      await b.close();
    }
    expect(screenshotFile("p", "../../etc/x y")).toBe("p-etc_x_y.png");
  }, 60_000);

  it("a missing browser names the install command", async () => {
    await expect(EvalBrowser.launch({ reach: [], env: {}, executable: "" })).rejects.toThrow(/install: npx playwright-core install --only-shell chromium/);
    expect(existsSync(shell!)).toBe(true);
  });
});
