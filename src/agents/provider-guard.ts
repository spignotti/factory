import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Zen guard. OpenCode Zen (`opencode`) bills per use; OpenCode Go (`opencode-go`) is the
 * subscription on the same host under `/go`. Both read the same API key, so a model id or a `models.json`
 * `baseUrl` override is all it takes to bill Zen. OpenAI may only run on the ChatGPT login
 * (subscription), never on an API key.
 */
export const ZEN_PROVIDER = "opencode";

/** True for an OpenCode endpoint outside the Go subscription path (i.e. Zen). */
export function isZenEndpoint(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return false;
  // Go lives under `/<prefix>/go/…` (Pi 1.4.0: `/inference/go/v1`; formerly `/zen/go/v1`); anything
  // else on the host is billed per use. A changed path fails closed (doctor fails, sessions refused).
  return !/^\/(?:inference|zen)\/go(?:\/|$)/.test(url.pathname);
}

/** Why a resolved model must not be used, or undefined. `opencode` itself is governed by the provider policy. */
export function endpointViolation(model: string, baseUrl: string | undefined): string | undefined {
  const provider = model.split("/")[0]!;
  if (baseUrl === undefined) return undefined;
  if (provider !== ZEN_PROVIDER && isZenEndpoint(baseUrl)) {
    return `${model} resolves to the pay-per-use OpenCode Zen endpoint ${baseUrl} (OpenCode Go needs a /go/ base URL)`;
  }
  return undefined;
}

export interface ProviderAuth {
  configured: boolean;
  /** OAuth login of a subscription plan (ChatGPT for `openai`). */
  subscription: boolean;
  /** Where the credential comes from; never the credential itself. */
  source: string;
}

/** What `doctor` needs to know about Pi's model and auth configuration (tests inject a fake). */
export interface ProviderView {
  /** Resolved model (with `models.json` overrides), undefined when Pi does not know it. */
  resolve(model: string): { baseUrl: string; api: string } | undefined;
  auth(provider: string): ProviderAuth;
  /** Every `baseUrl` written in the factory's `models.json` (path → value). */
  modelsJsonBaseUrls(): { path: string; baseUrl: string }[];
  /** One tiny request; rejects on any error. */
  ping(model: string, signal: AbortSignal): Promise<void>;
}

function collectBaseUrls(node: unknown, path: string, out: { path: string; baseUrl: string }[]): void {
  if (Array.isArray(node)) node.forEach((v, i) => collectBaseUrls(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/^base_?url$/i.test(k) && typeof v === "string") out.push({ path: `${path}.${k}`, baseUrl: v });
      else collectBaseUrls(v, `${path}.${k}`, out);
    }
  }
}

/**
 * Options of the one-shot `doctor --ping` request. OpenCode (Go included) rejects a request without a
 * per-conversation `x-opencode-session` header (400 MissingSessionID); Pi derives that header from
 * `sessionId`, so every ping carries a fresh one. Other providers ignore it.
 */
export function pingRequestOptions(signal: AbortSignal): { signal: AbortSignal; maxTokens: number; sessionId: string } {
  return { signal, maxTokens: 16, sessionId: `factory-doctor-${randomUUID()}` };
}

/** The view of the factory-owned Pi agent dir (`$FACTORY_HOME/pi`): same files PiRunner uses. */
export async function piProviderView(agentDir: string): Promise<ProviderView> {
  const modelsPath = join(agentDir, "models.json");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
  const split = (id: string) => {
    const i = id.indexOf("/");
    return i > 0 ? ([id.slice(0, i), id.slice(i + 1)] as const) : undefined;
  };
  return {
    resolve(model) {
      const p = split(model);
      const m = p && runtime.getModel(p[0], p[1]);
      return m ? { baseUrl: m.baseUrl, api: String(m.api) } : undefined;
    },
    auth(provider) {
      const status = runtime.getProviderAuthStatus(provider) as { configured: boolean; source?: string; label?: string };
      const source = status.configured ? `${status.source ?? "configured"}${status.label ? ` (${status.label})` : ""}${runtime.isUsingOAuth(provider) ? ", oauth" : ""}` : "none";
      return { configured: status.configured, subscription: runtime.isUsingSubscription(provider), source };
    },
    modelsJsonBaseUrls() {
      if (!existsSync(modelsPath)) return [];
      const out: { path: string; baseUrl: string }[] = [];
      try {
        collectBaseUrls(JSON.parse(readFileSync(modelsPath, "utf8")), "models.json", out);
      } catch {
        // Pi reports an unreadable models.json itself.
      }
      return out;
    },
    async ping(model, signal) {
      const p = split(model);
      const m = p && runtime.getModel(p[0], p[1]);
      if (!m) throw new Error(`unknown model ${model}`);
      const res = await runtime.completeSimple(m, { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] }, pingRequestOptions(signal));
      if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error((res.errorMessage ?? res.stopReason).slice(0, 200));
    },
  };
}
