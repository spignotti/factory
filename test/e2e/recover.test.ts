import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/events.js";
import { FakeGitHub } from "../../src/gh.js";
import { issueRevision } from "../../src/queue/admit.js";
import { queueCommand } from "../../src/commands/queue.js";
import { loadQueueByKey, repoQueueKey, saveQueue } from "../../src/queue/store.js";
import { runQueue } from "../../src/queue/worker.js";
import { createFixtureRepo } from "../helpers/repo.js";

const TITLE = "Multiply";
const BODY = "Add multiply.";
const RUN = "20261114-130000-aaaaaa";

function io() {
  let out = "";
  let err = "";
  return { out: (s: string) => void (out += s), err: (s: string) => void (err += s), text: () => out, errors: () => err };
}

describe("queue recover through the running worker (#188)", () => {
  it("resumes the original run after an operator-fixed branch and does not start a second implementation", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-recover-e2e-"));
    const key = await repoQueueKey(repo);
    const dir = join(factoryHome, "runs", RUN);
    mkdirSync(join(dir, "worktree"), { recursive: true });
    writeFileSync(join(dir, "plan.json"), "{}\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1,
      step: "review",
      repo,
      task: { issue: 7, ref: "#7", text: `# ${TITLE}\n\n${BODY}` },
      branch: "factory/7-fix",
      pr: "https://github.test/pr/7",
      reviewed_sha: "a".repeat(40),
      repair: { gate_attempts: 1, network_retries: 0, format_used: false, infra_reruns: 0 },
      stop: { cause: "technical_repair", action: "repair" },
    }));
    saveQueue(factoryHome, {
      version: 1,
      repo,
      repo_key: key,
      entries: [{
        issue: 7,
        status: "parked",
        added_at: "2026-11-14T00:00:00.000Z",
        run_id: RUN,
        issue_rev: issueRevision(TITLE, BODY),
        pr: "https://github.test/pr/7",
        requeues: 1,
        reason: "needs a repair",
      }, {
        issue: 8,
        status: "parked",
        added_at: "2026-11-14T00:00:00.000Z",
        reason: "needs a human decision",
      }],
    });
    const github = new FakeGitHub();
    github.issues.set(7, { number: 7, title: TITLE, body: BODY, labels: ["factory-ready"], state: "open" });
    github.issues.set(8, { number: 8, title: "Decide", body: "A real decision.", labels: ["factory-ready", "needs-decision"], state: "open" });
    github.prs.push({ repoDir: repo, head: "factory/7-fix", base: "main", title: "fix", body: "fixed on the branch", draft: false, url: "https://github.test/pr/7" });
    github.prStates.set("https://github.test/pr/7", { state: "open", draft: false });
    github.remoteShas.set("factory/7-fix", "b".repeat(40));
    github.factoryPrs.push({ number: 7, branch: "factory/7-fix", files: ["src/math.js"] });

    const preview = io();
    expect(await queueCommand(["recover", "--issue", "7", "--json"], { factoryHome, github, io: preview })).toBe(0);
    const previewed = JSON.parse(preview.text()) as { entries: { action: string; invalidated?: string[] }[] };
    expect(previewed.entries[0]?.action).toBe("revalidate");
    expect(previewed.entries[0]?.invalidated).toContain(`reviewed ${"a".repeat(40)}`);
    expect(loadQueueByKey(factoryHome, key)?.entries[0]?.status).toBe("parked");

    expect(await queueCommand(["recover", "--apply"], { factoryHome, github, io: io() })).toBe(2);
    github.issues.set(7, { number: 7, title: TITLE, body: "Changed after the plan.", labels: ["factory-ready"], state: "open" });
    const refused = io();
    expect(await queueCommand(["recover", "--apply", "--issue", "7", "--json"], { factoryHome, github, io: refused })).toBe(0);
    expect(JSON.parse(refused.text()).released).toEqual([]);
    expect(loadQueueByKey(factoryHome, key)?.entries[0]?.status).toBe("parked");

    github.issues.set(7, { number: 7, title: TITLE, body: BODY, labels: ["factory-ready"], state: "open" });
    const applied = io();
    expect(await queueCommand(["recover", "--apply", "--issue", "7", "--json"], { factoryHome, github, io: applied })).toBe(0);
    expect(JSON.parse(applied.text()).released).toHaveLength(1);
    expect(loadQueueByKey(factoryHome, key)?.entries.find((e) => e.issue === 8)?.status).toBe("parked");

    const starts: { issue: number; resume?: string }[] = [];
    const ctl = new AbortController();
    const workerIo = io();
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 10,
      signal: ctl.signal,
      io: workerIo,
      start: (req) => {
        starts.push({ issue: req.issue, resume: req.resumeRunId });
        const done: RunResult = {
          run_id: req.resumeRunId ?? req.runId ?? RUN,
          repo,
          task: `#${req.issue}`,
          type: "feature",
          lane: "standard",
          result: "done",
          risk: "low",
          merge_policy: "human_review",
          pr: "https://github.test/pr/7",
          rounds: 0,
          minutes: 0,
          cost_usd: 0,
          reason: "",
          branch: "factory/7-fix",
          worktree: join(dir, "worktree"),
          run_dir: dir,
        };
        return { done: Promise.resolve(done), pid: 0, runId: () => done.run_id, kill: () => undefined, unref: () => undefined };
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && starts.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    ctl.abort();
    await worker.catch(() => undefined);
    expect(starts, workerIo.errors()).toEqual([{ issue: 7, resume: RUN }]);
    const repair = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { repair?: { gate_attempts?: number } };
    expect(repair.repair?.gate_attempts).toBe(1);
  }, 60_000);
});
