import type { TSchema } from "typebox";
import type { Jail } from "../sandbox/sandbox.js";
/** One interface for every LLM role: plan, implement, reviewers, summarize. */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** `coding`: read/bash/edit/write; `read_only`: read/grep/find/ls (reviewers); `none`: text only. */
export type ToolSet = "coding" | "read_only" | "none";

export interface AgentUsage {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export const ZERO_USAGE: AgentUsage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

export interface AgentActivity {
  kind: "heartbeat" | "progress";
  detail?: string;
}

/** A tool the factory process runs for the model (Pi custom tool; the fake runner calls it from `tool_calls`). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: TSchema;
}

export interface ToolResult {
  text: string;
  /** PNG screenshot, base64 (shown to the model). */
  image?: string;
  isError?: boolean;
}

/** Tools that run in the factory process, outside the agent sandbox. Errors are returned, never thrown. */
export interface FactoryTools {
  readonly specs: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface AgentRequest {
  /** Logical role, e.g. `plan_high`, `implement`, `review_plan`, `pr_writer`. */
  role: string;
  model: string;
  thinking?: ThinkingLevel;
  cwd: string;
  /** Role prompt (system instructions). */
  system: string;
  prompt: string;
  tools: ToolSet;
  /** Complete environment for agent tool processes (already allowlisted). */
  env: Record<string, string>;
  /** Factory-owned Pi config dir (`PI_CODING_AGENT_DIR`). */
  agentDir?: string;
  /** Sandbox for bash and the path guard for in-process tools; absent = unconfined. */
  jail?: Jail;
  /** Evaluator browser tools, added to the tool set; absent for every other role. */
  browser?: FactoryTools;
  /** `docs_lookup` (Context7) for roles that have it enabled; absent otherwise. */
  docs?: FactoryTools;
  /** Continue an earlier session with the same key (reviewers in round >= 2). */
  sessionKey?: string;
  signal?: AbortSignal;
  onActivity?: (activity: AgentActivity) => void;
}

export interface AgentResponse {
  text: string;
  usage: AgentUsage;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly usage: AgentUsage = ZERO_USAGE,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResponse>;
  /** Releases kept sessions. */
  close?(): Promise<void>;
}

/** Extracts the last JSON object from agent text (a fenced ```json block or a bare object). */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json|factory-plan)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.length ? fences.map((m) => m[1] ?? "").reverse() : [text];
  for (const c of candidates) {
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // try next candidate
        }
      }
    }
  }
  return undefined;
}
