import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffExclusion, diffStat, diffTotals, formatDiffTotals, looksBinary, parseNumstatZ, repoDiffStat } from "../../src/git.js";
import { diffSize } from "../../src/gates/builtin.js";
import { fastLaneEscalation } from "../../src/pipeline/lane.js";
import { DEPENDENCY_GLOBS, LOCK_FILES } from "../../src/paths.js";
import { matchesAny } from "../../src/schemas/plan.js";
import { RepoConfigSchema } from "../../src/schemas/repo.js";
import { gitIn } from "../helpers/repo.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x0a, 0x0a, 0x0a]);
const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-count-"));
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}
function write(dir: string, path: string, content: string | Buffer) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}
const commit = (dir: string) => {
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
};

describe("diff line count: exclusions", () => {
  it("lockfiles are excluded, manifests are not; lockfiles stay dependency files", () => {
    expect(diffExclusion("package-lock.json", false)).toBe("lockfile");
    expect(diffExclusion("apps/web/pnpm-lock.yaml", false)).toBe("lockfile");
    expect(diffExclusion("go.sum", false)).toBe("lockfile");
    for (const m of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) expect(diffExclusion(m, false)).toBeUndefined();
    for (const l of LOCK_FILES) expect(matchesAny(l, DEPENDENCY_GLOBS)).toBe(true);
  });

  it("binary detection: NUL byte in the first 8 KB", () => {
    expect(looksBinary(PNG)).toBe(true);
    expect(looksBinary(Buffer.from("plain\ntext\n"))).toBe(false);
    expect(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))).toBe(false);
  });

  it("diff_exclude never excludes a test file", () => {
    const opts = { exclude: ["gen/**", "**/*.snap"], testGlobs: ["**/*.test.ts", "**/__snapshots__/**"] };
    expect(diffExclusion("gen/api.ts", false, opts)).toBe("diff_exclude");
    expect(diffExclusion("gen/api.test.ts", false, opts)).toBeUndefined();
    expect(diffExclusion("src/__snapshots__/a.snap", false, opts)).toBeUndefined();
    expect(diffExclusion("src/a.ts", false, opts)).toBeUndefined();
  });

  it("counts tracked and untracked files; untracked binaries are 0 lines, not garbage", async () => {
    const dir = repo();
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    write(dir, "src/a.ts", text(40));
    write(dir, "package-lock.json", text(533));
    write(dir, "assets/tracked.png", Buffer.concat([PNG, Buffer.alloc(4000, 0x0a)]));
    write(dir, "gen/client.ts", text(100));
    commit(dir);
    write(dir, "assets/untracked.png", Buffer.concat([PNG, Buffer.alloc(4000, 0x0a)]));
    write(dir, "src/new.ts", text(10));
    const stat = await diffStat(dir, base, { exclude: ["gen/**"], testGlobs: [] });
    expect(stat.get("src/a.ts")).toEqual({ lines: 40 });
    expect(stat.get("package-lock.json")).toEqual({ lines: 533, excluded: "lockfile" });
    expect(stat.get("assets/tracked.png")).toEqual({ lines: 0, excluded: "binary" });
    expect(stat.get("assets/untracked.png")).toEqual({ lines: 0, excluded: "binary" });
    expect(stat.get("gen/client.ts")).toEqual({ lines: 100, excluded: "diff_exclude" });
    const t = diffTotals(stat);
    expect(t).toEqual({ counted: 50, excluded: 633, excludedFiles: ["gen/client.ts", "package-lock.json"], binaryFiles: 2 });
    expect(formatDiffTotals(t)).toBe("50 lines (+633 excluded: gen/client.ts, package-lock.json; 2 binary files)");
  });

  it("the gate fails on counted lines only and names the exclusions", () => {
    const stat = new Map([["src/a.ts", { lines: 943 }], ["package-lock.json", { lines: 533, excluded: "lockfile" as const }]]);
    expect(diffSize(stat, 1500)).toMatchObject({ ok: true, detail: "943 lines (+533 excluded: package-lock.json)" });
    expect(diffSize(stat, 900)).toMatchObject({ ok: false, detail: "diff has 943 lines (+533 excluded: package-lock.json) > 900" });
  });

  it("repoDiffStat takes limits.diff_exclude and tests.globs from repo.yaml", async () => {
    const dir = repo();
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    write(dir, "gen/a.ts", text(5));
    write(dir, "gen/a.test.ts", text(7));
    const cfg = RepoConfigSchema.parse({ limits: { diff_exclude: ["gen/**"] }, tests: { globs: ["**/*.test.ts"] } });
    expect(diffTotals(await repoDiffStat(dir, base, cfg))).toMatchObject({ counted: 7, excluded: 5 });
  });

  it("fast lane: a big lockfile does not escalate by lines, but still as a dependency change", async () => {
    const dir = repo();
    const baseSha = gitIn(dir, "rev-parse", "HEAD").trim();
    write(dir, "package-lock.json", text(400));
    write(dir, "src/a.ts", text(20));
    const reasons = await fastLaneEscalation({ worktree: dir, baseSha, repo: RepoConfigSchema.parse({}) });
    expect(reasons.some((r) => r.includes("fast_lane.max_diff_lines"))).toBe(false);
    expect(reasons).toContain("dependencies: package-lock.json");
  });

  it("schema: diff_exclude defaults to empty and rejects catch-all globs", () => {
    expect(RepoConfigSchema.parse({}).limits.diff_exclude).toEqual([]);
    for (const g of ["**", "**/*", "*", "./**"]) expect(RepoConfigSchema.safeParse({ limits: { diff_exclude: [g] } }).success).toBe(false);
    expect(RepoConfigSchema.safeParse({ limits: { diff_exclude: ["dist/**"] } }).success).toBe(true);
  });
});

describe("diff line count: renames (tourenpilot-ops #82)", () => {
  it("a moved file counts its changed lines under the new path, not its content twice", async () => {
    const dir = repo();
    write(dir, ".grok/scripts/deploy.sh", text(1400));
    write(dir, ".grok/scripts/lib/ssh.sh", text(300));
    commit(dir);
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    mkdirSync(join(dir, "server/lib"), { recursive: true });
    gitIn(dir, "mv", ".grok/scripts/deploy.sh", "server/deploy.sh");
    gitIn(dir, "mv", ".grok/scripts/lib/ssh.sh", "server/lib/ssh.sh");
    // A path line changed in the moved file.
    write(dir, "server/deploy.sh", text(1400).replace("line 3\n", "line three\n"));
    gitIn(dir, "add", "-A");
    const stat = await diffStat(dir, base);
    expect(stat.get("server/deploy.sh")).toEqual({ lines: 2 });
    expect(stat.get("server/lib/ssh.sh")).toEqual({ lines: 0 });
    expect(stat.has(".grok/scripts/deploy.sh")).toBe(false);
    expect(diffTotals(stat).counted).toBe(2);
    expect(diffSize(stat, 1500).ok).toBe(true);
  });

  it("a committed rename is detected as well", async () => {
    const dir = repo();
    write(dir, "old/a.sh", text(500));
    commit(dir);
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "mv", "old/a.sh", "a.sh");
    commit(dir);
    expect(diffTotals(await diffStat(dir, base)).counted).toBe(0);
  });

  it("a rename into or out of an excluded path counts as delete + add, so it cannot hide lines", async () => {
    const dir = repo();
    write(dir, "src/big.ts", text(800));
    write(dir, "gen/client.ts", text(600));
    commit(dir);
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    mkdirSync(join(dir, "gen/moved"), { recursive: true });
    gitIn(dir, "mv", "src/big.ts", "gen/moved/big.ts");
    gitIn(dir, "mv", "gen/client.ts", "src/client.ts");
    const stat = await diffStat(dir, base, { exclude: ["gen/**"], testGlobs: [] });
    expect(stat.get("src/big.ts")).toEqual({ lines: 800 });
    expect(stat.get("gen/moved/big.ts")).toEqual({ lines: 800, excluded: "diff_exclude" });
    expect(stat.get("src/client.ts")).toEqual({ lines: 600 });
    expect(stat.get("gen/client.ts")).toEqual({ lines: 600, excluded: "diff_exclude" });
    expect(diffTotals(stat).counted).toBe(1400);
  });

  it("a rename inside an excluded path stays excluded, matched on the new path", async () => {
    const dir = repo();
    write(dir, "gen/a.ts", text(300));
    commit(dir);
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "mv", "gen/a.ts", "gen/b.ts");
    write(dir, "gen/b.ts", text(300) + "extra\n");
    gitIn(dir, "add", "-A");
    const stat = await diffStat(dir, base, { exclude: ["gen/**"], testGlobs: [] });
    expect([...stat.entries()]).toEqual([["gen/b.ts", { lines: 1, excluded: "diff_exclude" }]]);
  });

  it("parses -z numstat: renames, odd file names, binaries", () => {
    const out = ["3\t1\tsrc/a b.ts", "0\t0\t", "{x}/old => y.sh", "y/{new}.sh", "-\t-\timg.png", "2\t0\t", "a\tb.txt", "c.txt", ""].join("\0");
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a b.ts", added: 3, removed: 1, binary: false },
      { path: "y/{new}.sh", from: "{x}/old => y.sh", added: 0, removed: 0, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
      { path: "c.txt", from: "a\tb.txt", added: 2, removed: 0, binary: false },
    ]);
  });
});
