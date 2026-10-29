import { z } from "zod";
import type { MemoryEntry, MemoryFile } from "../memory.js";

/** SPEC §11 step 3: the LLM names duplicates; merging them is code. */
export const CompactionSchema = z.object({ merge: z.array(z.object({ keep: z.string().min(1), drop: z.array(z.string().min(1)).min(1) }).strict()) }).strict();
export type Compaction = z.infer<typeof CompactionSchema>;

const MAX_RUNS = 20;

/** Only `open` entries take part; every key at most once. Returns the errors (empty = valid). */
export function validateCompaction(mem: MemoryFile, c: Compaction): string[] {
  const open = new Set(mem.entries.filter((e) => e.status === "open").map((e) => e.key));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const m of c.merge) {
    for (const k of [m.keep, ...m.drop]) {
      if (!open.has(k)) errors.push(`${k} is not an open memory entry`);
      if (seen.has(k)) errors.push(`${k} appears twice`);
      seen.add(k);
    }
  }
  return errors;
}

/** Merges each `drop` into its `keep`: counts summed, runs united, first/last seen widened. */
export function applyCompaction(mem: MemoryFile, c: Compaction): number {
  const byKey = new Map(mem.entries.map((e) => [e.key, e]));
  const dropped = new Set<string>();
  for (const m of c.merge) {
    const keep = byKey.get(m.keep)!;
    for (const k of m.drop) {
      const d: MemoryEntry = byKey.get(k)!;
      keep.count += d.count;
      keep.runs = [...new Set([...keep.runs, ...d.runs])].slice(-MAX_RUNS);
      if (d.first_seen < keep.first_seen) keep.first_seen = d.first_seen;
      if (d.last_seen > keep.last_seen) keep.last_seen = d.last_seen;
      if (keep.checkable === "no" && d.checkable !== "no") keep.checkable = d.checkable;
      if (!keep.check_sketch && d.check_sketch) keep.check_sketch = d.check_sketch;
      dropped.add(k);
    }
  }
  mem.entries = mem.entries.filter((e) => !dropped.has(e.key));
  return dropped.size;
}
