import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffExclusion, diffStat, diffTotals, formatDiffTotals, looksBinary, repoDiffStat } from "../../src/git.js";
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
