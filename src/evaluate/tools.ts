import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import type { EvalBrowser } from "./browser.js";

/**
 * Browser tools of the evaluator. They run in the factory process against the jailed
 * browser; Pi gets them as custom tools, the fake runner calls them from scripted `tool_calls`.
 */
export interface BrowserToolResult {
  text: string;
  /** PNG screenshot, base64 (shown to the model). */
  image?: string;
  isError?: boolean;
}

export interface BrowserTools {
  readonly specs: BrowserToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<BrowserToolResult>;
}

export interface BrowserToolSpec {
  name: string;
  description: string;
  parameters: TSchema;
}

const SELECTOR = Type.String({ description: 'Playwright selector: CSS, text=…, role=button[name="…"], or [data-testid=…]' });

export const BROWSER_TOOL_SPECS: BrowserToolSpec[] = [
  { name: "goto", description: "Open a page of the app: a path like /tours, or a full URL on the app's origin.", parameters: Type.Object({ url: Type.String() }) },
  { name: "click", description: "Click an element.", parameters: Type.Object({ selector: SELECTOR }) },
  { name: "tap", description: "Tap an element (touch devices, e.g. a mobile web build).", parameters: Type.Object({ selector: SELECTOR }) },
  { name: "fill", description: "Fill an input or textarea with a value.", parameters: Type.Object({ selector: SELECTOR, value: Type.String() }) },
  { name: "text", description: "Visible text of an element, or of the page when no selector is given.", parameters: Type.Object({ selector: Type.Optional(SELECTOR) }) },
  {
    name: "screenshot",
    description: "Screenshot of the current page, saved as evidence under the given name (use the criterion id, e.g. A2). Returns the image.",
    parameters: Type.Object({ name: Type.String(), full_page: Type.Optional(Type.Boolean()) }),
  },
  { name: "console", description: "Console errors and warnings the app logged so far (all pages of this session).", parameters: Type.Object({}) },
  { name: "network", description: "Failed requests (network errors and HTTP status >= 400) so far.", parameters: Type.Object({}) },
];

const MAX_TEXT = 8000;

/** Evidence file name of a named screenshot; the name is reduced to a safe slug. */
export function screenshotFile(prefix: string, name: string): string {
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "shot";
  return `${prefix}-${slug}.png`;
}

export interface BrowserSessionOptions {
  /** The app's URL; goto only accepts paths and URLs on its origin. */
  baseUrl: string;
  evidenceDir: string;
  /** Evidence file prefix, e.g. `r1`. */
  prefix: string;
}

/** The tools bound to one launched browser. Errors are returned to the model, never thrown. */
export class BrowserSession implements BrowserTools {
  readonly specs = BROWSER_TOOL_SPECS;
  /** Screenshot name → evidence file name. */
  readonly screenshots = new Map<string, string>();
  /** Every call, for the run log. */
  readonly calls: { tool: string; args: Record<string, unknown>; text: string; isError?: boolean }[] = [];

  constructor(
    private readonly browser: EvalBrowser,
    private readonly opts: BrowserSessionOptions,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
    let r: BrowserToolResult;
    try {
      r = await this.run(name, args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r = { text: `${name} failed: ${msg.split("\n").slice(0, 3).join(" ")}`, isError: true };
    }
    this.calls.push({ tool: name, args, text: r.text.slice(0, 500), ...(r.isError ? { isError: true } : {}) });
    return r;
  }

  private resolve(url: string): string {
    const base = new URL(this.opts.baseUrl);
    const target = new URL(url, base);
    if (target.origin !== base.origin) throw new Error(`only the app's origin ${base.origin} may be opened, not ${target.origin}`);
    return target.href;
  }

  private async run(name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
    const page = this.browser.page;
    const str = (k: string): string => {
      const v = args[k];
      if (typeof v !== "string") throw new Error(`${name}: ${k} must be a string`);
      return v;
    };
    switch (name) {
      case "goto": {
        const res = await page.goto(this.resolve(str("url")));
        return { text: `${res?.status() ?? "no response"} ${page.url()} — ${await page.title()}` };
      }
      case "click":
        await page.click(str("selector"));
        return { text: "clicked" };
      case "tap":
        await page.tap(str("selector"));
        return { text: "tapped" };
      case "fill":
        await page.fill(str("selector"), str("value"));
        return { text: "filled" };
      case "text": {
        const sel = args.selector === undefined ? "body" : str("selector");
        const t = await page.innerText(sel);
        return { text: t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… (${t.length - MAX_TEXT} more chars)` : t };
      }
      case "screenshot": {
        const label = str("name");
        const file = screenshotFile(this.opts.prefix, label);
        const png = await page.screenshot({ fullPage: args.full_page === true });
        mkdirSync(this.opts.evidenceDir, { recursive: true });
        writeFileSync(join(this.opts.evidenceDir, file), png);
        this.screenshots.set(label, file);
        return { text: `saved ${file}`, image: png.toString("base64") };
      }
      case "console":
        return { text: JSON.stringify(this.browser.console, null, 1) };
      case "network":
        return { text: JSON.stringify(this.browser.network, null, 1) };
      default:
        throw new Error(`unknown browser tool ${name}`);
    }
  }
}
