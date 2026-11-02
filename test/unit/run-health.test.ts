import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/events.js";
import { orphanedRunIds, isQueuedWaiter, queuedFromEvents } from "../../src/run-health.js";
import { readEvents, type RunRecord } from "../../src/runs.js";

describe("run-health", () => {
  it("orphanedRunIds lists run ids on locks whose pid is dead", () => {
    const home = join(tmpdir(), `orphan-${Date.now()}`);
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", "repo.lock"), "999999999\n20261030-120000-dead01");
    expect([...orphanedRunIds(home)]).toEqual(["20261030-120000-dead01"]);
  });

  it("isQueuedWaiter is true when queued was emitted but lock not acquired", () => {
    const dir = join(tmpdir(), `queued-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const events = new EventLog(dir, "20261030-130000-abc123", () => Date.now(), []);
    events.emit({ step: "intake", event: "queued", data: { repo: "https://github.com/o/r.git", holder_run_id: "x", holder_pid: 1 } });
    const run: RunRecord = { run_id: "20261030-130000-abc123", dir, started_at: new Date() };
    const ev = readEvents(run);
    expect(isQueuedWaiter(run, ev)).toBe(true);
    expect(queuedFromEvents(ev)).toMatchObject({ holder_run_id: "x", holder_pid: 1 });
  });
});
