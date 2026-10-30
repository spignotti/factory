import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isolatedContextFiles } from "./context-files.js";
import { endpointViolation } from "./provider-guard.js";
import { PathGuard } from "../sandbox/guard.js";
import { type Jail, jailedCommand } from "../sandbox/sandbox.js";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, type AgentUsage, type FactoryTools } from "./runner.js";

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
    // Zen guard at runtime, the same rules as `doctor`: never the Zen endpoint by a
    // models.json override, never OpenAI on an API key.
    const zen = endpointViolation(req.model, model.baseUrl);
    if (zen) throw new AgentError(`refused: ${zen}`, undefined, 403);
    if (provider === "openai" && !runtime.isUsingSubscription("openai")) {
      throw new AgentError(`refused: ${req.model} needs the ChatGPT login (subscription) in the factory's Pi auth.json, not an API key`, undefined, 403);
    }
    const agentDir = req.agentDir ?? this.agentDir;
    // No user extensions, skills, prompt templates or memory; only the worktree's own AGENTS.md (no
    // ancestor or agent-dir context, no AGENTS.override.md).
    const context = isolatedContextFiles(req.cwd);
    for (const w of context.warnings) req.onActivity?.({ kind: "progress", detail: `warning: ${w}` });
    const agentsFiles = context.files;
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
    const factoryTools = [req.browser, req.docs].filter((t): t is FactoryTools => t !== undefined);
    const tools = [...TOOLS[req.tools], ...factoryTools.flatMap((t) => t.specs.map((s) => s.name))];
    const customTools = [...toolDefinitions(req, tools), ...factoryTools.flatMap(factoryToolDefinitions)];
    const { session } = await createAgentSession({
      cwd: req.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: req.thinking ?? "off",
      resourceLoader,
      tools,
      customTools,
      sessionManager: SessionManager.inMemory(req.cwd),
      // Pi's own retries are off: the factory decides on backoff and fallback.
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

/**
 * Custom tools replace the built-ins of the same name (AgentSession._refreshToolRegistry).
 * bash: exactly the allowlisted env, jailed by bwrap/pasta when a jail is given; the
 * in-process file tools go through a PathGuard confined to the session cwd.
 */
export function toolDefinitions(req: Pick<AgentRequest, "cwd" | "env" | "jail" | "commandTimeoutMs">, tools: string[]): ToolDefinition[] {
  const { cwd, env, jail } = req;
  const defs: unknown[] = [];
  if (tools.includes("bash")) {
    const bash = createBashToolDefinition(cwd, { exposeSessionEnvironment: false, spawnHook: bashSpawnHook(env, jail) });
    defs.push(req.commandTimeoutMs ? withCommandTimeout(bash, req.commandTimeoutMs) : bash);
  }
  if (jail) {
    const guard = new PathGuard([cwd]);
    const make: Record<string, () => unknown> = {
      read: () => createReadToolDefinition(cwd, { operations: guard.readOps() }),
      write: () => createWriteToolDefinition(cwd, { operations: guard.writeOps() }),
      edit: () => createEditToolDefinition(cwd, { operations: guard.editOps() }),
      grep: () => createGrepToolDefinition(cwd, { operations: guard.grepOps() }),
      find: () => createFindToolDefinition(cwd, { operations: guard.findOps() }),
      ls: () => createLsToolDefinition(cwd, { operations: guard.lsOps() }),
    };
    for (const t of tools) if (make[t]) defs.push(make[t]());
  }
  // Variance of the render callbacks only; the SDK registers its tools the same way internally.
  return defs as ToolDefinition[];
}

/**
 * Factory-process tools (evaluator browser, `docs_lookup`) as Pi custom tools (typebox schemas,
 * verified against Pi 1.4.0).
 */
export function factoryToolDefinitions(browser: FactoryTools): ToolDefinition[] {
  return browser.specs.map((spec) =>
    defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      executionMode: "sequential",
      async execute(_id, params) {
        const r = await browser.call(spec.name, params as Record<string, unknown>);
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: r.text }];
        if (r.image) content.push({ type: "image", data: r.image, mimeType: "image/png" });
        return { content, details: undefined, isError: r.isError };
      },
    }),
  );
}

/**
 * Pi's bash has no default timeout: a command that never exits (dev server, watch mode) would keep
 * the session silent until the watchdog kills the whole run. Every command gets `limitMs` unless
 * the model asks for less; Pi kills the process tree and returns "Command timed out after N
 * seconds" to the model as a tool error.
 */
export function withCommandTimeout<T extends { description: string; execute: (...args: never[]) => unknown }>(def: T, limitMs: number): T {
  const limitS = Math.max(1, Math.round(limitMs / 1000));
  const execute = def.execute as (id: string, params: { command: string; timeout?: number }, ...rest: unknown[]) => unknown;
  return {
    ...def,
    description: `${def.description} Commands are killed after ${limitS} seconds at most (default and maximum); run servers or watchers in the background (\`&\`, with output to a file) or with their own timeout.`,
    execute: ((id: string, params: { command: string; timeout?: number }, ...rest: unknown[]) =>
      execute(id, { ...params, timeout: effectiveTimeoutS(params.timeout, limitS) }, ...rest)) as unknown as T["execute"],
  };
}

/** Seconds for one command: the model's timeout if it is valid and below the limit, else the limit. */
export function effectiveTimeoutS(requested: number | undefined, limitS: number): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limitS) : limitS;
}

/** Pi bash spawn hook: fixed env, and the command wrapped into the jail. */
export function bashSpawnHook(env: Record<string, string>, jail: Jail | undefined) {
  return (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    ...ctx,
    command: jailedCommand(jail, ctx.command, ctx.cwd, env),
    env: { ...env },
  });
}

// UNVERIFIED: Pi reports provider errors as text in AssistantMessage.errorMessage; the HTTP status is
// recovered from that text. See docs/VERIFY.md.
function statusFromMessage(message: string): number | undefined {
  const m = /\b(4\d\d|5\d\d)\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}
