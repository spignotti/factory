import { Type } from "typebox";
import type { FactoryTools, ToolResult, ToolSpec } from "../agents/runner.js";

/**
 * Context7 documentation lookup (https://context7.com), run in the factory process, never in the
 * agent sandbox. The only host it talks to is `context7.com`; redirects are not followed.
 * The API key (`CONTEXT7_API_KEY`) is optional: without it Context7 serves anonymous, lower rate limits.
 */
export const CONTEXT7_ORIGIN = "https://context7.com";
export const CONTEXT7_KEY_ENV = "CONTEXT7_API_KEY";

/** Upper bound of docs text handed to a model per call (~3k tokens). */
export const MAX_DOC_CHARS = 12_000;
const TIMEOUT_MS = 20_000;

export type FetchLike = (url: string, init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface LibraryMatch {
  id: string;
  title: string;
  versions?: string[];
}

export type LookupStatus = "ok" | "not_found" | "rate_limited" | "auth" | "error";

export interface LookupResult {
  status: LookupStatus;
  text: string;
  library_id?: string;
  /** Estimated tokens of the returned docs (chars / 4). */
  tokens: number;
  cached?: boolean;
}

export class Context7Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: LookupStatus,
  ) {
    super(message);
    this.name = "Context7Error";
  }
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export class Context7Client {
  private readonly cache = new Map<string, LookupResult>();
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: { apiKey?: string; fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  static fromEnv(env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): Context7Client {
    const key = env[CONTEXT7_KEY_ENV]?.trim();
    return new Context7Client({ apiKey: key || undefined, fetch: fetchImpl });
  }

  get hasKey(): boolean {
    return this.opts.apiKey !== undefined;
  }

  /** GET on the Context7 origin only; returns status, body and rate-limit headers. */
  async get(path: string, params: Record<string, string>): Promise<{ status: number; body: string; remaining?: string; retryAfter?: string }> {
    const url = new URL(path, CONTEXT7_ORIGIN);
    if (url.origin !== CONTEXT7_ORIGIN) throw new Context7Error(`refused: ${url.origin} is not ${CONTEXT7_ORIGIN}`, 0, "error");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json, text/plain" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await this.fetchImpl(url.href, { headers, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS) });
    return {
      status: res.status,
      body: await res.text(),
      remaining: res.headers.get("ratelimit-remaining") ?? undefined,
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
  }

  private fail(status: number, body: string, retryAfter?: string): never {
    if (status === 429) throw new Context7Error(`Context7 rate limit reached${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`, status, "rate_limited");
    if (status === 401 || status === 403) throw new Context7Error(`Context7 refused the request (${status}); check ${CONTEXT7_KEY_ENV}`, status, "auth");
    if (status === 404) throw new Context7Error("Context7 has no documentation for this", status, "not_found");
    let message = "";
    try {
      message = String((JSON.parse(body) as { message?: unknown }).message ?? "");
    } catch {
      // not JSON
    }
    throw new Context7Error(`Context7 error ${status}${message ? `: ${message.slice(0, 200)}` : ""}`, status, "error");
  }

  async resolve(libraryName: string, query: string): Promise<LibraryMatch[]> {
    const r = await this.get("/api/v2/libs/search", { libraryName, query });
    if (r.status !== 200) this.fail(r.status, r.body, r.retryAfter);
    const results = (JSON.parse(r.body) as { results?: { id?: unknown; title?: unknown; versions?: unknown }[] }).results ?? [];
    return results
      .filter((x) => typeof x.id === "string")
      .map((x) => ({
        id: x.id as string,
        title: typeof x.title === "string" ? x.title : (x.id as string),
        ...(Array.isArray(x.versions) ? { versions: x.versions.filter((v): v is string => typeof v === "string") } : {}),
      }));
  }

  async docs(libraryId: string, query: string): Promise<string> {
    let id = libraryId;
    for (let hop = 0; hop < 2; hop++) {
      const r = await this.get("/api/v2/context", { libraryId: id, query, type: "txt" });
      if (r.status === 200) return r.body;
      // A moved library answers 301 with the new library id (not a URL to follow).
      if (r.status === 301) {
        const next = (() => {
          try {
            return (JSON.parse(r.body) as { redirectUrl?: unknown }).redirectUrl;
          } catch {
            return undefined;
          }
        })();
        if (typeof next === "string" && next.startsWith("/")) {
          id = next;
          continue;
        }
      }
      this.fail(r.status, r.body, r.retryAfter);
    }
    throw new Context7Error("Context7 redirected too often", 301, "error");
  }

  /** Resolve (unless `library` is already a `/owner/repo` id) and fetch docs; errors become a result. */
  async lookup(input: { library: string; topic: string; version?: string }): Promise<LookupResult> {
    const key = JSON.stringify([input.library, input.topic, input.version ?? ""]);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    let result: LookupResult;
    try {
      let id = input.library.trim();
      let header = "";
      if (!id.startsWith("/")) {
        const matches = await this.resolve(id, input.topic);
        if (!matches.length) return { status: "not_found", text: `No Context7 library matches "${input.library}".`, tokens: 0 };
        id = matches[0]!.id;
        const others = matches.slice(1, 4).map((m) => m.id);
        header = `Library: ${id} (${matches[0]!.title})${others.length ? `; other matches: ${others.join(", ")}` : ""}\n`;
      } else header = `Library: ${id}\n`;
      if (input.version) id = `${id.replace(/@.*$/, "")}/${input.version.replace(/^\/+/, "")}`;
      let text = await this.docs(id, input.topic);
      if (text.length > MAX_DOC_CHARS) text = `${text.slice(0, MAX_DOC_CHARS)}\n… (truncated; ask a narrower topic)`;
      result = { status: "ok", text: header + text, library_id: id, tokens: estimateTokens(text) };
    } catch (e) {
      const kind = e instanceof Context7Error ? e.kind : "error";
      const msg = e instanceof Error ? e.message : String(e);
      return { status: kind, text: `docs_lookup failed: ${msg.slice(0, 300)}. Continue without it.`, tokens: 0 };
    }
    this.cache.set(key, result);
    return result;
  }
}

export const DOCS_TOOL_SPECS: ToolSpec[] = [
  {
    name: "docs_lookup",
    description:
      "Current documentation for a library, framework or tool (Context7). Use it before writing calls against a version-sensitive API. " +
      "library: a name (e.g. 'zod', 'next.js') or a Context7 id ('/colinhacks/zod'); topic: what you need, as a specific question; " +
      "version: optional, e.g. 'v4.0.1'.",
    parameters: Type.Object({
      library: Type.String(),
      topic: Type.String(),
      version: Type.Optional(Type.String()),
    }),
  },
];

export interface DocsCall {
  library: string;
  library_id?: string;
  topic: string;
  tokens: number;
  status: LookupStatus;
  cached?: boolean;
}

/** The `docs_lookup` tool for one agent call; `onCall` records every lookup (events). */
export function docsTools(client: Context7Client, onCall: (call: DocsCall) => void): FactoryTools {
  return {
    specs: DOCS_TOOL_SPECS,
    async call(name, args): Promise<ToolResult> {
      if (name !== "docs_lookup") return { text: `unknown tool ${name}`, isError: true };
      const library = typeof args.library === "string" ? args.library : "";
      const topic = typeof args.topic === "string" ? args.topic : "";
      const version = typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;
      if (!library.trim() || !topic.trim()) return { text: "docs_lookup needs library and topic", isError: true };
      const r = await client.lookup({ library, topic, version });
      onCall({ library, ...(r.library_id ? { library_id: r.library_id } : {}), topic: topic.slice(0, 200), tokens: r.tokens, status: r.status, ...(r.cached ? { cached: true } : {}) });
      return { text: r.text, ...(r.status === "ok" ? {} : { isError: true }) };
    },
  };
}

/** `doctor`: reachability of Context7 and, when configured, whether the key is accepted. */
export async function context7Probe(client: Context7Client): Promise<{ status: "ok" | "warn" | "fail"; detail: string }> {
  try {
    const r = await client.get("/api/v2/libs/search", { libraryName: "react", query: "hooks" });
    const left = r.remaining !== undefined ? `; ${r.remaining} requests left in the window` : "";
    if (r.status === 200) return { status: "ok", detail: client.hasKey ? `reachable, ${CONTEXT7_KEY_ENV} accepted${left}` : `reachable without API key (anonymous rate limit${left}); set ${CONTEXT7_KEY_ENV} for higher limits` };
    if (r.status === 401 || r.status === 403) return { status: client.hasKey ? "fail" : "warn", detail: client.hasKey ? `${CONTEXT7_KEY_ENV} rejected (${r.status})` : `Context7 requires an API key here (${r.status}); set ${CONTEXT7_KEY_ENV}` };
    if (r.status === 429) return { status: "warn", detail: `rate limit reached${r.retryAfter ? ` (retry after ${r.retryAfter}s)` : ""}; agents get an error until it resets` };
    return { status: "warn", detail: `unexpected HTTP ${r.status}; docs_lookup returns errors to agents` };
  } catch (e) {
    return { status: "warn", detail: `unreachable (${(e as Error).message.slice(0, 120)}); docs_lookup returns errors to agents` };
  }
}
