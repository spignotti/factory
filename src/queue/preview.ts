import { resolve } from "node:path";
import { loadRepoConfig } from "../schemas/repo.js";
import { rankPending } from "./admit.js";
import { readWorkerMode, type WorkerMode } from "./control.js";
import { loadAllQueues, type QueueFile } from "./store.js";

export interface PreviewLine {
  order: number;
  issue: number;
  /** `would_start` is the only row a later `queue run` would launch. */
  disposition: "would_start" | "waiting" | "running" | "held";
  detail: string;
}

export interface PreviewRepo {
  repo: string;
  max_runs: number;
  slots: number;
  running: number;
  room: number;
  lines: PreviewLine[];
}

export interface PreviewReport {
  /** This command does not write the queue, claim a lock, call GitHub, or start a run. */
  writes: false;
  mode: WorkerMode;
  slots: number;
  repos: PreviewRepo[];
}

function repoMaxRuns(repo: string): number {
  try {
    return loadRepoConfig(repo).concurrency.max_runs;
  } catch {
    return 1;
  }
}

function previewRepo(q: QueueFile, slotsLeft: { n: number }, slots: number, mode: WorkerMode): PreviewRepo {
  const maxRuns = repoMaxRuns(q.repo);
  const running = q.entries.filter((e) => e.status === "running").length;
  const room = Math.max(0, Math.min(slotsLeft.n, maxRuns - running));
  const lines: PreviewLine[] = [];
  let order = 1;
  for (const entry of q.entries) {
    if (entry.status !== "running") continue;
    lines.push({ order: order++, issue: entry.issue, disposition: "running", detail: entry.run_id ?? "no run id" });
  }
  const heldByMode = mode === "pause" || mode === "drain" || mode === "stop";
  const pending = q.entries.filter((e) => e.status === "pending" && e.bundled_with === undefined && e.after === undefined);
  const ranked = rankPending(
    pending.map((entry) => ({ issue: entry.issue, addedAt: entry.added_at, index: q.entries.indexOf(entry), priority: 1 })),
    Date.now(),
  );
  let left = heldByMode ? 0 : room;
  const chosen = new Set<number>();
  for (const choice of ranked) {
    chosen.add(choice.issue);
    if (heldByMode) {
      lines.push({ order: order++, issue: choice.issue, disposition: "held", detail: mode });
      continue;
    }
    if (left > 0) {
      lines.push({ order: order++, issue: choice.issue, disposition: "would_start", detail: `${choice.choice}; labels not read` });
      left -= 1;
      slotsLeft.n -= 1;
    } else {
      const atRepoCap = running >= maxRuns;
      lines.push({ order: order++, issue: choice.issue, disposition: "held", detail: atRepoCap ? "repo max_runs" : "global coding cap" });
    }
  }
  for (const entry of q.entries) {
    if (entry.status !== "pending" || chosen.has(entry.issue)) continue;
    if (entry.after !== undefined) {
      lines.push({ order: order++, issue: entry.issue, disposition: "waiting", detail: `after #${entry.after}` });
    } else if (entry.bundled_with !== undefined) {
      lines.push({ order: order++, issue: entry.issue, disposition: "held", detail: `bundled with #${entry.bundled_with}` });
    }
  }
  return { repo: q.repo, max_runs: maxRuns, slots, running, room: heldByMode ? 0 : room, lines };
}

/**
 * Local scheduling picture. GitHub admission still happens at start; this does not ask GitHub.
 * `Date.now` is only the fair-wait clock inside `rankPending`, and the text does not print it.
 */
export function previewQueues(factoryHome: string, opts: { repo?: string; slots: number }): PreviewReport {
  const mode = readWorkerMode(factoryHome);
  let files = loadAllQueues(factoryHome);
  if (opts.repo) {
    const want = resolve(opts.repo);
    files = files.filter((f) => resolve(f.repo) === want);
  }
  const slotsLeft = { n: opts.slots };
  return {
    writes: false,
    mode,
    slots: opts.slots,
    repos: files.map((q) => previewRepo(q, slotsLeft, opts.slots, mode)),
  };
}

export function renderPreview(report: PreviewReport): string {
  const lines = [
    "preview: no writes",
    `mode: ${report.mode}`,
    `slots: ${report.slots}`,
  ];
  if (!report.repos.length) lines.push("queues (0)");
  for (const repo of report.repos) {
    lines.push(repo.repo);
    lines.push(`  limits: max_runs ${repo.max_runs}, room ${repo.room}, running ${repo.running}`);
    if (!repo.lines.length) lines.push("  (nothing to start)");
    for (const row of repo.lines) {
      lines.push(`  ${row.order}  #${row.issue}  ${row.disposition}  ${row.detail}`);
    }
  }
  return lines.join("\n") + "\n";
}
