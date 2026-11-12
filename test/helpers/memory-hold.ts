// Holds the findings lock for HOLD_MS, then writes one entry. Signals readiness once the lock is taken.
import { writeFileSync } from "node:fs";
import { updateMemory } from "../../src/memory.js";

const [factoryHome, repoId, holdMs, readyFile] = process.argv.slice(2) as [string, string, string, string];
const ts = new Date().toISOString();
updateMemory(factoryHome, repoId, (mem) => {
  writeFileSync(readyFile, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  mem.entries.push({
    key: "holder",
    text: "held",
    reviewer: "plan",
    checkable: "no",
    check_sketch: "",
    count: 1,
    first_seen: ts,
    last_seen: ts,
    runs: ["holder"],
    status: "open",
    ref: null,
    disposition: "confirmed",
  });
});
