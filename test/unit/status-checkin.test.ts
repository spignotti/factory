import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { checkinCommand, checkinReport, renderCheckin } from "../../src/commands/status.js";
import { FakeGitHub } from "../../src/gh.js";
import { saveQueue, type QueueEntry } from "../../src/queue/store.js";
import { StatusCheckinSchema } from "../../src/schemas/reports.js";

const REPO = "/work/example";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const INSIDE = "2026-11-16T09:00:00Z";
const BEFORE = "2026-11-15T20:00:00Z";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "factory-checkin-"));
  const gh = new FakeGitHub();
  const touch = (id: string, iso: string) => {
    const t = new Date(iso);
    utimesSync(join(home, "runs", id, "result.json"), t, t);
  };
  const run = (id: string, finished: string, task: string, result: Record<string, unknown>, repo = REPO, state: Record<string, unknown> = {}) => {
    const dir = join(home, "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, run_id: id, repo, task: { ref: task }, no_pr: false, step: "finished", result: result.result, reason: "", branch: null, worktree: null, pr: result.pr ?? null, lane: "standard", ...state }));
    writeFileSync(join(dir, "result.json"), JSON.stringify({ run_id: id, repo, task, rounds: 1, minutes: 5, reason: "", ...result }));
    touch(id, finished);
  };
  const pr = (url: string, v: { state?: "open" | "merged" | "closed"; draft?: boolean }) => gh.prStates.set(url, { state: v.state ?? "open", draft: v.draft ?? false });
  const queue = (entries: QueueEntry[], repo = REPO) => saveQueue(home, { version: 1, repo, repo_key: "k", entries });
  return { home, gh, run, pr, queue };
}

const entry = (issue: number, extra: Partial<QueueEntry> = {}): QueueEntry => ({ issue, status: "pending", added_at: "2026-11-16T00:00:00Z", ...extra });

/** One ticket of each outcome, plus ones that must stay out. */
function seeded() {
  const f = fixture();
  // Merged inside the window, with four assumptions (three shown).
  f.run("20261116-080000-000001", INSIDE, "#1", { result: "done", merge_policy: "auto", risk: "low", pr: "https://pr/merged", assumptions: ["a1", "a2", "a3", "a4"] });
  f.pr("https://pr/merged", { state: "merged" });
  // Merged, no assumptions.
  f.run("20261116-080500-000002", INSIDE, "#2", { result: "done", merge_policy: "auto", risk: "low", pr: "https://pr/merged2" });
  f.pr("https://pr/merged2", { state: "merged" });
  // Closed without merge: not merged.
  f.run("20261116-081000-000003", INSIDE, "#3", { result: "done", pr: "https://pr/closed" });
  f.pr("https://pr/closed", { state: "closed" });
  // A done result with an open auto PR is not a merge and not waiting for a human.
  f.run("20261116-081500-000004", INSIDE, "#4", { result: "done", merge_policy: "auto", risk: "low", pr: "https://pr/auto" });
  f.pr("https://pr/auto", { state: "open" });
  // Waiting for a human: finished before the window, still listed. One hard list, one merge hold.
  f.run("20261115-190000-000005", BEFORE, "#5", { result: "done", merge_policy: "human_review", risk: "high", risk_reasons: ["human_review_paths: infra/prod.tf"], pr: "https://pr/hard" });
  f.pr("https://pr/hard", { state: "open" });
  f.run("20261116-082000-000006", INSIDE, "#6", { result: "done", merge_policy: "human_review", risk: "medium", risk_reasons: ["config_guard failed", "sensitive_paths: src/auth.ts"], pr: "https://pr/hold" });
  f.pr("https://pr/hold", { state: "open" });
  // A draft PR is not ready; a superseded run's PR is not waiting either.
  f.run("20261116-082500-000007", INSIDE, "#7", { result: "done", merge_policy: "human_review", risk: "high", risk_reasons: ["x"], pr: "https://pr/draft" });
  f.pr("https://pr/draft", { state: "open", draft: true });
  f.run("20261115-100000-000008", BEFORE, "#8", { result: "done", merge_policy: "human_review", risk: "high", risk_reasons: ["old"], pr: "https://pr/superseded" });
  f.pr("https://pr/superseded", { state: "open" });
  f.run("20261116-083000-000009", INSIDE, "#8", { result: "failed", reason: "second try failed", pr: null });
  // Failed: the result says unreported, the queue entry says reported (the worker retried successfully).
  f.run("20261116-084000-00000a", INSIDE, "#10", { result: "failed", reason: "implement crashed\nstack line", failure_reported: false, pr: null });
  // Failed before the window: out. Another repo: out.
  f.run("20261115-090000-00000b", BEFORE, "#11", { result: "failed", reason: "too old", pr: null });
  f.run("20261116-085000-00000c", INSIDE, "#12", { result: "done", merge_policy: "human_review", risk_reasons: ["other repo"], pr: "https://pr/other" }, "/work/other");
  f.pr("https://pr/other", { state: "merged" });
  f.queue([
    entry(10, { status: "parked", run_id: "20261116-084000-00000a", reason: "implement crashed\nstack line", failed: { reported: true } }),
    entry(11, { status: "parked", run_id: "20261115-090000-00000b", reason: "too old", failed: { reported: true } }),
    entry(20, { status: "parked", awaiting_answer: { questions: ["Which table?", "Keep the old API?"], posted: false } }),
    entry(21, { status: "pending", reason: "base problem: fast checks red on base abc12345: lint (re-check after later)" }),
    entry(22, { status: "pending" }),
    entry(23, { status: "running", run_id: "20261116-090000-00000d" }),
    entry(24, { status: "done" }),
  ]);
  return f;
}

describe("factory status --repo --since (check-in)", () => {
  it("reports each outcome once, windowed where it should be, and nothing else", async () => {
    const f = seeded();
    const c = await checkinReport({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", now: () => NOW });
    expect(StatusCheckinSchema.parse(c)).toEqual(c);
    expect(c.since).toEqual({ since: "6h", from: "2026-11-16T06:00:00.000Z" });
    expect(c.merged).toEqual([
      { issue: 1, task: "#1", pr: "https://pr/merged", assumptions: ["a1", "a2", "a3", "a4"] },
      { issue: 2, task: "#2", pr: "https://pr/merged2", assumptions: [] },
    ]);
    expect(c.waiting_for_merge).toEqual([
      { issue: 5, task: "#5", pr: "https://pr/hard", reason: "human_review_paths: infra/prod.tf", pr_state: "open" },
      { issue: 6, task: "#6", pr: "https://pr/hold", reason: "config_guard failed; sensitive_paths: src/auth.ts", pr_state: "open" },
    ]);
    expect(c.questions_open).toEqual([{ issue: 20, questions: ["Which table?", "Keep the old API?"], posted: false }]);
    expect(c.failed).toEqual([
      { issue: 10, task: "#10", reason: "implement crashed", reported: true },
      { issue: 8, task: "#8", reason: "second try failed", reported: false },
    ]);
    expect(c.base_problem).toBe("base problem: fast checks red on base abc12345: lint (re-check after later)");
    expect(c.queue).toEqual({ pending: 2, running: 1, parked: 3 });
    expect(JSON.stringify(c)).not.toMatch(/other|closed|auto|too old/);
  });

  it("prints only sections with content, in the brief's order", async () => {
    const f = seeded();
    const text = renderCheckin(await checkinReport({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", now: () => NOW }));
    expect(text).toBe(
      [
        "Factory check-in /work/example, since 2026-11-16T06:00:00.000Z",
        "",
        "Merged since (2)",
        "  #1 https://pr/merged",
        "    assumed: a1",
        "    assumed: a2",
        "    assumed: a3",
        "    +1 more",
        "  #2 https://pr/merged2",
        "",
        "Waiting for a human merge (2)",
        "  #5 https://pr/hard",
        "    human_review_paths: infra/prod.tf",
        "  #6 https://pr/hold",
        "    config_guard failed; sensitive_paths: src/auth.ts",
        "",
        "Questions open (1)",
        "  #20 (not posted yet)",
        "    1. Which table?",
        "    2. Keep the old API?",
        "",
        "Failed since (2)",
        "  #10 (reported on GitHub)",
        "    implement crashed",
        "  #8 (not reported on GitHub)",
        "    second try failed",
        "",
        "Base problem",
        "  base problem: fast checks red on base abc12345: lint (re-check after later)",
        "",
        "Queue: pending 2, running 1, parked 3",
        "",
      ].join("\n"),
    );
    const empty = fixture();
    expect(renderCheckin(await checkinReport({ factoryHome: empty.home, github: empty.gh, repo: REPO, since: "6h", now: () => NOW }))).toBe(
      "Factory check-in /work/example, since 2026-11-16T06:00:00.000Z\n\nNothing to report.\n",
    );
  });

  it("accepts an ISO time, rejects a bad or future one, and the window edge is inclusive", async () => {
    const f = seeded();
    const since = (s: string) => checkinReport({ factoryHome: f.home, github: f.gh, repo: REPO, since: s, now: () => NOW });
    expect((await since("2026-11-16T09:00:00Z")).merged.map((m) => m.issue)).toEqual([1, 2]);
    const later = await since("2026-11-16T09:00:01Z");
    expect(later.merged).toEqual([]);
    expect(later.failed).toEqual([]);
    expect(later.waiting_for_merge.map((w) => w.issue)).toEqual([5, 6]);
    expect((await since("24h")).failed.map((x) => x.issue)).toEqual([10, 11, 8]);
    await expect(since("soon")).rejects.toThrow(/invalid --since/);
    await expect(since("2026-11-17T00:00:00Z")).rejects.toThrow(/future/);
  });

  it("keeps a waiting PR whose state cannot be read, marked unknown", async () => {
    const f = fixture();
    f.run("20261115-190000-000005", BEFORE, "#5", { result: "done", merge_policy: "human_review", risk: "high", risk_reasons: [], pr: "https://pr/unreadable" });
    const c = await checkinReport({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", now: () => NOW });
    expect(c.waiting_for_merge).toEqual([
      { issue: 5, task: "#5", pr: "https://pr/unreadable", reason: "merge policy human_review, risk high", pr_state: "unknown" },
    ]);
    expect(renderCheckin(c)).toContain("#5 https://pr/unreadable (PR state unknown)");
    expect(c.merged).toEqual([]);
  });

  it("--json prints the same data through the command", async () => {
    const f = seeded();
    const text: string[] = [];
    const io = { out: (s: string) => void text.push(s), err: () => {} };
    expect(await checkinCommand({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", json: true, now: () => NOW }, io)).toBe(0);
    const json = StatusCheckinSchema.parse(JSON.parse(text.join("")));
    expect(json).toEqual(await checkinReport({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", now: () => NOW }));
    text.length = 0;
    expect(await checkinCommand({ factoryHome: f.home, github: f.gh, repo: REPO, since: "6h", json: false, now: () => NOW }, io)).toBe(0);
    expect(text.join("")).toContain("Waiting for a human merge (2)");
  });

  it("the CLI needs --since with --repo", async () => {
    let err = "";
    expect(await main(["status", "--repo", REPO], { out: () => {}, err: (s) => void (err += s) })).toBe(2);
    expect(err).toContain("--since");
  });
});
