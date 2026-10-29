import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { briefing, canonicalRepoId, memoryKey, flushMemory, loadMemory, memoryPath, observations, repoDirName } from "../../src/memory.js";
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

  it("observations: open non-nit findings plus flaky checks", () => {
    const obs = observations(
      [finding(), finding({ id: "F2", severity: "nit", claim: "naming" }), finding({ id: "F3", status: "resolved", claim: "x" }), finding({ id: "F4", status: "accepted_wontfix", claim: "y" })],
      ["test"],
    );
    expect(obs.map((o) => o.key)).toEqual([memoryKey(finding()), "flaky:test"]);
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
