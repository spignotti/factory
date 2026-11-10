import { parseArgs } from "node:util";
import type { GitHub } from "../gh.js";
import { Interrupted } from "../interrupt.js";
import { spawnFactoryRun } from "../queue/spawn.js";
import {
  FACTORY_READY_LABEL,
  loadAllQueues,
  loadQueueByKey,
  NEEDS_PLAN_LABEL,
  repoQueueKey,
  updateQueue,
  type QueueEntry,
  type QueueFile,
} from "../queue/store.js";
import { DEFAULT_SLOTS, runQueue, type RunQueueOptions, type StartRun } from "../queue/worker.js";
import type { Io } from "./gates.js";

export interface QueueCommandDeps {
  factoryHome: string;
  github: GitHub;
  io: Io;
  signal?: AbortSignal;
  /** Tests inject a run starter. The CLI spawns `node dist/cli.js run`. */
  start?: StartRun;
  pollMs?: number;
  now?: () => number;
  sleep?: RunQueueOptions["sleep"];
}

export interface QueueListEntry {
  order: number;
  issue: number;
  status: QueueEntry["status"];
  after: number | null;
  run_id: string | null;
  pr: string | null;
  reason: string | null;
  requeues: number;
}

export interface QueueListReport {
  queues: { repo: string; entries: QueueListEntry[] }[];
}

function parseIssueList(raw: string[]): number[] | undefined {
  if (!raw.length) return undefined;
  const out: number[] = [];
  for (const s of raw) {
    if (!/^[1-9]\d*$/.test(s)) return undefined;
    out.push(Number(s));
  }
  return out;
}

function parseIssue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return parseIssueList([raw])?.[0];
}

/** Local `HH:MM`. A time already passed today is tomorrow, so an evening start can stop at 07:00. */
export function parseUntil(hhmm: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid --until ${hhmm} (use HH:MM)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid --until ${hhmm} (use HH:MM)`);
  const t = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() < now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function toList(q: QueueFile): QueueListReport["queues"][number] {
  return {
    repo: q.repo,
    entries: q.entries.map((e, i) => ({
      order: i + 1,
      issue: e.issue,
      status: e.status,
      after: e.after ?? null,
      run_id: e.run_id ?? null,
      pr: e.pr ?? null,
      reason: e.reason ?? null,
      requeues: e.requeues ?? 0,
    })),
  };
}

export function renderQueues(report: QueueListReport): string {
  if (!report.queues.length) return "queues (0)\n";
  const lines: string[] = [];
  for (const q of report.queues) {
    lines.push(q.repo);
    if (!q.entries.length) lines.push("  (empty)");
    for (const e of q.entries) {
      const bits = [`  ${e.order}`, `#${e.issue}`, e.status];
      if (e.status === "running" && e.run_id) bits.push(e.run_id);
      if (e.status === "done" && e.pr) bits.push(e.pr);
      if (e.status === "parked" && e.reason) bits.push(e.reason);
      if (e.status === "pending" && e.after !== null) bits.push(`after #${e.after}`);
      lines.push(bits.join("  "));
    }
  }
  return lines.join("\n") + "\n";
}

/** Appends issues in order. Refuses the whole add when any issue is closed, unlabelled, or `needs-plan`. */
export async function queueAdd(
  opts: { factoryHome: string; repo: string; issues: number[]; after?: number; github: GitHub },
  io: Io,
): Promise<number> {
  if (!opts.issues.length) {
    io.err("factory: at least one issue is required\n");
    return 2;
  }
  if (opts.after !== undefined && opts.issues.includes(opts.after)) {
    io.err("factory: --after cannot be one of the issues being added\n");
    return 2;
  }
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const n of opts.issues) {
    if (seen.has(n)) {
      problems.push(`#${n} is listed twice`);
      continue;
    }
    seen.add(n);
    let issue;
    try {
      issue = await opts.github.getIssue(opts.repo, n);
    } catch (e) {
      problems.push(`#${n}: ${(e as Error).message}`);
      continue;
    }
    if ((issue.state ?? "open") === "closed") problems.push(`#${n} is closed`);
    else if (!issue.labels.includes(FACTORY_READY_LABEL)) problems.push(`#${n} lacks the ${FACTORY_READY_LABEL} label`);
    else if (issue.labels.includes(NEEDS_PLAN_LABEL)) problems.push(`#${n} carries ${NEEDS_PLAN_LABEL}`);
  }
  if (problems.length) {
    io.err(`factory: ${problems.join("; ")}\n`);
    return 1;
  }
  try {
    await updateQueue(opts.factoryHome, opts.repo, (q) => {
      const active = new Set(q.entries.filter((e) => e.status !== "done").map((e) => e.issue));
      const dup = opts.issues.filter((n) => active.has(n));
      if (dup.length) throw new Error(`already queued: ${dup.map((n) => `#${n}`).join(", ")}`);
      const at = new Date().toISOString();
      for (const n of opts.issues) {
        q.entries.push({ issue: n, status: "pending", ...(opts.after !== undefined ? { after: opts.after } : {}), added_at: at });
      }
    });
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
  for (const n of opts.issues) io.out(`queued #${n}${opts.after !== undefined ? ` after #${opts.after}` : ""}\n`);
  return 0;
}

export async function queueRemove(opts: { factoryHome: string; repo: string; issues: number[] }, io: Io): Promise<number> {
  const key = await repoQueueKey(opts.repo);
  if (!loadQueueByKey(opts.factoryHome, key)) {
    io.err(`factory: no queue for ${opts.repo}\n`);
    return 1;
  }
  const missing: number[] = [];
  await updateQueue(opts.factoryHome, opts.repo, (q) => {
    for (const n of opts.issues) {
      const before = q.entries.length;
      q.entries = q.entries.filter((e) => e.issue !== n);
      if (q.entries.length === before) missing.push(n);
    }
  });
  if (missing.length) {
    io.err(`factory: not queued: ${missing.map((n) => `#${n}`).join(", ")}\n`);
    return 1;
  }
  for (const n of opts.issues) io.out(`removed #${n}\n`);
  return 0;
}

export async function queueList(opts: { factoryHome: string; repo?: string; json: boolean }, io: Io): Promise<number> {
  let files: QueueFile[];
  try {
    files = loadAllQueues(opts.factoryHome);
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
  if (opts.repo) {
    const key = await repoQueueKey(opts.repo);
    files = files.filter((f) => f.repo_key === key);
    if (!files.length) {
      io.err(`factory: no queue for ${opts.repo}\n`);
      return 1;
    }
  }
  const report: QueueListReport = { queues: files.map(toList) };
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderQueues(report));
  return 0;
}

function exitFromSignal(signal?: AbortSignal): number {
  const reason: unknown = signal?.reason;
  if (reason instanceof Interrupted) return reason.signalName === "SIGINT" ? 130 : 143;
  return 0;
}

export async function queueRun(
  opts: { factoryHome: string; github: GitHub; repo?: string; slots: number; untilMs?: number; signal?: AbortSignal; start?: StartRun; pollMs?: number; now?: () => number; sleep?: RunQueueOptions["sleep"] },
  io: Io,
): Promise<number> {
  if (opts.repo) {
    const key = await repoQueueKey(opts.repo);
    if (!loadQueueByKey(opts.factoryHome, key)) {
      io.err(`factory: no queue for ${opts.repo}\n`);
      return 1;
    }
  }
  try {
    await runQueue({
      factoryHome: opts.factoryHome,
      github: opts.github,
      repo: opts.repo,
      slots: opts.slots,
      untilMs: opts.untilMs,
      signal: opts.signal,
      start: opts.start ?? ((req) => spawnFactoryRun(req)),
      io,
      pollMs: opts.pollMs,
      now: opts.now,
      sleep: opts.sleep,
    });
  } catch (e) {
    io.err(`factory: ${(e as Error).message}\n`);
    return 1;
  }
  return exitFromSignal(opts.signal);
}

export async function queueCommand(argv: string[], deps: QueueCommandDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "add" || sub === "remove") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { repo: { type: "string" }, after: { type: "string" } },
    });
    const issues = parseIssueList(positionals);
    const after = parseIssue(values.after);
    if (!values.repo || !issues || (values.after !== undefined && after === undefined)) {
      deps.io.err("factory: usage: factory queue add|remove --repo <path> <issue...>\n");
      return 2;
    }
    if (sub === "remove") return queueRemove({ factoryHome: deps.factoryHome, repo: values.repo, issues }, deps.io);
    return queueAdd({ factoryHome: deps.factoryHome, repo: values.repo, issues, after, github: deps.github }, deps.io);
  }
  if (sub === "list") {
    const { values } = parseArgs({
      args: rest,
      options: { repo: { type: "string" }, json: { type: "boolean", default: false } },
    });
    return queueList({ factoryHome: deps.factoryHome, repo: values.repo, json: values.json }, deps.io);
  }
  if (sub === "run") {
    const { values } = parseArgs({
      args: rest,
      options: { repo: { type: "string" }, slots: { type: "string" }, until: { type: "string" } },
    });
    const slots = values.slots === undefined ? DEFAULT_SLOTS : Number(values.slots);
    if (!Number.isInteger(slots) || slots < 1 || slots > 32) {
      deps.io.err(`factory: invalid --slots ${values.slots ?? ""}\n`);
      return 2;
    }
    let untilMs: number | undefined;
    if (values.until !== undefined) {
      try {
        untilMs = parseUntil(values.until, deps.now ? new Date(deps.now()) : new Date());
      } catch (e) {
        deps.io.err(`factory: ${(e as Error).message}\n`);
        return 2;
      }
    }
    return queueRun(
      {
        factoryHome: deps.factoryHome,
        github: deps.github,
        repo: values.repo,
        slots,
        untilMs,
        signal: deps.signal,
        start: deps.start,
        pollMs: deps.pollMs,
        now: deps.now,
        sleep: deps.sleep,
      },
      deps.io,
    );
  }
  deps.io.err("factory: usage: factory queue add|list|remove|run\n");
  return sub === undefined || sub === "--help" ? 0 : 2;
}
