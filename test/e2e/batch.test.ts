import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../../src/gh.js";
import { advanceMergeBatch, applyBatch, batchPath, loadBatch, previewBatch } from "../../src/queue/batch.js";
import { queueCommand } from "../../src/commands/queue.js";
import { repoQueueKey, saveQueue } from "../../src/queue/store.js";
import { runQueue } from "../../src/queue/worker.js";
import { createFixtureRepo } from "../helpers/repo.js";

const REVIEWED = "a".repeat(40);
const MOVED = "d".repeat(40);
const RUN = "20261114-140000-aaaaaa";

function plant(repo: string, factoryHome: string, sha = REVIEWED) {
  const dir = join(factoryHome, "runs", RUN);
  mkdirSync(join(dir, "worktree"), { recursive: true });
  writeFileSync(join(dir, "plan.json"), "{\"protected_changes\":[]}\n");
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    version: 1,
    step: "finished",
    repo,
    branch: "factory/7-fix",
    pr: "https://github.test/pr/7",
    reviewed_sha: sha,
    worktree: join(dir, "worktree"),
    task: { issue: 7, text: "# Multiply\n\nAdd multiply." },
  }));
  writeFileSync(join(dir, "result.json"), JSON.stringify({
    result: "done",
    risk: "high",
    risk_reasons: ["changes protected config (CI / factory)"],
    merge_policy: "human_review",
    pr: "https://github.test/pr/7",
  }) + "\n");
}

function githubFor(repo: string, head = REVIEWED): FakeGitHub {
  const github = new FakeGitHub();
  github.settings = { private: true, auto_merge_allowed: true, branch_protected: true, required_checks: ["done"], merge_methods: { squash: true, merge: false, rebase: false } };
  github.prs.push({ repoDir: repo, head: "factory/7-fix", base: "main", title: "fix", body: "reviewed", draft: false, url: "https://github.test/pr/7" });
  github.prStates.set("https://github.test/pr/7", { state: "open", draft: false, ci: "green", behind: false });
  github.remoteShas.set("factory/7-fix", head);
  github.factoryPrs.push({ number: 7, branch: "factory/7-fix", files: ["src/math.js"] });
  return github;
}

describe("explicit merge batch (#189)", () => {
  it("previews only the named PR, persists that approval, and a second apply does not reset progress", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-batch-"));
    plant(repo, factoryHome);
    const github = githubFor(repo);
    const preview = await previewBatch(factoryHome, github, [{ repo, number: 7 }]);
    expect(preview).toHaveLength(1);
    expect(preview[0]?.reviewed_sha).toBe(REVIEWED);
    expect(preview[0]?.protected).toBe(true);
    expect(preview[0]?.merge_policy).toBe("human_review");
    expect(preview[0]?.reason).toContain("required [done]");
    const applied = await applyBatch(factoryHome, github, [{ repo, number: 7 }]);
    applied.prs[0]!.status = "waiting";
    applied.prs[0]!.reason = "kept";
    writeFileSync(batchPath(factoryHome), JSON.stringify(applied, null, 2));
    const again = await applyBatch(factoryHome, github, [{ repo, number: 7 }]);
    expect(again.prs[0]?.status).toBe("waiting");
    expect(again.id).toBe(applied.id);
  });

  it("merges the reviewed head with an expected-head guard and does not stamp or change policy", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-batch-"));
    plant(repo, factoryHome);
    const github = githubFor(repo);
    await applyBatch(factoryHome, github, [{ repo, number: 7 }]);
    const io = { out: () => undefined, err: () => undefined };
    expect(await advanceMergeBatch({ factoryHome, github, repo, io })).toBe(false);
    expect(github.mergedNow).toEqual([{ pr: "https://github.test/pr/7", sha: REVIEWED, method: "squash" }]);
    expect(github.approvedShas).toEqual([]);
    expect(JSON.parse(readFileSync(join(factoryHome, "runs", RUN, "result.json"), "utf8")).merge_policy).toBe("human_review");
    expect(loadBatch(factoryHome)?.prs[0]?.status).toBe("merged");
    github.prStates.set("https://github.test/pr/7", { state: "merged", draft: false, ci: "green" });
    await advanceMergeBatch({ factoryHome, github, repo, io });
    expect(github.mergedNow).toHaveLength(1);
  });

  it("updates a behind human_review PR, then refuses a head that is not the approved base update", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-batch-"));
    plant(repo, factoryHome);
    const github = githubFor(repo);
    github.prStates.set("https://github.test/pr/7", { state: "open", draft: false, ci: "green", behind: true });
    await applyBatch(factoryHome, github, [{ repo, number: 7 }]);
    const io = { out: () => undefined, err: () => undefined };
    await advanceMergeBatch({ factoryHome, github, repo, io });
    expect(github.updatedBranches).toEqual(["https://github.test/pr/7"]);
    expect(github.mergedNow).toEqual([]);
    expect(github.approvedShas).toEqual([]);
    github.prStates.set("https://github.test/pr/7", { state: "open", draft: false, ci: "green", behind: false });
    github.remoteShas.set("factory/7-fix", MOVED);
    github.commitParentsBySha.set(MOVED, [MOVED, REVIEWED]);
    await advanceMergeBatch({ factoryHome, github, repo, io });
    expect(github.mergedNow).toEqual([]);
    expect(loadBatch(factoryHome)?.prs[0]?.status).toBe("needs_approval");
    expect(JSON.parse(readFileSync(join(factoryHome, "runs", RUN, "result.json"), "utf8")).merge_policy).toBe("human_review");
  });

  it("the worker merges an authorized head and leaves an unrelated parked ticket alone", async () => {
    const repo = createFixtureRepo();
    const factoryHome = mkdtempSync(join(tmpdir(), "factory-batch-"));
    const key = await repoQueueKey(repo);
    plant(repo, factoryHome);
    saveQueue(factoryHome, {
      version: 1,
      repo,
      repo_key: key,
      entries: [
        { issue: 7, status: "done", added_at: "2026-11-14T00:00:00.000Z", run_id: RUN, pr: "https://github.test/pr/7" },
        { issue: 8, status: "parked", added_at: "2026-11-14T00:00:00.000Z", reason: "needs a human decision" },
      ],
    });
    const github = githubFor(repo);
    const cap = { out: "", err: "" };
    const io = { out: (s: string) => void (cap.out += s), err: (s: string) => void (cap.err += s) };
    expect(await queueCommand(["batch", "--apply"], { factoryHome, github, io })).toBe(2);
    expect(await queueCommand(["batch", "--pr", `${repo}#7`, "--apply", "--json"], { factoryHome, github, io })).toBe(0);
    const ctl = new AbortController();
    const worker = runQueue({
      factoryHome,
      github,
      repo,
      slots: 1,
      pollMs: 10,
      signal: ctl.signal,
      io,
      start: () => {
        throw new Error("batch must not start a coding run");
      },
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && github.mergedNow.length === 0) await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await worker.catch(() => undefined);
    expect(github.mergedNow, cap.err).toEqual([{ pr: "https://github.test/pr/7", sha: REVIEWED, method: "squash" }]);
    expect(github.approvedShas).toEqual([]);
    expect(JSON.parse(readFileSync(join(factoryHome, "queue", `${key}.json`), "utf8")).entries.find((e: { issue: number }) => e.issue === 8).status).toBe("parked");
  }, 30_000);
});
