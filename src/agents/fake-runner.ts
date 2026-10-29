import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AgentError, type AgentRequest, type AgentResponse, type AgentRunner, ZERO_USAGE } from "./runner.js";

const UsageSchema = z.object({
  tokens_in: z.number().default(0),
  tokens_out: z.number().default(0),
  cost_usd: z.number().default(0),
});

export const FakeStepSchema = z.object({
  role: z.string(),
  /** Asserts the model the factory selected for this call. */
  model: z.string().optional(),
  /** JSON output, returned as a fenced json block. */
  output: z.unknown().optional(),
  /** Raw text output (e.g. an invalid handoff). */
  raw: z.string().optional(),
  /** Files written into the session cwd; `null` deletes. */
  writes: z.record(z.string(), z.string().nullable()).optional(),
  error: z.object({ message: z.string(), status: z.number().optional(), retry_after_ms: z.number().optional() }).optional(),
  usage: UsageSchema.optional(),
  /** Slow-but-active session: emits heartbeats while sleeping between them. */
  heartbeats: z.object({ count: z.number().int().min(1), interval_ms: z.number().min(0) }).optional(),
  /** Browser tool calls (evaluator) run in order before the output; results are recorded in the call. */
  tool_calls: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).optional(),
  /** Hangs (no events) for this long. */
  silent_ms: z.number().optional(),
});
export type FakeStep = z.infer<typeof FakeStepSchema>;

export const FakeScriptSchema = z.object({ steps: z.array(FakeStepSchema) });

export interface FakeCall {
  role: string;
  model: string;
  thinking?: string;
  tools: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  sessionKey?: string;
  /** Results of scripted browser tool calls. */
  toolResults?: { tool: string; text: string; isError?: boolean }[];
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Deterministic AgentRunner scripted from fixture files. Steps are consumed in order per role;
 * a call without a remaining step for its role fails loudly.
 */
export class FakeRunner implements AgentRunner {
  readonly calls: FakeCall[] = [];
  private readonly queues = new Map<string, FakeStep[]>();

  constructor(
    steps: FakeStep[],
    private readonly sleep: Sleep = realSleep,
  ) {
    for (const s of steps) {
      const q = this.queues.get(s.role) ?? [];
      q.push(s);
      this.queues.set(s.role, q);
    }
  }

  static fromFile(path: string, sleep?: Sleep): FakeRunner {
    return new FakeRunner(FakeScriptSchema.parse(JSON.parse(readFileSync(path, "utf8"))).steps, sleep);
  }

  /** Steps not consumed yet, per role. */
  remaining(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [role, q] of this.queues) if (q.length) out[role] = q.length;
    return out;
  }

  async run(req: AgentRequest): Promise<AgentResponse> {
    this.calls.push({
      role: req.role,
      model: req.model,
      thinking: req.thinking,
      tools: req.tools,
      cwd: req.cwd,
      env: { ...req.env },
      prompt: req.prompt,
      sessionKey: req.sessionKey,
    });
    const step = this.queues.get(req.role)?.shift();
    if (!step) throw new Error(`fake-runner: no scripted step left for role ${req.role}`);
    if (step.model !== undefined && step.model !== req.model) {
      throw new Error(`fake-runner: role ${req.role} expected model ${step.model}, got ${req.model}`);
    }
    if (step.heartbeats) {
      for (let i = 0; i < step.heartbeats.count; i++) {
        await this.sleep(step.heartbeats.interval_ms, req.signal);
        req.onActivity?.({ kind: "heartbeat" });
      }
    }
    if (step.silent_ms !== undefined) await this.sleep(step.silent_ms, req.signal);
    const usage = step.usage ? UsageSchema.parse(step.usage) : ZERO_USAGE;
    if (step.error) throw new AgentError(step.error.message, usage, step.error.status, step.error.retry_after_ms);
    if (step.tool_calls) {
      if (!req.browser) throw new Error(`fake-runner: role ${req.role} has no browser tools for tool_calls`);
      const results: NonNullable<FakeCall["toolResults"]> = [];
      for (const c of step.tool_calls) {
        const r = await req.browser.call(c.tool, c.args);
        results.push({ tool: c.tool, text: r.text, ...(r.isError ? { isError: true } : {}) });
      }
      this.calls[this.calls.length - 1]!.toolResults = results;
    }
    for (const [path, content] of Object.entries(step.writes ?? {})) {
      const full = join(req.cwd, path);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    req.onActivity?.({ kind: "progress", detail: "done" });
    const text = step.raw ?? (step.output !== undefined ? "```json\n" + JSON.stringify(step.output, null, 2) + "\n```" : "");
    return { text, usage };
  }
}
