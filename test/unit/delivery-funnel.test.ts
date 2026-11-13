import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus, statusReport } from "../../src/commands/status.js";
import { FakeGitHub } from "../../src/gh.js";
import type { FactoryEvent } from "../../src/events.js";
import { resolveInterval, successfulRecoveries, ticketFunnel, type FunnelPrState, type FunnelSource } from "../../src/pipeline/accounting.js";
import { StatusReportSchema } from "../../src/schemas/reports.js";

const INTERVAL = { from: Date.parse("2026-11-14T00:00:00.000Z"), to: Date.parse("2026-11-15T00:00:00.000Z"), timezone: "UTC" };

function source(over: Partial<FunnelSource> & Pick<FunnelSource, "run_id">): FunnelSource {
  return {
    ticket: null,
    first_attempt: null,
    finished: null,
    merged_stored: "unknown",
    has_outcome: true,
    pr: null,
    pr_state: null,
    merge_status_unknown: false,
    merge_policy: null,
    unresolved_decision: false,
    recoveries: 0,
    ...over,
  };
}

const PR = (n: number) => `https://gh.test/pull/${n}`;
const pr = (over: Partial<FunnelPrState> & Pick<FunnelPrState, "state">): FunnelPrState => ({ draft: false, ci: "green", behind: false, conflicting: false, ...over });

/** UTC ms when the local calendar day `Y-M-D` begins in the IANA zone. */
function localDayUtc(y: number, mo: number, d: number, tz: string): number {
  const day = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms));
    const get = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const naive = Date.UTC(y, mo - 1, d);
  for (let off = -14; off <= 14; off++) {
    const t = naive + off * 3_600_000;
    if (day(t) === `${y}-${mo}-${d}` && day(t - 3_600_000) !== `${y}-${mo}-${d}`) return t;
  }
  throw new Error("no local day start");
}

function agentEvent(event: FactoryEvent["event"], role: string | null, data: Record<string, unknown> = {}): FactoryEvent {
  return { ts: "2026-11-14T01:00:00.000Z", run_id: "rec", step: "implement", event, role, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data };
}

describe("delivery funnel (#185)", () => {
  it("keys tickets and merge keys by repository plus issue, so the same number in two repos does not collapse", () => {
    const alpha = "/repos/alpha";
    const beta = "/repos/beta";
    const merged = (repo: string, id: string) => source({
      run_id: id,
      repo,
      ticket: 7,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(7),
      pr_state: pr({ state: "merged" }),
      merged_stored: "confirmed",
    });
    const blocked = (repo: string, id: string) => source({
      run_id: id,
      repo,
      ticket: 3,
      first_attempt: INTERVAL.from + 3,
      finished: INTERVAL.from + 4,
      pr: PR(3),
      pr_state: pr({ state: "open", ci: "red" }),
      merged_stored: "no",
    });
    const unread = (repo: string, id: string) => source({
      run_id: id,
      repo,
      ticket: 4,
      first_attempt: INTERVAL.from + 5,
      finished: INTERVAL.from + 6,
      pr: PR(4),
      pr_state: null,
      merge_status_unknown: true,
      merged_stored: "no",
    });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [merged(alpha, "a1"), merged(beta, "b1"), blocked(alpha, "a2"), blocked(beta, "b2"), unread(alpha, "a3"), unread(beta, "b3")],
      queue: [
        { repo: alpha, ticket: 8, added: INTERVAL.from - 10, unfinished: true },
        { repo: beta, ticket: 8, added: INTERVAL.from - 10, unfinished: true },
        { repo: alpha, ticket: 9, added: INTERVAL.from + 1, unfinished: true },
        { repo: beta, ticket: 9, added: INTERVAL.from + 1, unfinished: true },
      ],
    });
    // 7, 3 and 4 in each repo, plus queue #9 in each. Parked #8 is before the interval and not offered again.
    expect(funnel.admitted_tickets).toBe(6);
    expect(funnel.offered_tickets).toBe(8);
    expect(funnel.first_attempted_in_interval).toBe(6);
    expect(funnel.backlog_parked_before).toBe(2);
    expect(funnel.merges.confirmed).toBe(2);
    expect(funnel.blocker_prs).toBe(4);
    expect(funnel.blockers).toEqual(expect.arrayContaining([
      { reason: "CI red", cls: "ci_runner", prs: 2, tickets: 2 },
      { reason: "pr status unknown", cls: "unclassified", prs: 2, tickets: 2 },
    ]));
    // Same PR string, two repositories: unknown merge status stays two PRs, not one collapsed key.
    expect(funnel.unknowns.merge_status).toBe(2);
  });

  it("counts offered and admitted tickets, deduplicates attempts and blockers, keeps unknowns unknown", () => {
    const s1 = source({ run_id: "a", ticket: 1, first_attempt: INTERVAL.from + 10, finished: INTERVAL.from + 20, has_outcome: true });
    const s2 = source({ run_id: "b", ticket: 2, first_attempt: INTERVAL.from + 15, finished: INTERVAL.from + 30 });
    // A repeated attempt of ticket 2 under a different run id: one ticket, two attempts.
    const s3 = source({ run_id: "c", ticket: 2, first_attempt: INTERVAL.from - 500, finished: INTERVAL.from + 40 });
    // The same run id twice (a re-read of one record): one attempt, the later row wins.
    const s4 = source({ run_id: "d", ticket: 3, first_attempt: INTERVAL.from + 5, finished: INTERVAL.from + 6 });
    const s5 = source({ run_id: "d", ticket: 3, first_attempt: INTERVAL.from + 5, finished: INTERVAL.from + 9, pr: PR(9), pr_state: pr({ state: "merged" }), merged_stored: "confirmed" });
    // Ticket unknown: counted as unknown, never as a ticket. No outcome at all: legacy unknown outcome.
    const s6 = source({ run_id: "e", ticket: "unknown", first_attempt: INTERVAL.from + 7, has_outcome: false, pr: PR(13), pr_state: null, merge_status_unknown: true });
    // A task without a ticket at all (text task): still a blocker row, no ticket counted.
    const s7 = source({ run_id: "f", ticket: null, first_attempt: INTERVAL.from + 8, finished: INTERVAL.from + 8.5, pr: PR(10), pr_state: pr({ state: "open", ci: "red" }), merged_stored: "no" });
    // Same ticket and same PR twice: the blocker and its reason class count once.
    const s8 = source({ run_id: "g", ticket: 4, first_attempt: INTERVAL.from + 9, pr: PR(11), pr_state: pr({ state: "open", ci: "pending" }), merged_stored: "no" });
    const s9 = source({ run_id: "h", ticket: 4, first_attempt: INTERVAL.from + 9, pr: PR(11), pr_state: pr({ state: "open", ci: "pending" }), merged_stored: "no" });
    // A waiting decision without a PR is a blocker with zero PRs.
    const s10 = source({ run_id: "i", ticket: 5, first_attempt: INTERVAL.from + 11, unresolved_decision: true, merged_stored: "no" });
    // Finished before the interval: out.
    const out = source({ run_id: "j", ticket: 6, first_attempt: INTERVAL.from - 100, finished: INTERVAL.from - 50 });

    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, out],
      queue: [{ ticket: 7, added: INTERVAL.from + 1, unfinished: true }, { ticket: 6, added: INTERVAL.from - 1, unfinished: false }],
    });
    expect(funnel.interval).toEqual({ from: "2026-11-14T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z", timezone: "UTC" });
    expect(funnel.offered_tickets).toBe(6); // 1,2,3,4,5 plus queue #7; 6 finished before the interval
    expect(funnel.admitted_tickets).toBe(5); // 207 was offered as work, never attempted
    expect(funnel.attempts).toBe(9); // a..i distinct run ids, j excluded, "d" once
    expect(funnel.first_attempted_in_interval).toBe(4); // tickets 1, 3, 4, 5
    expect(funnel.work_first_attempted_before).toBe(1); // ticket 2 (run c started before)
    expect(funnel.backlog_parked_before).toBe(0);
    expect(funnel.unknowns).toEqual({ tickets: 1, first_attempts: 0, merge_status: 1, outcomes: 1, queues: 0 });
    expect(funnel.merges).toEqual({ confirmed: 1, github_only: 0, closed_without_merge: 0 });
    expect(funnel.ready_awaiting_approval).toEqual({ prs: 0, tickets: 0 });
    expect(funnel.blocker_prs).toBe(3); // PR(10), PR(11), PR(13)
    expect(funnel.blockers).toEqual([
      { reason: "CI pending", cls: "ci_runner", prs: 1, tickets: 1 },
      { reason: "CI red", cls: "ci_runner", prs: 1, tickets: 0 },
      { reason: "needs_human", cls: "human_decision", prs: 0, tickets: 1 },
      { reason: "pr status unknown", cls: "unclassified", prs: 1, tickets: 0 },
    ]);
    expect(funnel.recovered_without_human).toBe(0);
    expect(funnel.idle_slot_minutes).toBeNull(); // no waited_ms data: unknown, not zero
  });

  it("separates ready PRs, github-only merges, closed PRs and recoveries; idle slot stays unknown without an idle-slot event", () => {
    const ready = source({ run_id: "r1", ticket: 20, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 1, pr: PR(20), pr_state: pr({ state: "open" }), merge_policy: "human_review", merged_stored: "no" });
    const draft = source({ run_id: "r2", ticket: 21, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 1, pr: PR(21), pr_state: pr({ state: "open", draft: true }), merge_policy: "human_review", merged_stored: "no" });
    const extMerge = source({ run_id: "r3", ticket: 22, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 1, pr: PR(22), pr_state: pr({ state: "merged" }), merged_stored: "no" });
    const unconfirmed = source({ run_id: "r4", ticket: 23, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 1, pr: PR(23), pr_state: pr({ state: "merged" }), merged_stored: "unknown", has_outcome: false });
    const closed = source({ run_id: "r5", ticket: 24, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 1, pr: PR(24), pr_state: pr({ state: "closed" }), merged_stored: "no" });
    // Recovery counts only when the attempt finished (an outcome is stored).
    const recovered = source({ run_id: "r6", ticket: 25, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, recoveries: 2, merged_stored: "no" });
    const recoveredButStuck = source({ run_id: "r7", ticket: 26, first_attempt: INTERVAL.from + 1, recoveries: 1, unresolved_decision: true, merged_stored: "no" });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [ready, draft, extMerge, unconfirmed, closed, recovered, recoveredButStuck],
      queue: [{ ticket: 30, added: INTERVAL.from + 5, unfinished: true }],
    });
    expect(funnel.ready_awaiting_approval).toEqual({ prs: 1, tickets: 1 });
    // A GitHub merge never proves factory provenance: only a `confirmed` stored outcome lands in `confirmed`.
    expect(funnel.merges).toMatchObject({ confirmed: 0, github_only: 2, closed_without_merge: 1 });
    expect(funnel.unknowns).toMatchObject({ tickets: 0, outcomes: 1, merge_status: 0 });
    expect(funnel.blockers).toEqual([
      { reason: "draft", cls: "human_decision", prs: 1, tickets: 1 },
      { reason: "needs_human", cls: "human_decision", prs: 0, tickets: 1 },
    ]);
    // Two proved recoveries on one finished run: count recoveries, not the run.
    expect(funnel.recovered_without_human).toBe(2);
    // No run recorded waited_ms: idle slot stays unknown, not zero.
    expect(funnel.idle_slot_minutes).toBeNull();

    const withWaits = ticketFunnel({
      interval: INTERVAL,
      sources: [
        source({ run_id: "w1", ticket: 40, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, merged_stored: "no" }),
        source({ run_id: "w2", ticket: 41, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, merged_stored: "no" }),
      ],
      queue: [{ ticket: 30, added: INTERVAL.from - 1, unfinished: true }],
    });
    // Lock-wait minutes are not idle-slot time, even when work is still unfinished.
    expect(withWaits.idle_slot_minutes).toBeNull();
    const recorded = ticketFunnel({
      interval: INTERVAL,
      sources: [source({ run_id: "w1", ticket: 40, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, merged_stored: "no", idle_slot_minutes: 3 })],
      queue: [],
    });
    expect(recorded.idle_slot_minutes).toBe(3);
  });

  it("the interval is explicit in the timezone: a cross-midnight completion counts where it finished", () => {
    const berlin14 = localDayUtc(2026, 11, 14, "Europe/Berlin");
    const berlin13 = localDayUtc(2026, 11, 13, "Europe/Berlin");
    expect([berlin13, berlin14]).toEqual([Date.UTC(2026, 10, 12, 23, 0), Date.UTC(2026, 10, 13, 23, 0)]);
    const now = berlin14 + 2 * 3_600_000;
    const interval = resolveInterval(now, 24 * 3_600_000, "Europe/Berlin");
    expect(interval).toEqual({ from: now - 24 * 3_600_000, to: now, timezone: "Europe/Berlin" });

    // Started 2026-11-13 00:40 Berlin, merged 2026-11-14 00:20 Berlin.
    const cross = source({
      run_id: "x",
      ticket: 50,
      first_attempt: berlin13 + 40 * 60_000,
      finished: berlin14 + 20 * 60_000,
      merged_stored: "confirmed",
      pr: PR(50),
      pr_state: pr({ state: "merged" }),
    });
    const inDay14 = ticketFunnel({ interval: { from: berlin14, to: berlin14 + 86_400_000, timezone: "Europe/Berlin" }, sources: [cross], queue: [] });
    expect(inDay14.admitted_tickets).toBe(1);
    expect(inDay14.merges.confirmed).toBe(1);
    expect(inDay14.work_first_attempted_before).toBe(1);
    expect(inDay14.first_attempted_in_interval).toBe(0);

    const inDay13 = ticketFunnel({ interval: { from: berlin13, to: berlin13 + 86_400_000, timezone: "Europe/Berlin" }, sources: [cross], queue: [] });
    expect(inDay13.attempts).toBe(0);
    expect(inDay13.merges.confirmed).toBe(0);
  });

  it("factory status --since reports the funnel in JSON and text, over fixture runs", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-status-"));
    const repo = "/tmp/funnel-repo";
    const now = Date.UTC(2026, 10, 13, 12, 0); // inside the Berlin day 2026-11-13 = 2026-11-12T23:00Z .. 2026-11-13T23:00Z
    const write = (id: string, o: {
      result: string;
      ticket: number | null | "omit";
      attempts?: number;
      pr?: string | null;
      policy?: string;
      merged?: "no" | "confirmed";
      events?: string[];
    }) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      const outcome = o.ticket === "omit" ? {} : {
        outcome: {
          ticket: o.ticket,
          attempts: o.attempts ?? null,
          delivered_pr: o.pr ?? null,
          merged: o.merged ?? "no",
          ended_without_merge: o.merged !== "confirmed",
          open_decision: o.result === "needs_human",
        },
      };
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `issue #${o.ticket ?? 0}`, labels: [] }, no_pr: false,
        step: "finished", result: o.result, reason: o.result === "needs_human" ? "needs a decision" : "",
        branch: null, worktree: null, pr: o.pr ?? null,
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        run_id: id, repo, task: `issue #${o.ticket ?? 0}`, type: "feature", lane: "standard", result: o.result,
        risk: "low", merge_policy: o.policy ?? "human_review", pr: o.pr ?? null, rounds: 1, minutes: 2, cost_usd: 0,
        reason: "", branch: null, worktree: null, run_dir: dir, ...outcome,
      }));
      if (o.events?.length) writeFileSync(join(dir, "events.jsonl"), o.events.join("\n") + "\n");
    };
    const ev = (id: string, event: string, ts: string, data: Record<string, unknown> = {}, role: string | null = null) =>
      JSON.stringify({ ts, run_id: id, step: "implement", event, role, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data });

    // Repeated attempts for ticket 201: first run parked before the interval, second done with an open ready PR.
    write("20261112-100000-f10001", { result: "needs_human", ticket: 201, attempts: 1, events: [ev("20261112-100000-f10001", "run_finished", "2026-11-12T10:01:00Z")] });
    write("20261113-080000-f10002", { result: "done", ticket: 201, attempts: 2, pr: PR(201), events: [ev("20261113-080000-f10002", "run_finished", "2026-11-13T08:00:00Z")] });
    // Cross-midnight inside the Berlin day: started 2026-11-12 23:40 Berlin (22:40Z), merged 2026-11-13 00:20 Berlin (23:20Z).
    write("20261112-224000-f10003", { result: "done", ticket: 202, attempts: 1, pr: PR(202), policy: "auto", merged: "confirmed", events: [ev("20261112-224000-f10003", "run_finished", "2026-11-12T23:20:00Z", { merged_at: "2026-11-12T23:20:00Z" })] });
    // Unknown provenance: no stored outcome (legacy), GitHub says merged.
    write("20261113-090000-f10004", { result: "done", ticket: "omit", pr: PR(203) });
    // Partial GitHub failure: PR 204 cannot be read.
    write("20261113-100000-f10005", { result: "done", ticket: 205, attempts: 1, pr: PR(204), events: [ev("20261113-100000-f10005", "run_finished", "2026-11-13T10:00:00Z")] });
    // Successful automatic recovery: a stream retry finished by the following agent call, plus a capacity wait.
    write("20261113-110000-f10006", {
      result: "done", ticket: 206, attempts: 1,
      events: [
        ev("20261113-110000-f10006", "queued", "2026-11-13T10:50:00Z", { waited_ms: 120000 }),
        ev("20261113-110000-f10006", "agent_error", "2026-11-13T11:00:00Z", { class: "stream" }, "implement"),
        ev("20261113-110000-f10006", "step_retry", "2026-11-13T11:01:00Z", { class: "stream", attempt: 1, max: 2 }, "implement"),
        ev("20261113-110000-f10006", "agent_finished", "2026-11-13T11:29:00Z", {}, "implement"),
        ev("20261113-110000-f10006", "run_finished", "2026-11-13T11:30:00Z"),
      ],
    });

    // Queue: one ticket parked before the Berlin day (still unfinished), one offered inside it.
    mkdirSync(join(home, "queue"), { recursive: true });
    writeFileSync(join(home, "queue", "r.json"), JSON.stringify({
      version: 1, repo, repo_key: "r",
      entries: [
        { issue: 199, status: "done", added_at: "2026-11-01T10:00:00.000Z" },
        { issue: 201, status: "running", added_at: "2026-11-12T09:00:00.000Z", run_id: "20261113-080000-f10002" },
        { issue: 207, status: "pending", added_at: "2026-11-13T12:00:00.000Z" },
      ],
    }));

    const gh = new FakeGitHub();
    gh.prStates.set(PR(201), { state: "open", draft: false, ci: "green" });
    gh.prStates.set(PR(202), { state: "merged", draft: false, ci: "green" });
    gh.prStates.set(PR(203), { state: "merged", draft: false, ci: "green" });
    // PR(204) intentionally absent: prStatus throws — a partial API failure.

    const report = await statusReport({ factoryHome: home, github: gh, since: "24h", timezone: "Europe/Berlin", now: () => now });
    StatusReportSchema.parse(report);
    expect(report.since).not.toBeNull();
    const f = report.since!.funnel!;
    expect(f).toMatchObject({
      interval: { from: "2026-11-12T12:00:00.000Z", to: "2026-11-13T12:00:00.000Z", timezone: "Europe/Berlin" },
      backlog_parked_before: 1, // ticket 201 was queued before the window, still unfinished, and its first attempt was earlier
    });
    // 201, 202, 205, 206 attempted inside (203 has no stored ticket), 207 offered by the queue at the read.
    expect(f.offered_tickets).toBe(5);
    expect(f.admitted_tickets).toBe(4);
    expect(f.attempts).toBe(5); // four run ids finishing in the interval plus the legacy row started inside; the pre-interval attempt of 201 is out
    expect(f.first_attempted_in_interval).toBe(3); // 202, 205, 206; 201's first attempt is before the window
    expect(f.work_first_attempted_before).toBe(1);
    expect(f.unknowns.tickets).toBe(1); // the legacy run has no ticket
    expect(f.unknowns.merge_status).toBe(1); // PR(204) could not be read
    expect(f.merges).toEqual({ confirmed: 1, github_only: 1, closed_without_merge: 0 });
    expect(f.factory_provenance).toBeNull();
    expect(f.ready_awaiting_approval).toEqual({ prs: 1, tickets: 1 }); // PR 201, human_review, open, green, ready
    expect(f.blocker_prs).toBe(1); // PR(204) with an unreadable status
    expect(f.blockers.map((b) => [b.reason, b.cls])).toEqual([["pr status unknown", "unclassified"]]);
    expect(f.recovered_without_human).toBe(1); // stream retry finished by agent_finished, run done
    expect(f.idle_slot_minutes).toBeNull(); // waited_ms is a lock wait, not an idle-slot event

    const text = renderStatus(report);
    expect(text).toContain("funnel 2026-11-12T12:00:00.000Z .. 2026-11-13T12:00:00.000Z (Europe/Berlin):");
    expect(text).toContain("offered 5");
    expect(text).toContain("merged 1 confirmed (provenance unknown; GitHub merged without stored confirmation 1; closed without merge 0)");
    expect(text).toContain("idle slot unknown");
    expect(text).not.toContain("factory-confirmed");
    expect(text).toContain("blocking PR 1: pr status unknown (unclassified, 1 tickets, 1 PR)");
  });

  it("rejects an invalid timezone instead of silently falling back", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-tz-"));
    await expect(statusReport({ factoryHome: home, github: new FakeGitHub(), since: "24h", timezone: "Not/AZone", now: () => Date.UTC(2026, 10, 14) })).rejects.toThrow(/Europe\/Berlin/);
  });

  it("the --since interval ends at the read and looks backward in the named timezone", () => {
    const now = Date.parse("2026-11-14T15:00:00.000Z");
    expect(resolveInterval(now, 12 * 3_600_000, "Europe/Berlin")).toEqual({
      from: now - 12 * 3_600_000,
      to: now,
      timezone: "Europe/Berlin",
    });
    // A week is the previous seven days, not seven days into the future.
    expect(resolveInterval(now, 7 * 86_400_000, "Europe/Berlin").from).toBe(now - 7 * 86_400_000);
    expect(resolveInterval(now, 7 * 86_400_000, "Europe/Berlin").to).toBe(now);
  });

  it("dedupes a repeated confirmed merge, and open, CI-pending or merely done is never merged", () => {
    const merged = pr({ state: "merged", ci: "green" });
    const again = source({
      run_id: "m1",
      ticket: 8,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(8),
      pr_state: merged,
      merged_stored: "confirmed",
    });
    const repeat = source({ ...again, run_id: "m2", finished: INTERVAL.from + 3 });
    const open = source({
      run_id: "m3",
      ticket: 9,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(9),
      pr_state: pr({ state: "open", ci: "green" }),
      merged_stored: "confirmed",
      merge_policy: "human_review",
    });
    const pending = source({
      run_id: "m4",
      ticket: 10,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(10),
      pr_state: pr({ state: "merged", ci: "pending" }),
      merged_stored: "confirmed",
    });
    const doneOnly = source({
      run_id: "m5",
      ticket: 11,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(11),
      pr_state: pr({ state: "open", ci: "green" }),
      merged_stored: "no",
      merge_policy: "auto",
    });
    const githubOnlyRepeat = source({
      run_id: "m6",
      ticket: 12,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(12),
      pr_state: merged,
      merged_stored: "no",
    });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [again, repeat, open, pending, doneOnly, githubOnlyRepeat, source({ ...githubOnlyRepeat, run_id: "m7" })],
      queue: [{ ticket: 11, added: INTERVAL.from - 5, unfinished: false }],
    });
    expect(funnel.attempts).toBe(7);
    expect(funnel.merges).toEqual({ confirmed: 1, github_only: 1, closed_without_merge: 0 });
    expect(funnel.factory_provenance).toBeNull();
    expect(funnel.ready_awaiting_approval).toEqual({ prs: 1, tickets: 1 });
    expect(funnel.unknowns.merge_status).toBe(1);
  });

  it("keeps pre-interval backlog out of first attempts, and idle time unknown without an idle-slot event", () => {
    const started = source({
      run_id: "s",
      ticket: 70,
      first_attempt: INTERVAL.from + 5,
      finished: INTERVAL.from + 6,
      merged_stored: "no",
    });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [started],
      queue: [
        { ticket: 70, added: INTERVAL.from - 50, unfinished: true },
        { ticket: 71, added: INTERVAL.from - 40, unfinished: true },
        { ticket: 72, added: INTERVAL.from + 1, unfinished: true },
      ],
    });
    expect(funnel.first_attempted_in_interval).toBe(1);
    expect(funnel.backlog_parked_before).toBe(1);
    expect(funnel.offered_tickets).toBe(2);
    expect(funnel.admitted_tickets).toBe(1);
    expect(funnel.idle_slot_minutes).toBeNull();
  });

  it("fixture: repeated attempts, cross-midnight finish, unknown provenance, partial API failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-regress-"));
    const repo = "/tmp/funnel-regress";
    // 02:00 Berlin on 2026-11-14. A 6h window reaches back across local midnight.
    const now = Date.parse("2026-11-14T01:00:00.000Z");
    const write = (id: string, o: {
      result: string;
      ticket: number | null | "omit";
      pr?: string | null;
      policy?: string;
      merged?: "no" | "confirmed";
      reason?: string;
      events?: string[];
    }) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      const outcome = o.ticket === "omit" ? {} : {
        outcome: {
          ticket: o.ticket,
          attempts: 1,
          delivered_pr: o.pr ?? null,
          merged: o.merged ?? "no",
          ended_without_merge: o.merged !== "confirmed",
          open_decision: o.result === "needs_human",
        },
      };
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `issue #${o.ticket ?? 0}`, labels: [] }, no_pr: false,
        step: "finished", result: o.result, reason: o.reason ?? "", branch: null, worktree: null, pr: o.pr ?? null,
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        run_id: id, repo, task: `issue #${o.ticket ?? 0}`, type: "feature", lane: "standard", result: o.result,
        risk: "low", merge_policy: o.policy ?? "human_review", pr: o.pr ?? null, rounds: 1, minutes: 1, cost_usd: 0,
        reason: o.reason ?? "", branch: null, worktree: null, run_dir: dir, ...outcome,
      }));
      if (o.events?.length) writeFileSync(join(dir, "events.jsonl"), o.events.join("\n") + "\n");
    };
    const ev = (id: string, event: string, ts: string, data: Record<string, unknown> = {}, role: string | null = null) =>
      JSON.stringify({ ts, run_id: id, step: "implement", event, role, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data });

    // Repeated attempts, one PR: two runs, one confirmed merge.
    write("20261113-200000-aa0001", {
      result: "done", ticket: 301, pr: PR(301), policy: "auto", merged: "confirmed",
      events: [ev("20261113-200000-aa0001", "run_finished", "2026-11-13T20:30:00Z", { merged_at: "2026-11-13T20:30:00Z" })],
    });
    write("20261113-210000-aa0002", {
      result: "done", ticket: 301, pr: PR(301), policy: "auto", merged: "confirmed",
      events: [ev("20261113-210000-aa0002", "run_finished", "2026-11-13T21:10:00Z", { merged_at: "2026-11-13T21:10:00Z" })],
    });
    // Cross-midnight: started before the window, merged after Berlin midnight, inside the window.
    write("20261113-180000-aa0003", {
      result: "done", ticket: 302, pr: PR(302), policy: "auto", merged: "confirmed",
      events: [ev("20261113-180000-aa0003", "run_finished", "2026-11-13T23:30:00Z", { merged_at: "2026-11-13T23:30:00Z" })],
    });
    // Unknown provenance: GitHub merged, no stored outcome.
    write("20261113-220000-aa0004", { result: "done", ticket: "omit", pr: PR(303), policy: "auto" });
    // Partial API failure must not become a merge, even with a stored confirmation.
    write("20261113-223000-aa0005", {
      result: "done", ticket: 304, pr: PR(304), merged: "confirmed",
      events: [ev("20261113-223000-aa0005", "run_finished", "2026-11-13T22:40:00Z")],
    });
    // Queued, open, CI-pending and a done queue row are not merges.
    write("20261113-224000-aa0006", {
      result: "done", ticket: 305, pr: PR(305), merged: "confirmed",
      events: [ev("20261113-224000-aa0006", "queued", "2026-11-13T22:45:00Z", { waiter_pid: process.pid })],
    });
    write("20261113-225000-aa0007", {
      result: "done", ticket: 306, pr: PR(306), policy: "human_review",
      events: [ev("20261113-225000-aa0007", "run_finished", "2026-11-13T22:50:00Z")],
    });
    write("20261113-230000-aa0008", {
      result: "done", ticket: 307, pr: PR(307), policy: "auto",
      reason: "after #9",
      events: [ev("20261113-230000-aa0008", "run_finished", "2026-11-13T23:10:00Z")],
    });
    write("20261113-231000-aa0009", {
      result: "done", ticket: 308, pr: PR(307),
      events: [ev("20261113-231000-aa0009", "run_finished", "2026-11-13T23:12:00Z")],
    });
    // Retry with no following agent call is not a successful recovery. An idle-slot event is.
    write("20261113-232000-aa0010", {
      result: "done", ticket: 309,
      events: [
        ev("20261113-232000-aa0010", "queued", "2026-11-13T23:15:00Z", { waited_ms: 60000 }),
        ev("20261113-232000-aa0010", "step_retry", "2026-11-13T23:16:00Z", { class: "stream", attempt: 1, max: 2 }, "implement"),
        ev("20261113-232000-aa0010", "run_finished", "2026-11-13T23:20:00Z"),
      ],
    });
    write("20261113-233000-aa0011", {
      result: "done", ticket: 310,
      events: [
        ev("20261113-233000-aa0011", "progress", "2026-11-13T23:40:00Z", { idle_slot_ms: 180000 }),
        ev("20261113-233000-aa0011", "step_retry", "2026-11-13T23:41:00Z", { class: "stream", attempt: 1, max: 2 }, "implement"),
        ev("20261113-233000-aa0011", "agent_finished", "2026-11-13T23:50:00Z", {}, "implement"),
        ev("20261113-233000-aa0011", "run_finished", "2026-11-13T23:55:00Z"),
      ],
    });

    mkdirSync(join(home, "queue"), { recursive: true });
    writeFileSync(join(home, "queue", "r.json"), JSON.stringify({
      version: 1, repo, repo_key: "r",
      entries: [
        { issue: 300, status: "pending", added_at: "2026-11-01T10:00:00.000Z" },
        { issue: 301, status: "running", added_at: "2026-11-13T19:00:00.000Z" },
        { issue: 399, status: "done", added_at: "2026-11-13T20:00:00.000Z" },
      ],
    }));

    const gh = new FakeGitHub();
    gh.prStates.set(PR(301), { state: "merged", draft: false, ci: "green" });
    gh.prStates.set(PR(302), { state: "merged", draft: false, ci: "green" });
    gh.prStates.set(PR(303), { state: "merged", draft: false, ci: "green" });
    gh.prStates.set(PR(305), { state: "merged", draft: false, ci: "pending" });
    gh.prStates.set(PR(306), { state: "open", draft: false, ci: "green" });
    gh.prStates.set(PR(307), { state: "open", draft: false, ci: "red" });
    // PR(304) absent: partial API failure.

    const report = await statusReport({ factoryHome: home, github: gh, since: "6h", timezone: "Europe/Berlin", now: () => now });
    StatusReportSchema.parse(report);
    const f = report.since!.funnel!;
    expect(f.interval).toEqual({
      from: "2026-11-13T19:00:00.000Z",
      to: "2026-11-14T01:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    expect(f.attempts).toBe(11);
    expect(f.merges.confirmed).toBe(2);
    expect(f.merges.github_only).toBe(1);
    expect(f.merges.closed_without_merge).toBe(0);
    expect(f.factory_provenance).toBeNull();
    expect(f.unknowns.merge_status).toBeGreaterThanOrEqual(1);
    expect(f.ready_awaiting_approval).toEqual({ prs: 1, tickets: 1 });
    expect(f.backlog_parked_before).toBe(1);
    expect(f.first_attempted_in_interval).not.toBe(f.backlog_parked_before);
    expect(f.work_first_attempted_before).toBe(1);
    const red = f.blockers.find((b) => b.reason === "CI red");
    const dep = f.blockers.find((b) => b.cls === "dependency");
    expect(red).toEqual({ reason: "CI red", cls: "ci_runner", prs: 1, tickets: 2 });
    expect(dep).toEqual(expect.objectContaining({ cls: "dependency", prs: 1, tickets: 1 }));
    expect(f.blocker_prs).toBe(2);
    expect(f.recovered_without_human).toBe(1);
    expect(f.idle_slot_minutes).toBe(3);

    const text = renderStatus(report);
    expect(text).toContain("funnel 2026-11-13T19:00:00.000Z .. 2026-11-14T01:00:00.000Z (Europe/Berlin):");
    expect(text).not.toContain("factory-confirmed");
    expect(text).toContain("provenance unknown");
    expect(text).toContain("idle slot 3 min");
    expect(text).not.toContain("merged 11");
  });

  it("dedupes unknown merge status by PR, not by run", () => {
    const unread = (id: string, n: number) => source({
      run_id: id,
      ticket: n,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(n),
      pr_state: null,
      merge_status_unknown: true,
      merged_stored: "no",
    });
    const pending = (id: string) => source({
      run_id: id,
      ticket: 30,
      first_attempt: INTERVAL.from + 1,
      finished: INTERVAL.from + 2,
      pr: PR(30),
      pr_state: pr({ state: "merged", ci: "pending" }),
      merged_stored: "confirmed",
    });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [unread("u1", 9), unread("u2", 9), unread("u3", 10), pending("p1"), pending("p2")],
      queue: [],
    });
    // PR(9) twice, PR(10) once, PR(30) twice while CI is pending: three PRs, not five runs.
    expect(funnel.unknowns.merge_status).toBe(3);
    expect(funnel.merges).toEqual({ confirmed: 0, github_only: 0, closed_without_merge: 0 });
    expect(funnel.blocker_prs).toBe(2);
  });

  it("keeps one open PR from being both ready and a blocker when attempts disagree", () => {
    const ready = (id: string, prn: number, finished: number) => source({
      run_id: id,
      ticket: prn,
      first_attempt: INTERVAL.from + 1,
      finished,
      pr: PR(prn),
      pr_state: pr({ state: "open", ci: "green" }),
      merge_policy: "human_review",
      merged_stored: "no",
    });
    const blocked = (id: string, prn: number, finished: number) => source({
      run_id: id,
      ticket: prn,
      first_attempt: INTERVAL.from + 1,
      finished,
      pr: PR(prn),
      pr_state: pr({ state: "open", ci: "red" }),
      merge_policy: "human_review",
      merged_stored: "no",
    });
    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [
        blocked("early-block", 1, INTERVAL.from + 1),
        ready("later-ready", 1, INTERVAL.from + 5),
        ready("early-ready", 2, INTERVAL.from + 1),
        blocked("later-block", 2, INTERVAL.from + 5),
        ready("tie-a", 3, INTERVAL.from + 3),
        blocked("tie-b", 3, INTERVAL.from + 3),
      ],
      queue: [],
    });
    // Later finish wins. Equal finish: lexicographically greater run id wins, so tie-b blocks and tie-a does not stay ready.
    expect(funnel.ready_awaiting_approval).toEqual({ prs: 1, tickets: 1 });
    expect(funnel.blocker_prs).toBe(2);
    expect(funnel.blockers).toEqual([
      { reason: "CI red", cls: "ci_runner", prs: 2, tickets: 2 },
    ]);
    expect(funnel.attempts).toBe(6);
  });

  it("does not treat a later unrelated agent_finished as a successful recovery, and sums recoveries", () => {
    expect(successfulRecoveries([
      agentEvent("step_retry", "implement"),
      agentEvent("agent_finished", "implement"),
    ])).toBe(1);
    expect(successfulRecoveries([
      agentEvent("step_retry", "implement"),
      agentEvent("step_retry", "implement"),
      agentEvent("agent_finished", "implement"),
    ])).toBe(1);
    expect(successfulRecoveries([
      agentEvent("model_retry", "implement"),
      agentEvent("agent_error", "implement"),
      agentEvent("agent_finished", "implement"),
    ])).toBe(0);
    expect(successfulRecoveries([
      agentEvent("model_fallback", null),
      agentEvent("agent_finished", "implement"),
    ])).toBe(0);
    expect(successfulRecoveries([
      agentEvent("step_retry", "implement"),
      agentEvent("agent_finished", null),
    ])).toBe(0);
    expect(successfulRecoveries([
      agentEvent("step_retry", "implement"),
      agentEvent("agent_finished", "review"),
    ])).toBe(0);
    expect(successfulRecoveries([
      agentEvent("progress", "gates", { repair: "format" }),
      agentEvent("gate_result", null, { status: "pass" }),
    ])).toBe(1);

    const funnel = ticketFunnel({
      interval: INTERVAL,
      sources: [
        source({ run_id: "rec-1", ticket: 1, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, recoveries: 2, merged_stored: "no" }),
        source({ run_id: "rec-2", ticket: 2, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, recoveries: 1, merged_stored: "no" }),
        source({ run_id: "rec-3", ticket: 3, first_attempt: INTERVAL.from + 1, finished: INTERVAL.from + 2, recoveries: 4, unresolved_decision: true, merged_stored: "no" }),
      ],
      queue: [],
    });
    expect(funnel.recovered_without_human).toBe(3);
    expect(funnel.factory_provenance).toBeNull();
    expect(funnel.idle_slot_minutes).toBeNull();
  });

  it("does not finish an unfinished run from its last event, and does not merge a legacy queued run because GitHub says merged", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-unfinished-"));
    const repo = "/tmp/funnel-unfinished";
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    const writeState = (id: string, o: { result: string | null; ticket: number; pr?: string | null; events?: string[]; outcome?: boolean }) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `issue #${o.ticket}`, labels: [] }, no_pr: false,
        step: o.result ? "finished" : "implement", result: o.result, reason: "", branch: null, worktree: null, pr: o.pr ?? null,
      }));
      if (o.outcome) {
        writeFileSync(join(dir, "result.json"), JSON.stringify({
          run_id: id, repo, task: `issue #${o.ticket}`, type: "feature", lane: "standard", result: o.result, risk: "low",
          merge_policy: "auto", pr: o.pr ?? null, rounds: 1, minutes: 1, cost_usd: 0, reason: "", branch: null, worktree: null, run_dir: dir,
          outcome: { ticket: o.ticket, attempts: 1, delivered_pr: o.pr ?? null, merged: "no", ended_without_merge: true, open_decision: false },
        }));
      }
      if (o.events?.length) writeFileSync(join(dir, "events.jsonl"), o.events.join("\n") + "\n");
    };
    const ev = (id: string, event: string, ts: string, data: Record<string, unknown> = {}) =>
      JSON.stringify({ ts, run_id: id, step: "implement", event, role: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data });

    // Started before the window, still unfinished, last event inside the window. Not an interval attempt.
    writeState("20261113-120000-bb0001", {
      result: null, ticket: 1,
      events: [ev("20261113-120000-bb0001", "heartbeat", "2026-11-14T12:00:00.000Z")],
    });
    // Started inside the window and still unfinished: counted from the run id, not from an invented finish.
    writeState("20261114-060000-bb0002", {
      result: null, ticket: 2,
      events: [ev("20261114-060000-bb0002", "heartbeat", "2026-11-14T07:00:00.000Z")],
    });
    // Legacy queued event (no waiter_pid), result stored, GitHub says merged. Not a merge.
    writeState("20261114-080000-bb0003", {
      result: "done", ticket: 3, pr: PR(77), outcome: true,
      events: [ev("20261114-080000-bb0003", "queued", "2026-11-14T08:00:00.000Z", { holder_run_id: "old", holder_pid: 1 })],
    });

    const gh = new FakeGitHub();
    gh.prStates.set(PR(77), { state: "merged", draft: false, ci: "green" });
    const report = await statusReport({ factoryHome: home, github: gh, since: "24h", timezone: "UTC", now: () => now });
    StatusReportSchema.parse(report);
    const f = report.since!.funnel!;
    expect(f.attempts).toBe(2);
    // The unfinished in-window run has no result, so its ticket stays unknown rather than invented.
    expect(f.admitted_tickets).toBe(1);
    expect(f.unknowns.tickets).toBe(1);
    expect(f.merges).toEqual({ confirmed: 0, github_only: 0, closed_without_merge: 0 });
    expect(f.unknowns.merge_status).toBe(1);
    expect(f.factory_provenance).toBeNull();
    expect(f.idle_slot_minutes).toBeNull();
  });

  it("status funnel keys the same issue in two repositories as two tickets, including merges", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-repos-"));
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    const alpha = "/tmp/funnel-alpha";
    const beta = "/tmp/funnel-beta";
    const write = (id: string, repo: string, pr: string) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: "issue #42", labels: [] }, no_pr: false,
        step: "finished", result: "done", reason: "", branch: null, worktree: null, pr,
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        run_id: id, repo, task: "issue #42", type: "feature", lane: "standard", result: "done", risk: "low",
        merge_policy: "auto", pr, rounds: 1, minutes: 1, cost_usd: 0, reason: "", branch: null, worktree: null, run_dir: dir,
        outcome: { ticket: 42, attempts: 1, delivered_pr: pr, merged: "confirmed", ended_without_merge: false, open_decision: false },
      }));
      writeFileSync(join(dir, "events.jsonl"), JSON.stringify({
        ts: "2026-11-14T10:00:00.000Z", run_id: id, step: "finalize", event: "run_finished", role: null, model: null,
        tokens_in: 0, tokens_out: 0, cost_usd: 0, data: { merged_at: "2026-11-14T10:00:00.000Z" },
      }) + "\n");
    };
    write("20261114-090000-cc0001", alpha, PR(42));
    write("20261114-090100-cc0002", beta, PR(42));
    mkdirSync(join(home, "queue"), { recursive: true });
    for (const [key, repo] of [["alpha", alpha], ["beta", beta]] as const) {
      writeFileSync(join(home, "queue", `${key}.json`), JSON.stringify({
        version: 1, repo, repo_key: key,
        entries: [{ issue: 77, status: "pending", added_at: "2026-11-01T00:00:00.000Z" }],
      }));
    }
    const gh = new FakeGitHub();
    gh.prStates.set(PR(42), { state: "merged", draft: false, ci: "green" });
    const report = await statusReport({ factoryHome: home, github: gh, since: "24h", timezone: "UTC", now: () => now });
    const f = report.since!.funnel!;
    expect(f.admitted_tickets).toBe(2);
    expect(f.merges.confirmed).toBe(2);
    expect(f.backlog_parked_before).toBe(2);
    expect(f.offered_tickets).toBe(2);
    expect(f.factory_provenance).toBeNull();
  });

  it("does not bind a later resumed attempt to a historical run_finished when result.json is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-resume-finish-"));
    const repo = "/tmp/funnel-resume-finish";
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    const write = (id: string, events: string[], pr: string | null) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: "issue #1", labels: [] }, no_pr: false,
        step: "implement", result: null, reason: "", branch: null, worktree: null, pr,
      }));
      writeFileSync(join(dir, "events.jsonl"), events.join("\n") + "\n");
    };
    const ev = (id: string, event: string, ts: string, data: Record<string, unknown> = {}, step = "implement") =>
      JSON.stringify({ ts, run_id: id, step, event, role: null, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data });

    // Previous attempt finished inside the window. Resume deleted result.json; the current attempt has not finished.
    const unfinished = "20261113-100000-dd0001";
    write(unfinished, [
      ev(unfinished, "run_finished", "2026-11-14T08:00:00.000Z", { merged_at: "2026-11-14T08:00:00.000Z" }),
      ev(unfinished, "progress", "2026-11-14T12:00:00.000Z", { recovery: { previous_result: "done", attempts: 2, checkpoint: "review", plan_kept: true } }, "resume"),
      ev(unfinished, "heartbeat", "2026-11-14T13:00:00.000Z"),
    ], PR(88));
    // Historical merged_at is before the window. The current attempt's own run_finished is inside it, still without result.json.
    const finished = "20261113-110000-dd0002";
    write(finished, [
      ev(finished, "run_finished", "2026-11-13T18:00:00.000Z", { merged_at: "2026-11-13T18:00:00.000Z" }),
      ev(finished, "step_started", "2026-11-14T09:00:00.000Z", { base_red_resume: true, base_sha: "abc", ci: "green" }, "resume"),
      ev(finished, "run_finished", "2026-11-14T10:00:00.000Z"),
    ], null);

    const gh = new FakeGitHub();
    gh.prStates.set(PR(88), { state: "merged", draft: false, ci: "green" });
    const report = await statusReport({ factoryHome: home, github: gh, since: "24h", timezone: "UTC", now: () => now });
    const f = report.since!.funnel!;
    // The unfinished resume is not an interval attempt. The later attempt is, dated by its own run_finished, not the old merge.
    expect(f.attempts).toBe(1);
    expect(f.merges).toEqual({ confirmed: 0, github_only: 0, closed_without_merge: 0 });
    expect(f.unknowns.merge_status).toBe(0);
    expect(f.blocker_prs).toBe(0);
    expect(f.factory_provenance).toBeNull();
  });

  it("skips a corrupt queue file instead of failing status --since, and does not present a partial queue as complete", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-bad-queue-"));
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    mkdirSync(join(home, "queue"), { recursive: true });
    writeFileSync(join(home, "queue", "good.json"), JSON.stringify({
      version: 1, repo: "/tmp/funnel-bad-queue", repo_key: "good",
      entries: [{ issue: 9, status: "pending", added_at: "2026-11-01T00:00:00.000Z" }],
    }));
    writeFileSync(join(home, "queue", "bad.json"), "{not json");
    const report = await statusReport({ factoryHome: home, github: new FakeGitHub(), since: "24h", timezone: "UTC", now: () => now });
    StatusReportSchema.parse(report);
    const f = report.since!.funnel!;
    expect(f.offered_tickets).toBeNull();
    expect(f.backlog_parked_before).toBeNull();
    expect(f.unknowns.queues).toBe(1);
    expect(f.admitted_tickets).toBe(0);
    expect(f.factory_provenance).toBeNull();
    expect(f.idle_slot_minutes).toBeNull();
    expect(report.queues).toEqual([expect.objectContaining({ repo: "/tmp/funnel-bad-queue", pending: 1 })]);
    expect(renderStatus(report)).toContain("offered unknown");
    expect(renderStatus(report)).toContain("parked backlog before interval unknown");
  });

  it("counts a successful recovery only when that recovery occurred inside the interval", async () => {
    const home = mkdtempSync(join(tmpdir(), "funnel-recovery-window-"));
    const repo = "/tmp/funnel-recovery-window";
    const now = Date.parse("2026-11-15T00:00:00.000Z");
    const write = (id: string, ticket: number, events: string[]) => {
      const dir = join(home, "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        version: 1, run_id: id, repo, task: { ref: `issue #${ticket}`, labels: [] }, no_pr: false,
        step: "finished", result: "done", reason: "", branch: null, worktree: null, pr: null,
      }));
      writeFileSync(join(dir, "result.json"), JSON.stringify({
        run_id: id, repo, task: `issue #${ticket}`, type: "feature", lane: "standard", result: "done", risk: "low",
        merge_policy: "human_review", pr: null, rounds: 1, minutes: 1, cost_usd: 0, reason: "", branch: null, worktree: null, run_dir: dir,
        outcome: { ticket, attempts: 1, delivered_pr: null, merged: "no", ended_without_merge: true, open_decision: false },
      }));
      writeFileSync(join(dir, "events.jsonl"), events.join("\n") + "\n");
    };
    const ev = (id: string, event: string, ts: string, role: string | null = null, data: Record<string, unknown> = {}) =>
      JSON.stringify({ ts, run_id: id, step: "implement", event, role, model: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, data });

    // Proved before the window, run finishes inside it. Not this interval's recovery.
    const early = "20261113-100000-ee0001";
    write(early, 401, [
      ev(early, "step_retry", "2026-11-13T10:00:00.000Z", "implement", { class: "stream", attempt: 1, max: 2 }),
      ev(early, "agent_finished", "2026-11-13T11:00:00.000Z", "implement"),
      ev(early, "run_finished", "2026-11-14T10:00:00.000Z"),
    ]);
    // Proved inside the window.
    const inside = "20261114-080000-ee0002";
    write(inside, 402, [
      ev(inside, "step_retry", "2026-11-14T08:00:00.000Z", "implement", { class: "stream", attempt: 1, max: 2 }),
      ev(inside, "agent_finished", "2026-11-14T09:00:00.000Z", "implement"),
      ev(inside, "run_finished", "2026-11-14T10:30:00.000Z"),
    ]);

    const report = await statusReport({ factoryHome: home, github: new FakeGitHub(), since: "24h", timezone: "UTC", now: () => now });
    expect(report.since!.funnel!.recovered_without_human).toBe(1);
    expect(report.since!.funnel!.attempts).toBe(2);
    expect(report.since!.funnel!.factory_provenance).toBeNull();
    expect(report.since!.funnel!.idle_slot_minutes).toBeNull();
  });
});
