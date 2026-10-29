import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../events.js";
import { callAgent, type AgentCall, type RunDeps } from "../pipeline/context.js";
import { type RepoConfig, RepoConfigSchema } from "../schemas/repo.js";

export type OneShotDeps = Pick<RunDeps, "runner" | "profile" | "factoryHome" | "parentEnv" | "sleep" | "now" | "signal" | "sandbox" | "prompts" | "watchdogPollMs">;

/**
 * Agent calls outside a run (`adopt`, `harden`): same model chains, fallbacks, env allowlist, sandbox and
 * watchdog as in a run; events go to `<logDir>/events.jsonl` (not under `runs/`, so `stats`/`status`
 * do not see them). The agent HOME is a temp dir removed by `close`.
 */
export class OneShot {
  readonly events: EventLog;
  private readonly agentHome: string;
  private readonly deadline: number;

  constructor(
    private readonly deps: OneShotDeps,
    logDir: string,
    id: string,
    private readonly repo: RepoConfig = RepoConfigSchema.parse({}),
    minutes = 30,
  ) {
    mkdirSync(logDir, { recursive: true });
    this.events = new EventLog(logDir, id, deps.now);
    this.agentHome = mkdtempSync(join(tmpdir(), "factory-agent-home-"));
    this.deadline = (deps.now ?? Date.now)() + minutes * 60_000;
  }

  call(step: string, req: AgentCall) {
    // github is not used by agent calls; the cast keeps RunDeps' shape without a fake.
    const deps = { ...this.deps, github: undefined as never } satisfies RunDeps;
    return callAgent({ deps, repo: this.repo, agentHome: this.agentHome, events: this.events, deadline: this.deadline }, step, req);
  }

  close(): void {
    rmSync(this.agentHome, { recursive: true, force: true });
  }
}
