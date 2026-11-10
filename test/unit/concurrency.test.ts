import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concurrencyCheck } from "../../src/commands/doctor.js";
import { acquireRepoLock, acquireRepoLockWithRetry, attemptAcquireRepoLock, decidePathClaim, legacyLockPath, lockRepoKey, releaseRunLock, repoLockPath } from "../../src/pipeline/lock.js";
import { factoryPrOverlapReason, factoryPrOverlaps, needsConcurrencyPathClaim } from "../../src/pipeline/path-claim.js";
import { IncompletePrListError, OPEN_FACTORY_PR_LIMIT, openFactoryPrListArgs, parseOpenFactoryPrs, readOpenFactoryPrs } from "../../src/gh.js";
import { claimsConflict, pathsOverlap, touchesExclusive } from "../../src/pipeline/overlap.js";
import { riskReasonLine, securityRows } from "../../src/pipeline/risk.js";
import { validatePlan } from "../../src/schemas/plan.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";
import { hostStepsMarkdown } from "../../src/steps/finalize.js";

const home = () => mkdtempSync(join(tmpdir(), "lock-"));
const REPO = "git@github.com:o/r.git";

function dump(dir: string): string {
  const locks = join(dir, "locks");
  if (!existsSync(locks)) return "";
  return readdirSync(locks)
    .map((name) => `${name}\n${readFileSync(join(locks, name), "utf8")}`)
    .join("\n");
}

describe("lock repo key", () => {
  const token = "ghp_secretToken123";
  const url = `https://${token}@github.com/acme/widgets.git`;

  it("shares one key for credential, clean and ssh urls, with no secret in the key", () => {
    const clean = "https://github.com/acme/widgets.git";
    expect(lockRepoKey(url)).toBe(lockRepoKey(clean));
    expect(lockRepoKey("https://user:token@github.com/acme/widgets.git")).toBe(lockRepoKey(clean));
    expect(lockRepoKey("git@github.com:acme/widgets.git")).toBe(lockRepoKey(clean));
    expect(lockRepoKey("ssh://git@github.com/acme/widgets.git")).toBe(lockRepoKey(clean));
    expect(lockRepoKey(url)).toMatch(/^acme-widgets-[0-9a-f]{8}$/);
    expect(lockRepoKey(url)).not.toContain(token);
  });

  it("never writes a credential into a lock file name or its content", () => {
    const dir = home();
    const release = acquireRepoLock(dir, url, "run-1");
    expect(release).toBeTypeOf("function");
    expect(dump(dir)).not.toContain(token);
    expect(dump(dir)).not.toContain("github.com");
    release!();
    expect(dump(dir)).not.toContain(token);
  });

  it("deletes a stale legacy file whose name contains the token", () => {
    const dir = home();
    const legacy = legacyLockPath(dir, url)!;
    expect(legacy).toContain(token);
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(legacy, "999999999\nold\n");
    const release = acquireRepoLock(dir, url, "run-1")!;
    expect(existsSync(legacy)).toBe(false);
    expect(dump(dir)).not.toContain(token);
    release();
  });

  it("a live legacy lock blocks the repo and is not copied into a new file", () => {
    const dir = home();
    const legacy = legacyLockPath(dir, url)!;
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(legacy, `${process.pid}\nrun-live`);
    expect(acquireRepoLock(dir, url, "run-1")).toBeUndefined();
    const locks = join(dir, "locks");
    for (const name of readdirSync(locks)) {
      if (join(locks, name) === legacy) continue;
      expect(name).not.toContain(token);
      expect(readFileSync(join(locks, name), "utf8")).not.toContain(token);
    }
  });
});

describe("lock slots", () => {
  it("allows maxRuns claims and reuses a released slot", () => {
    const dir = home();
    const a = acquireRepoLock(dir, REPO, "a", { maxRuns: 2 })!;
    const b = acquireRepoLock(dir, REPO, "b", { maxRuns: 2 })!;
    expect(a.slot).toBe(0);
    expect(b.slot).toBe(1);
    expect(acquireRepoLock(dir, REPO, "c", { maxRuns: 2 })).toBeUndefined();
    a();
    const c = acquireRepoLock(dir, REPO, "c", { maxRuns: 2 })!;
    expect(c.slot).toBe(0);
    b();
    c();
  });

  it("releaseRunLock finds a dead holder on a slot above 0", () => {
    const dir = home();
    const a = acquireRepoLock(dir, REPO, "a", { maxRuns: 2 })!;
    acquireRepoLock(dir, REPO, "b", { maxRuns: 2 });
    const slot1 = repoLockPath(dir, REPO).replace(/\.lock$/, ".1.lock");
    writeFileSync(slot1, "999999999\nb");
    expect(releaseRunLock(dir, REPO, "b")).toEqual({ status: "released", pid: 999999999 });
    expect(existsSync(slot1)).toBe(false);
    expect(releaseRunLock(dir, REPO, "a").status).toBe("live");
    a();
  });

  it("exclusive claim fails while any slot is held and takes every slot when free", () => {
    const dir = home();
    const held = acquireRepoLock(dir, REPO, "run", { maxRuns: 2 })!;
    expect(acquireRepoLock(dir, REPO, "gc", { maxRuns: 2, exclusive: true })).toBeUndefined();
    held();
    const gc = acquireRepoLock(dir, REPO, "gc", { maxRuns: 2, exclusive: true })!;
    expect(acquireRepoLock(dir, REPO, "other", { maxRuns: 2 })).toBeUndefined();
    gc();
    expect(acquireRepoLock(dir, REPO, "other", { maxRuns: 2 })).toBeTypeOf("function");
  });
});

describe("path claims", () => {
  it("overlaps directories and globs, not a shared prefix", () => {
    expect(pathsOverlap("src/auth", "src/auth/login.ts")).toBe(true);
    expect(pathsOverlap("./src/auth/", "src/auth")).toBe(true);
    expect(pathsOverlap("src/auth", "src/authz")).toBe(false);
    expect(pathsOverlap("supabase/migrations/001.sql", "supabase/migrations/**")).toBe(true);
    expect(claimsConflict({ paths: ["a.ts"], exclusive: true }, { paths: ["b.ts"], exclusive: true })).toBe(true);
    expect(claimsConflict({ paths: ["a.ts"], exclusive: false }, { paths: ["b.ts"], exclusive: false })).toBe(false);
    expect(touchesExclusive(["supabase/migrations/001.sql"], ["supabase/migrations/**"])).toBe(true);
    expect(touchesExclusive(["src/app.ts"], ["supabase/migrations/**"])).toBe(false);
  });

  it("rejects an overlapping claim and an exclusive pair, and keeps a disjoint one", () => {
    const dir = home();
    const held = acquireRepoLock(dir, REPO, "other", { maxRuns: 2 })!;
    expect(decidePathClaim(dir, REPO, held.slot, "other", { paths: ["src/math.js"], exclusive: false }).ok).toBe(true);
    const mine = acquireRepoLock(dir, REPO, "me", { maxRuns: 2 })!;
    const overlap = decidePathClaim(dir, REPO, mine.slot, "me", { paths: ["src/math.js"], exclusive: false });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok && overlap.kind === "conflict") expect(overlap.conflicts.join(" ")).toContain("other");
    const again = decidePathClaim(dir, REPO, mine.slot, "me", { paths: ["docs/readme.md"], exclusive: false });
    expect(again.ok).toBe(true);
    held();
    const exclusive = acquireRepoLock(dir, REPO, "ex", { maxRuns: 2 })!;
    expect(decidePathClaim(dir, REPO, exclusive.slot, "ex", { paths: ["README.md"], exclusive: true }).ok).toBe(true);
    const blocked = decidePathClaim(dir, REPO, mine.slot, "me", { paths: ["other.ts"], exclusive: true });
    expect(blocked.ok).toBe(false);
    mine();
    exclusive();
  });
});

describe("risk and host steps", () => {
  const repo = parseRepoConfig("");
  const plan = (host_steps: unknown): unknown => ({
    version: 1,
    type: "feature",
    goal: "g",
    packages: [{ id: "P1", title: "t", files: ["src/a.ts"] }],
    acceptance: [{ id: "A1", package: "P1", text: "works", verify: "review" }],
    host_steps,
  });

  it("security rows are yes/no with a short note, and the rating line has no merge advice", () => {
    const changed = ["src/auth/login.ts", "src/auth.ts", "package.json", ".env", "supabase/migrations/001.sql", "Dockerfile"];
    const rows = Object.fromEntries(securityRows(changed).map((r) => [r.area, r]));
    expect(rows["Data/migrations"]).toMatchObject({ touched: true });
    expect(rows["Auth/permissions"]!.note).toContain("src/auth/login.ts");
    expect(rows["Auth/permissions"]!.note).toContain("src/auth.ts");
    expect(rows["Secrets handling"]!.touched).toBe(true);
    expect(rows["Prod deploy/infra"]!.touched).toBe(true);
    expect(rows["Dependencies"]!.touched).toBe(true);
    expect(securityRows(["src/math.js"]).every((r) => !r.touched)).toBe(true);
    expect(riskReasonLine({ risk: "low", reasons: [] })).toBe("no sensitive paths, dependency changes, or migrations");
    expect(riskReasonLine({ risk: "high", reasons: ["changes protected config (CI / factory)"] })).not.toMatch(/merge|approval/);
  });

  it("renders host steps only when a title and commands exist", () => {
    const steps = { commands: ["launchctl bootstrap gui/501 ~/Library/LaunchAgents/ops.plist"], verify: "launchctl print", rollback: "launchctl bootout gui/501" };
    const md = hostStepsMarkdown("Mac install steps", steps);
    expect(md).toContain("## Mac install steps");
    expect(md).toContain("production Mac host");
    expect(md).toContain("launchctl bootstrap gui/501 ~/Library/LaunchAgents/ops.plist");
    expect(md).toContain("**Verify**");
    expect(md).toContain("**Roll back**");
    expect(hostStepsMarkdown("Install steps", steps)).toContain("production host");
    expect(hostStepsMarkdown(undefined, steps)).toBe("");
    expect(hostStepsMarkdown("Mac install steps", undefined)).toBe("");
    const fenced = hostStepsMarkdown("Mac install steps", { ...steps, verify: "see ```" });
    expect(fenced).toContain("~~~~");
  });

  it("accepts host_steps and drops null; empty commands fail", () => {
    expect(validatePlan(plan(null), { repo }).ok).toBe(true);
    const ok = validatePlan(plan({ commands: ["launchctl load x"], verify: "check", rollback: "undo" }), { repo });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.plan.host_steps?.commands).toEqual(["launchctl load x"]);
    const bad = validatePlan(plan({ commands: [], verify: "v", rollback: "r" }), { repo });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join("\n")).toMatch(/host_steps/);
  });

  it("doctor concurrency line", () => {
    expect(concurrencyCheck(repo)).toEqual({ name: "concurrency", status: "ok", detail: "max_runs 1" });
    const parallel = parseRepoConfig("concurrency: { max_runs: 2 }\n");
    expect(concurrencyCheck(parallel).detail).toBe("max_runs 2; exclusive_paths (none)");
  });

  it("open factory PR files ignore other branches and overlap like path claims", () => {
    const parsed = parseOpenFactoryPrs([
      { number: 12, headRefName: "factory/old", files: [{ path: "a.py" }] },
      { number: 3, headRefName: "feature/a", files: [{ path: "a.py" }] },
      { number: 4, headRefName: "factory/fork", isCrossRepository: true, files: [{ path: "a.py" }] },
      { number: 5, headRefName: "factory/nested", files: { nodes: [{ filename: "src/auth/login.ts" }] } },
    ]);
    expect(parsed.map((p) => p.number)).toEqual([12, 5]);
    const hits = factoryPrOverlaps(parsed, ["a.py", "src/auth"], "factory/nested");
    expect(hits).toEqual([{ number: 12, files: ["a.py"] }]);
    expect(factoryPrOverlapReason("planned", hits)).toBe("planned paths overlap open factory PR #12 (a.py)");
    expect(factoryPrOverlaps(parsed, ["b.py"])).toEqual([]);
  });

  it("an open PR list that fills the page is not a clearance", () => {
    expect(openFactoryPrListArgs()).toContain(String(OPEN_FACTORY_PR_LIMIT));
    expect(OPEN_FACTORY_PR_LIMIT).toBe(1000);
    const page = Array.from({ length: OPEN_FACTORY_PR_LIMIT }, (_, i) => ({ number: i + 1, headRefName: "feature/x", files: [{ path: "a.py" }] }));
    expect(() => readOpenFactoryPrs(page)).toThrow(IncompletePrListError);
    expect(() => readOpenFactoryPrs(page)).toThrow(/hit the limit \(1000\)/);
    expect(readOpenFactoryPrs(page.slice(0, OPEN_FACTORY_PR_LIMIT - 1))).toEqual([]);
    expect(() => readOpenFactoryPrs({ items: [] })).toThrow(/not a JSON array/);
  });

  it("needsConcurrencyPathClaim when max_runs>1 or exclusive_paths set", () => {
    expect(needsConcurrencyPathClaim(parseRepoConfig(""))).toBe(false);
    expect(needsConcurrencyPathClaim(parseRepoConfig("concurrency: { max_runs: 2 }\n"))).toBe(true);
    expect(needsConcurrencyPathClaim(parseRepoConfig('concurrency: { exclusive_paths: ["a/**"] }\n'))).toBe(true);
  });

  it("parallel slot acquires retry through brief alloc guard contention", async () => {
    const dir = home();
    const n = 12;
    const held = await Promise.all(
      Array.from({ length: n }, (_, i) => acquireRepoLockWithRetry(dir, REPO, `run-${i}`, { maxRuns: n })),
    );
    expect(held.every(Boolean)).toBe(true);
    for (const r of held) r!();
  });

  it("attemptAcquire distinguishes a full repo from a busy alloc guard", () => {
    const dir = home();
    const a = acquireRepoLock(dir, REPO, "a", { maxRuns: 1 })!;
    expect(attemptAcquireRepoLock(dir, REPO, "b", { maxRuns: 1 })).toEqual({ status: "unavailable" });
    a();
    expect(attemptAcquireRepoLock(dir, REPO, "b", { maxRuns: 1 }).status).toBe("acquired");
  });

  describe("alloc guard (NB1/NB2)", () => {
    const guardOf = (dir: string) => join(dir, "locks", `${lockRepoKey(REPO)}.alloc`);
    const withGuard = (dir: string, pid: number, ageMs = 0) => {
      mkdirSync(join(dir, "locks"), { recursive: true });
      writeFileSync(guardOf(dir), String(pid));
      if (ageMs) {
        const t = (Date.now() - ageMs) / 1000;
        utimesSync(guardOf(dir), t, t);
      }
    };

    it("a fresh guard of another live process is alloc_busy and stays untouched; retry succeeds once it is released", async () => {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      try {
        const dir = home();
        withGuard(dir, child.pid!);
        expect(attemptAcquireRepoLock(dir, REPO, "a", { maxRuns: 2 })).toEqual({ status: "alloc_busy" });
        expect(readFileSync(guardOf(dir), "utf8")).toBe(String(child.pid));
        setTimeout(() => rmSync(guardOf(dir), { force: true }), 30);
        const rel = await acquireRepoLockWithRetry(dir, REPO, "a", { maxRuns: 2 });
        expect(rel).toBeTypeOf("function");
        rel!();
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a guard of a dead process or older than 10 s is taken over", () => {
      const dead = home();
      withGuard(dead, 999_999_999);
      const a = acquireRepoLock(dead, REPO, "a", { maxRuns: 2 });
      expect(a).toBeTypeOf("function");
      a!();
      const old = home();
      withGuard(old, process.pid === 1 ? 2 : 1, 60_000);
      const b = acquireRepoLock(old, REPO, "b", { maxRuns: 2 });
      expect(b).toBeTypeOf("function");
      b!();
      // released guard and no .stale leftovers
      expect(readdirSync(join(old, "locks")).filter((n) => n.endsWith(".alloc") || n.endsWith(".stale"))).toEqual([]);
    });
  });
});
