import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { briefing, canonicalRepoId, discardDeadLockFile, errorClass, flushMemory, loadMemory, memoryKey, memoryPath, observations, releaseOwnedLockFile, repoDirName } from "../../src/memory.js";
import type { TrackedFinding } from "../../src/pipeline/merge.js";

const home = () => mkdtempSync(join(tmpdir(), "factory-mem-"));
const finding = (o: Partial<TrackedFinding> = {}): TrackedFinding => ({
  id: "F1", reviewer: "evaluator", round: 1, status: "open", severity: "bug", file: "src/a.ts", line: 3,
  claim: "Off-by-one in loop bound", evidence: "e", fix: "f", checkable: "test", check_sketch: "test the last index", ...o,
});

describe("repo id", () => {
  it("one id for ssh, scp-like and https forms of the same remote", () => {
    const ids = [
      "git@github.com:spignotti/factory.git",
      "ssh://git@github.com/spignotti/factory.git",
      "https://github.com/spignotti/factory",
      "https://user:tok@GitHub.com/spignotti/factory.git/",
    ].map((u) => canonicalRepoId(u, "/x"));
    expect(new Set(ids)).toEqual(new Set(["github.com/spignotti/factory"]));
    expect(canonicalRepoId("", "/home/a/repo")).toBe("local/home/a/repo");
  });

  it("directory names are safe and distinct", () => {
    const a = repoDirName("github.com/a/b");
    expect(a).toMatch(/^github\.com_a_b-[0-9a-f]{8}$/);
    expect(repoDirName("github.com/a_b")).not.toBe(repoDirName("github.com/a/b"));
    expect(repoDirName("../../etc")).not.toContain("/");
  });
});

describe("findings memory", () => {
  it("key ignores line, case and punctuation; differs by reviewer and file", () => {
    expect(memoryKey(finding({ line: 99, claim: "off-by-one in loop bound!" }))).toBe(memoryKey(finding()));
    expect(memoryKey(finding({ reviewer: "simplicity" }))).not.toBe(memoryKey(finding()));
    expect(memoryKey(finding({ file: "src/b.ts" }))).not.toBe(memoryKey(finding()));
  });

  it("observations: confirmed findings, including fixed ones, stay distinct from rejected and ungrounded", () => {
    const obs = observations(
      [
        finding(),
        finding({ id: "F2", severity: "nit", claim: "naming" }),
        finding({ id: "F3", status: "resolved", claim: "x" }),
        finding({ id: "F4", status: "accepted_wontfix", claim: "y" }),
        finding({ id: "F5", claim: "no evidence", evidence: "  " }),
      ],
      ["test"],
    );
    expect(obs.map((o) => [o.disposition, o.key])).toEqual([
      ["confirmed", memoryKey(finding())],
      ["confirmed", memoryKey(finding({ claim: "x" }))],
      ["rejected", `rejected:${memoryKey(finding({ claim: "y" }))}`],
      ["ungrounded", `ungrounded:${memoryKey(finding({ claim: "no evidence", evidence: "  " }))}`],
      ["confirmed", "flaky:test"],
    ]);
  });

  it("counts one error class across two runs, not across rounds, and reopens it after a merge", () => {
    const factoryHome = home();
    const id = "github.com/a/class";
    const first = finding({ claim: "add throws", evidence: "AssertionError at `add`" });
    const again = finding({ claim: "add rejects empty", evidence: "saw `add` raise AssertionError" });
    expect(errorClass(first)).toBe(errorClass(again));
    expect(errorClass(first)).toBe("bug\nsrc/a.ts\nadd");
    const t = (n: number) => new Date(Date.UTC(2026, 0, n));
    flushMemory({ factoryHome, repoId: id, runId: "r1", now: t(1), observations: observations([first, again], []) });
    flushMemory({ factoryHome, repoId: id, runId: "r1", now: t(2), observations: observations([again], []) });
    let confirmed = loadMemory(factoryHome, id).entries.filter((e) => e.disposition === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ count: 1, runs: ["r1"], status: "open" });
    expect(loadMemory(factoryHome, id).entries.some((e) => e.disposition === "duplicate")).toBe(true);

    flushMemory({ factoryHome, repoId: id, runId: "r2", now: t(3), observations: observations([again], []) });
    confirmed = loadMemory(factoryHome, id).entries.filter((e) => e.disposition === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.count).toBe(2);

    const path = memoryPath(factoryHome, id);
    const stored = JSON.parse(readFileSync(path, "utf8")) as { entries: { key: string; status: string }[] };
    const row = stored.entries.find((e) => e.key === confirmed[0]!.key)!;
    row.status = "resolved";
    writeFileSync(path, JSON.stringify(stored));
    flushMemory({ factoryHome, repoId: id, runId: "r3", now: t(4), observations: observations([finding({ claim: "add still fails", evidence: "rule:add-empty `add`" })], []) });
    confirmed = loadMemory(factoryHome, id).entries.filter((e) => e.disposition === "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ count: 3, status: "open" });
    expect(briefing(loadMemory(factoryHome, id))).toContain("add still fails");
    expect(briefing({ version: 1, repo: id, entries: [{ ...confirmed[0]!, disposition: "rejected", status: "open" }] })).toBe("");
  });

  it("upsert by key: count once per run, last_seen moves, resolved reopens, runs capped", () => {
    const factoryHome = home();
    const id = "github.com/a/b";
    const obs = observations([finding()], []);
    const t = (n: number) => new Date(Date.UTC(2026, 0, n));
    flushMemory({ factoryHome, repoId: id, runId: "r1", now: t(1), observations: obs });
    flushMemory({ factoryHome, repoId: id, runId: "r1", now: t(2), observations: obs }); // resume of r1
    let e = loadMemory(factoryHome, id).entries[0]!;
    expect(e).toMatchObject({ count: 1, runs: ["r1"], first_seen: t(1).toISOString(), last_seen: t(2).toISOString(), status: "open", ref: null, reviewer: "evaluator" });

    const path = memoryPath(factoryHome, id);
    const mem = JSON.parse(readFileSync(path, "utf8"));
    mem.entries[0].status = "resolved";
    writeFileSync(path, JSON.stringify(mem));
    for (let i = 2; i <= 25; i++) flushMemory({ factoryHome, repoId: id, runId: `r${i}`, now: t(i), observations: obs });
    e = loadMemory(factoryHome, id).entries[0]!;
    expect(e.count).toBe(25);
    expect(e.status).toBe("open");
    expect(e.runs).toHaveLength(20);
    expect(e.runs.at(-1)).toBe("r25");
    expect(readdirSync(dirname(path))).toEqual(["findings.json"]); // no lock or tmp left
  });

  it("concurrent upserts from several processes lose no update", async () => {
    const factoryHome = home();
    const id = "github.com/a/concurrent";
    const writers = 6;
    const helpers = join(import.meta.dirname, "..", "helpers");
    await Promise.all(
      Array.from({ length: writers }, (_, w) =>
        new Promise<void>((done, fail) => {
          const child = spawn(
            process.execPath,
            ["--import", join(helpers, "ts-register.mjs"), join(helpers, "memory-writer.ts"), factoryHome, id, `w${w}`, `shared,own-${w}`],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          let err = "";
          child.stderr.on("data", (d) => (err += String(d)));
          child.on("close", (code) => (code === 0 ? done() : fail(new Error(`writer ${w} exited ${code}: ${err.slice(-500)}`))));
        }),
      ),
    );
    const mem = loadMemory(factoryHome, id);
    const byKey = new Map(mem.entries.map((e) => [e.key, e]));
    expect(byKey.get("shared")!.count).toBe(writers * 5);
    for (let w = 0; w < writers; w++) expect(byKey.get(`own-${w}`)!.count).toBe(5);
    expect(readdirSync(dirname(memoryPath(factoryHome, id)))).toEqual(["findings.json"]);
  }, 60_000);

  it("takes over a lock whose holder pid is dead, including an empty legacy lock", () => {
    const factoryHome = home();
    const id = "github.com/a/dead-lock";
    const path = memoryPath(factoryHome, id);
    mkdirSync(dirname(path), { recursive: true });
    const dead = spawnSync("true").pid!;
    writeFileSync(`${path}.lock`, `${dead}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, old, old);
    const started = Date.now();
    flushMemory({ factoryHome, repoId: id, runId: "r", now: new Date(), observations: observations([finding()], []) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(loadMemory(factoryHome, id).entries).toHaveLength(1);
    expect(existsSync(`${path}.lock`)).toBe(false);

    writeFileSync(`${path}.lock`, "");
    flushMemory({ factoryHome, repoId: id, runId: "r2", now: new Date(), observations: observations([finding({ claim: "second" })], []) });
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readdirSync(dirname(path)).filter((n) => /lock|takeover|stale|release/.test(n))).toEqual([]);
  });

  it("rename-aside drops the observed dead inode and leaves a replacement guard", () => {
    const dir = home();
    const guard = join(dir, "findings.json.lock.takeover");
    writeFileSync(guard, "999999999\n");
    expect(discardDeadLockFile(guard, () => writeFileSync(guard, `${process.pid}\n`))).toBe(false);
    expect(readFileSync(guard, "utf8").trim()).toBe(String(process.pid));
    expect(readdirSync(dir).filter((n) => n.includes("stale"))).toEqual([]);

    const lock = join(dir, "findings.json.lock");
    writeFileSync(lock, `${process.pid}\n`);
    releaseOwnedLockFile(lock, () => writeFileSync(lock, "999999999\n"));
    expect(readFileSync(lock, "utf8").trim()).toBe("999999999");
    expect(readdirSync(dir).filter((n) => n.includes("release"))).toEqual([]);
  });

  it("two flushes after a crashed takeover both land and leave no guard", async () => {
    const factoryHome = home();
    const id = "github.com/a/takeover-race";
    const path = memoryPath(factoryHome, id);
    mkdirSync(dirname(path), { recursive: true });
    const dead = spawnSync("true").pid!;
    writeFileSync(`${path}.lock`, `${dead}\n`);
    writeFileSync(`${path}.lock.takeover`, `${dead}\n`);
    const helpers = join(import.meta.dirname, "..", "helpers");
    await Promise.all(
      [0, 1].map(
        (w) =>
          new Promise<void>((done, fail) => {
            const child = spawn(
              process.execPath,
              ["--import", join(helpers, "ts-register.mjs"), join(helpers, "memory-writer.ts"), factoryHome, id, `w${w}`, `shared,own-${w}`],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            let err = "";
            child.stderr.on("data", (d) => (err += String(d)));
            child.on("close", (code) => (code === 0 ? done() : fail(new Error(`writer ${w} exited ${code}: ${err.slice(-500)}`))));
          }),
      ),
    );
    const byKey = new Map(loadMemory(factoryHome, id).entries.map((e) => [e.key, e]));
    expect(byKey.get("shared")!.count).toBe(10);
    expect(byKey.get("own-0")!.count).toBe(5);
    expect(byKey.get("own-1")!.count).toBe(5);
    expect(readdirSync(dirname(path)).filter((n) => /lock|takeover|stale|release/.test(n))).toEqual([]);
  });

  it("does not take over a live holder after 10 s, even when the lock file is old", async () => {
    const factoryHome = home();
    const id = "github.com/a/live-lock";
    const path = memoryPath(factoryHome, id);
    const ready = join(dirname(path), "ready");
    mkdirSync(dirname(path), { recursive: true });
    const helpers = join(import.meta.dirname, "..", "helpers");
    const holdMs = 12_000;
    const holder = spawn(process.execPath, ["--import", join(helpers, "ts-register.mjs"), join(helpers, "memory-hold.ts"), factoryHome, id, String(holdMs), ready], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let holderErr = "";
    holder.stderr.on("data", (d) => (holderErr += String(d)));
    const started = Date.now();
    while (!existsSync(ready)) {
      if (holder.exitCode !== null) throw new Error(`holder exited early: ${holderErr}`);
      if (Date.now() - started > 5_000) throw new Error(`holder never took the lock: ${holderErr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const lock = `${path}.lock`;
    const aged = new Date(Date.now() - 120_000);
    utimesSync(lock, aged, aged);
    expect(readFileSync(lock, "utf8").trim()).toBe(String(holder.pid));
    const waiter = spawn(process.execPath, ["--import", join(helpers, "ts-register.mjs"), join(helpers, "memory-writer.ts"), factoryHome, id, "waiter", "from-waiter"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let waiterErr = "";
    waiter.stderr.on("data", (d) => (waiterErr += String(d)));
    await new Promise((r) => setTimeout(r, 11_000));
    expect(waiter.exitCode).toBe(null);
    expect(readFileSync(lock, "utf8").trim()).toBe(String(holder.pid));
    const textsNow = loadMemory(factoryHome, id).entries.map((entry) => entry.text);
    expect(textsNow).not.toContain("finding from-waiter");
    const waitExit = (child: ReturnType<typeof spawn>, label: string, err: () => string) =>
      new Promise<void>((done, fail) => {
        const t = setTimeout(() => fail(new Error(`${label} did not finish: ${err()}`)), 8_000);
        child.on("close", (code) => {
          clearTimeout(t);
          if (code === 0) done();
          else fail(new Error(`${label} exited ${code}: ${err()}`));
        });
      });
    await waitExit(holder, "holder", () => holderErr);
    await waitExit(waiter, "waiter", () => waiterErr);
    expect(loadMemory(factoryHome, id).entries.map((entry) => entry.text).sort()).toEqual(["finding from-waiter", "held"]);
    expect(existsSync(lock)).toBe(false);
  }, 25_000);

  it("a broken file is kept aside, not overwritten", () => {
    const factoryHome = home();
    flushMemory({ factoryHome, repoId: "r", runId: "a", now: new Date(), observations: observations([finding()], []) });
    const path = memoryPath(factoryHome, "r");
    writeFileSync(path, "{ nope");
    expect(loadMemory(factoryHome, "r").entries).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, repo: "r", entries: [{ key: 1 }] }));
    expect(loadMemory(factoryHome, "r").entries).toEqual([]);
    expect(readdirSync(dirname(path)).filter((n) => n.startsWith("findings.json.broken-")).length).toBeGreaterThanOrEqual(1);
  });

  it("briefing: top open entries by count, then recency", () => {
    const factoryHome = home();
    const mk = (claim: string) => observations([finding({ claim })], [])[0]!;
    for (let i = 0; i < 12; i++) flushMemory({ factoryHome, repoId: "r", runId: `a${i}`, now: new Date(Date.UTC(2026, 0, 1 + i)), observations: [mk(`claim ${i}`)] });
    flushMemory({ factoryHome, repoId: "r", runId: "b", now: new Date(Date.UTC(2026, 1, 1)), observations: [mk("claim 0")] });
    const lines = briefing(loadMemory(factoryHome, "r")).split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("- (evaluator, seen 2×) claim 0 (src/a.ts)");
    expect(lines[1]).toContain("claim 11");
    expect(briefing({ version: 1, repo: "r", entries: [] })).toBe("");
  });
});
