import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  loadProjectContextFiles,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, type AgentUsage } from "./runner.js";

const TOOLS: Record<AgentRequest["tools"], string[]> = {
  coding: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  read_only: ["read", "grep", "find", "ls"],
  none: [],
};

/** Minimum time between heartbeat events derived from session stream activity. */
const HEARTBEAT_THROTTLE_MS = 10_000;

interface Kept {
  session: AgentSession;
  usageBefore: AgentUsage;
}

function statsUsage(session: AgentSession): AgentUsage {
  const s = session.getSessionStats();
  return { tokens_in: s.tokens.input + s.tokens.cacheRead, tokens_out: s.tokens.output, cost_usd: s.cost };
}

function diffUsage(after: AgentUsage, before: AgentUsage): AgentUsage {
  return {
    tokens_in: after.tokens_in - before.tokens_in,
    tokens_out: after.tokens_out - before.tokens_out,
    cost_usd: after.cost_usd - before.cost_usd,
  };
}

function splitModel(id: string): { provider: string; model: string } {
  const i = id.indexOf("/");
  if (i <= 0) throw new AgentError(`model id must be <provider>/<model>: ${id}`);
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/** Runs every role through the Pi SDK (`@earendil-works/pi-coding-agent`), verified against 1.4.0. */
export class PiRunner implements AgentRunner {
  private readonly sessions = new Map<string, Kept>();
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(private readonly agentDir: string) {}

  private modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    return this.runtime;
  }

  private async createSession(req: AgentRequest): Promise<AgentSession> {
    const runtime = await this.modelRuntime();
    const { provider, model: modelId } = splitModel(req.model);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new AgentError(`unknown model ${req.model}`);
    const agentDir = req.agentDir ?? this.agentDir;
    // No user extensions, skills, prompt templates or memory; the repo's AGENTS.md is allowed (SPEC §8.3).
    const agentsFiles = loadProjectContextFiles({ cwd: req.cwd, agentDir });
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles }),
      getSystemPrompt: () => req.system,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const env = req.env;
    // A custom tool replaces the built-in tool of the same name (AgentSession._refreshToolRegistry),
    // so every bash process gets exactly the allowlisted env (Amendment b).
    const bash = createBashToolDefinition(req.cwd, {
      exposeSessionEnvironment: false,
      spawnHook: (ctx) => ({ ...ctx, env: { ...env } }),
    });
    const tools = TOOLS[req.tools];
    const { session } = await createAgentSession({
      cwd: req.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: req.thinking ?? "off",
      resourceLoader,
      tools,
      // Variance of the render callbacks only; the SDK registers bash the same way internally.
      customTools: tools.includes("bash") ? [bash as unknown as ToolDefinition] : [],
      sessionManager: SessionManager.inMemory(req.cwd),
      // Pi's own retries are off: the factory decides on backoff and fallback (Amendment c).
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } }),
    });
    return session;
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    // A continued session belongs to one model; a fallback model starts its own session.
    const key = req.sessionKey ? `${req.sessionKey}|${req.model}` : undefined;
    let kept = key ? this.sessions.get(key) : undefined;
    const isNew = !kept;
    if (!kept) {
      const session = await this.createSession(req);
      kept = { session, usageBefore: { tokens_in: 0, tokens_out: 0, cost_usd: 0 } };
    } else {
      kept.usageBefore = statsUsage(kept.session);
    }
    const { session } = kept;
    let lastBeat = 0;
    let lastError: { message: string } | undefined;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_start") {
        req.onActivity?.({ kind: "progress", detail: `tool:${event.toolName}` });
      } else if (event.type === "turn_end") {
        req.onActivity?.({ kind: "progress", detail: "turn" });
      } else if (event.type === "message_end") {
        const m = event.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant" && m.stopReason === "error") lastError = { message: m.errorMessage ?? "error" };
      } else if (Date.now() - lastBeat >= HEARTBEAT_THROTTLE_MS) {
        lastBeat = Date.now();
        req.onActivity?.({ kind: "heartbeat" });
      }
    });
    const onAbort = () => void session.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(req.prompt);
      const usage = diffUsage(statsUsage(session), kept.usageBefore);
      if (lastError) throw new AgentError(lastError.message, usage, statusFromMessage(lastError.message));
      if (req.signal?.aborted) throw new AgentError("aborted", usage);
      if (key) this.sessions.set(key, kept);
      else session.dispose();
      return { text: session.getLastAssistantText() ?? "", usage };
    } catch (e) {
      const usage = e instanceof AgentError ? e.usage : diffUsage(statsUsage(session), kept.usageBefore);
      if (isNew) session.dispose();
      if (e instanceof AgentError) throw e;
      throw new AgentError((e as Error).message, usage);
    } finally {
      unsubscribe();
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    for (const { session } of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

// UNVERIFIED: Pi reports provider errors as text in AssistantMessage.errorMessage; the HTTP status is
// recovered from that text. See docs/VERIFY.md.
function statusFromMessage(message: string): number | undefined {
  const m = /\b(4\d\d|5\d\d)\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}
