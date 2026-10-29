import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_BRANCH, evidenceUrl, githubSlug, MAX_EVIDENCE_FILE_BYTES, publishEvidence, pruneEvidence } from "../../src/evaluate/evidence.js";
import { addOrigin, commitFile, createFixtureRepo, gitIn } from "../helpers/repo.js";

const author = { name: "factory-bot", email: "factory-bot@users.noreply.github.com" };

function evidence(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("evidence branch", () => {
  it("parses GitHub remotes and builds pinned raw links", () => {
    expect(githubSlug("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubSlug("git@github.com:acme/app.git")).toBe("acme/app");
    expect(githubSlug("ssh://git@github.com/acme/app")).toBe("acme/app");
    expect(githubSlug("/tmp/origin.git")).toBeNull();
    expect(evidenceUrl("acme/app", "abc", "run 1/r1-A1.png")).toBe("https://github.com/acme/app/blob/abc/run%201/r1-A1.png?raw=true");
  });

  it("commits run folders on an orphan branch with plain pushes, never touching the user's index; gc retention drops old folders", async () => {
    const repo = createFixtureRepo();
    const bare = addOrigin(repo);
    commitFile(repo, "README.md", "x");
    writeFileSync(join(repo, "untracked.txt"), "keep me");
    gitIn(repo, "add", "untracked.txt");
    const headBefore = gitIn(repo, "rev-parse", "HEAD");

    const a = await publishEvidence(repo, { runId: "run-a", dir: evidence({ "r1-A1.png": "png-a", "r1-session.gif": "gif" }), files: ["r1-A1.png", "r1-session.gif"], author });
    expect(a.slug).toBeNull();
    expect([...a.paths.values()]).toEqual(["run-a/r1-A1.png", "run-a/r1-session.gif"]);
    // Orphan: no parent, only evidence in the tree.
    expect(gitIn(bare, "rev-list", "--parents", "-n", "1", EVIDENCE_BRANCH).trim().split(" ")).toHaveLength(1);

    const big = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1);
    const b = await publishEvidence(repo, { runId: "run-b", dir: evidence({ "r1-x.png": "png-b", "r1-session.webm": big }), files: ["r1-x.png", "r1-session.webm"], author });
    expect(b.skipped).toEqual([expect.stringMatching(/^r1-session\.webm/)]);
    expect(gitIn(bare, "rev-parse", EVIDENCE_BRANCH).trim()).toBe(b.sha);
    expect(gitIn(bare, "rev-parse", `${b.sha}^`).trim()).toBe(a.sha);
    expect(gitIn(bare, "ls-tree", "-r", "--name-only", EVIDENCE_BRANCH).trim().split("\n")).toEqual(["run-a/r1-A1.png", "run-a/r1-session.gif", "run-b/r1-x.png"]);
    expect(gitIn(bare, "show", `${EVIDENCE_BRANCH}:run-a/r1-A1.png`)).toBe("png-a");

    // The user's branch, index and files are untouched.
    expect(gitIn(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(gitIn(repo, "diff", "--cached", "--name-only").trim()).toBe("untracked.txt");

    // A concurrent push from elsewhere: the next publish builds on the new tip (plain push, no force).
    const other = createFixtureRepo();
    gitIn(other, "remote", "add", "origin", bare);
    const c = await publishEvidence(other, { runId: "run-c", dir: evidence({ "c.png": "c" }), files: ["c.png"], author });
    expect(gitIn(bare, "rev-parse", `${c.sha}^`).trim()).toBe(b.sha);

    // Retention: nothing is old yet; 31 days later everything is.
    expect(await pruneEvidence(repo, { now: Date.now(), author })).toEqual([]);
    const later = Date.now() + 31 * 86_400_000;
    expect(await pruneEvidence(repo, { now: later, author, dryRun: true })).toEqual(["run-a", "run-b", "run-c"]);
    expect(gitIn(bare, "rev-parse", EVIDENCE_BRANCH).trim()).toBe(c.sha);
    expect(await pruneEvidence(repo, { now: later, days: 30, author })).toEqual(["run-a", "run-b", "run-c"]);
    expect(gitIn(bare, "ls-tree", "-r", "--name-only", EVIDENCE_BRANCH).trim()).toBe("");
    expect(gitIn(bare, "rev-parse", `${EVIDENCE_BRANCH}^`).trim()).toBe(c.sha);
  }, 30_000);

  it("publishing without an origin fails with a git error", async () => {
    const repo = createFixtureRepo();
    await expect(publishEvidence(repo, { runId: "r", dir: evidence({ "a.png": "a" }), files: ["a.png"], author })).rejects.toThrow(/git ls-remote failed/);
    expect(() => execFileSync("git", ["rev-parse", "--verify", "-q", "refs/factory/evidence"], { cwd: repo })).toThrow();
  });
});
