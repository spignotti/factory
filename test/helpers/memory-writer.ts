// Child process for the concurrent memory upsert test: flushes one observation set as one run.
import { flushMemory } from "../../src/memory.js";

const [factoryHome, repoId, runId, keys] = process.argv.slice(2) as [string, string, string, string];
const observations = keys.split(",").map((key) => ({ key, text: `finding ${key}`, reviewer: "plan", checkable: "test" as const, check_sketch: "" }));
for (let i = 0; i < 5; i++) flushMemory({ factoryHome, repoId, runId: `${runId}-${i}`, now: new Date(), observations });
