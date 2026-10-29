import type { GitHub, PrStatus } from "../gh.js";
import { activeHolders } from "../pipeline/lock.js";
import { listRuns, type RunRecord } from "../runs.js";
import type { Io } from "./gates.js";
import type { z } from "zod";
import type { StatusReportSchema } from "../schemas/reports.js";

/** `factory status --json` (SPEC §9; schema `schemas/status.schema.json`). */
export type StatusReport = z.infer<typeof StatusReportSchema>;

const repoOf = (r: RunRecord) => r.state?.repo ?? r.result?.repo ?? "";
const taskOf = (r: RunRecord) => r.state?.task.ref ?? r.result?.task ?? "";

export async function statusReport(opts: { factoryHome: string; github: GitHub; now?: () => number }): Promise<StatusReport> {
  const now = opts.now?.() ?? Date.now();
  const holders = new Map(activeHolders(opts.factoryHome).filter((h) => h.runId).map((h) => [h.runId!, h.pid]));
  const report: StatusReport = { generated_at: new Date(now).toISOString(), running: [], waiting: [], interrupted: [], prs: [] };
  // PR states are looked up once per PR, and never for PRs `gc` already cleaned up.
  const prCache = new Map<string, Promise<PrStatus | Error>>();
  const prState = (r: RunRecord) => {
    const pr = r.state!.pr!;
    if (!prCache.has(pr)) prCache.set(pr, opts.github.prStatus(repoOf(r), pr).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
    return prCache.get(pr)!;
  };

  for (const r of listRuns(opts.factoryHome)) {
    const st = r.state;
    if (!st) continue; // `locked` attempts never got a state
    const pid = holders.get(r.run_id);
    if (pid !== undefined) {
      report.running.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step, lane: st.lane ?? "standard", pid,
        minutes: Math.round(((now - r.started_at.getTime()) / 60_000) * 10) / 10, branch: st.branch, pr: st.pr,
      });
      continue;
    }
    if (st.result === null && st.step !== "finished") {
      report.interrupted.push({ run_id: r.run_id, repo: st.repo, task: taskOf(r), step: st.step });
      continue;
    }
    let pr: PrStatus | Error | undefined;
    if (st.pr && !st.gc_at) pr = await prState(r);
    const closed = pr && !(pr instanceof Error) && pr.state !== "open";
    if ((st.result === "needs_human" || st.result === "needs_input") && !closed && !st.gc_at) {
      report.waiting.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), result: st.result, reason: st.reason,
        questions: r.result?.questions ?? [], pr: st.pr, branch: st.branch, worktree: st.worktree,
      });
    }
    if (st.pr && pr && !closed) {
      report.prs.push({
        run_id: r.run_id, repo: st.repo, task: taskOf(r), pr: st.pr,
        state: pr instanceof Error ? "unknown" : "open", draft: pr instanceof Error ? null : pr.draft,
        merge_policy: r.result?.merge_policy ?? null, risk: r.result?.risk ?? null, result: st.result,
        ...(pr instanceof Error ? { error: pr.message.slice(0, 200) } : {}),
      });
    }
  }
  return report;
}

export function renderStatus(s: StatusReport): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => out.push(`${title} (${lines.length})${lines.length ? `:\n${lines.map((l) => `  ${l}`).join("\n")}` : ""}`);
  section("running", s.running.map((r) => `${r.run_id} ${r.task} — ${r.step}, ${r.lane}, ${r.minutes} min (${r.repo})`));
  section("waiting", s.waiting.map((r) => `${r.run_id} ${r.task} — ${r.result}: ${r.reason}${r.pr ? ` ${r.pr}` : ""}`));
  section("interrupted", s.interrupted.map((r) => `${r.run_id} ${r.task} — stopped in ${r.step}; factory resume ${r.run_id}`));
  section("open PRs", s.prs.map((p) => `${p.pr} ${p.task} — ${p.state}${p.draft ? ", draft" : ""}, merge policy ${p.merge_policy ?? "?"}, risk ${p.risk ?? "?"}`));
  return out.join("\n") + "\n";
}

export async function statusCommand(opts: { factoryHome: string; github: GitHub; json: boolean }, io: Io): Promise<number> {
  const report = await statusReport(opts);
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderStatus(report));
  return 0;
}
