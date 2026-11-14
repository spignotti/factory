import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cleanBaseUpdate, decideBatchPr, type BatchPr } from "../../src/queue/batch.js";

const SHA = "a".repeat(40);
const NEXT = "c".repeat(40);

function pr(extra: Partial<BatchPr> = {}): BatchPr {
  return {
    repo: "/repo",
    number: 1,
    url: "https://github.test/pr/1",
    reviewed_sha: SHA,
    files: ["src/math.js"],
    risk: "low",
    protected: false,
    merge_policy: "human_review",
    status: "pending",
    reason: "",
    ...extra,
  };
}

const green = { state: "open" as const, headSha: SHA, ci: "green", behind: false, conflicting: false, draft: false };

describe("merge batch decisions (#189)", () => {
  it("merges only an authorized green head and does not treat a policy as permission", () => {
    const decision = decideBatchPr({
      pr: pr(),
      live: green,
      files: ["src/math.js"],
      base: { ok: true, kind: "same", reason: "same" },
      requiredChecks: ["done"],
      method: "squash",
      paused: false,
      earlierBlocked: false,
      canRevalidate: true,
    });
    expect(decision).toEqual({ action: "merge", reason: expect.stringContaining("done"), sha: SHA });
    expect(pr().merge_policy).toBe("human_review");
  });

  it("does not merge when done is not required, CI is red, the file list changed, or an earlier PR is open", () => {
    const common = { pr: pr(), files: ["src/math.js"], base: { ok: true, kind: "same" as const, reason: "same" }, method: "squash" as const, paused: false, earlierBlocked: false, canRevalidate: true };
    expect(decideBatchPr({ ...common, live: green, requiredChecks: ["build"] }).action).toBe("blocked");
    expect(decideBatchPr({ ...common, live: { ...green, ci: "red" }, requiredChecks: ["done"] }).action).toBe("blocked");
    expect(decideBatchPr({ ...common, live: green, files: ["src/math.js", ".factory/repo.yaml"], requiredChecks: ["done"] }).action).toBe("needs_approval");
    expect(decideBatchPr({ ...common, live: green, requiredChecks: ["done"], earlierBlocked: true }).action).toBe("wait");
    expect(decideBatchPr({ ...common, live: { ...green, state: "merged" }, requiredChecks: ["done"] }).action).toBe("reconciled");
    expect(decideBatchPr({ ...common, live: { ...green, conflicting: true }, requiredChecks: ["done"] }).action).toBe("needs_approval");
  });

  it("a moved head that is not a clean base update needs renewed approval", () => {
    const decision = decideBatchPr({
      pr: pr(),
      live: { ...green, headSha: NEXT },
      files: ["src/math.js"],
      base: { ok: false, kind: "rejected", reason: "not a merge of the reviewed commit" },
      requiredChecks: ["done"],
      method: "squash",
      paused: false,
      earlierBlocked: false,
      canRevalidate: true,
    });
    expect(decision.action).toBe("needs_approval");
    expect(decision.sha).toBeUndefined();
  });

  it("a clean base update whose CI is not green is revalidated, not stamped", () => {
    const decision = decideBatchPr({
      pr: pr(),
      live: { ...green, headSha: NEXT, ci: "none" },
      files: ["src/math.js"],
      base: { ok: true, kind: "clean_base", reason: "clean" },
      requiredChecks: ["done"],
      method: "squash",
      paused: false,
      earlierBlocked: false,
      canRevalidate: true,
    });
    expect(decision.action).toBe("revalidate");
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("clean base update", () => {
  it("accepts a clean merge of the reviewed commit and rejects an evil merge and unreadable parents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-batch-git-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "fixture@test"]);
    git(dir, ["config", "user.name", "fixture"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, ["add", "base.txt"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    git(dir, ["add", "feature.txt"]);
    git(dir, ["commit", "-q", "-m", "feature"]);
    const approved = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "main.txt"), "main\n");
    git(dir, ["add", "main.txt"]);
    git(dir, ["commit", "-q", "-m", "main moves"]);
    const newBase = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "-q", "feature"]);
    git(dir, ["merge", "-q", "--no-ff", "main", "-m", "update"]);
    const clean = git(dir, ["rev-parse", "HEAD"]);
    expect(await cleanBaseUpdate({ worktree: dir, approved, head: approved, baseSha: newBase, parents: null })).toMatchObject({ ok: true, kind: "same" });
    expect(await cleanBaseUpdate({ worktree: dir, approved, head: clean, baseSha: newBase, parents: [approved, newBase] })).toMatchObject({ ok: true, kind: "clean_base" });
    expect(await cleanBaseUpdate({ worktree: dir, approved, head: clean, baseSha: newBase, parents: null }).then((v) => v.ok)).toBe(false);
    mkdirSync(join(dir, "evil"), { recursive: true });
    writeFileSync(join(dir, "feature.txt"), "tampered\n");
    git(dir, ["add", "feature.txt"]);
    const tree = git(dir, ["write-tree"]);
    const evil = git(dir, ["commit-tree", tree, "-p", approved, "-p", newBase, "-m", "evil"]);
    expect(await cleanBaseUpdate({ worktree: dir, approved, head: evil, baseSha: newBase, parents: [approved, newBase] })).toMatchObject({ ok: false });
    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });
});
