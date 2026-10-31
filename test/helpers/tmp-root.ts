import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes everything below `dir` owner-writable, so a read-only tree (e.g. a Go module cache) can be removed. */
function makeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st?.isDirectory()) continue;
      chmodSync(p, st.mode | 0o700);
      makeWritable(p);
    } catch {
      // best effort
    }
  }
}

/**
 * Vitest globalSetup: one temp root per `vitest run`. TMPDIR points into it before the workers start, so every
 * `mkdtempSync(join(tmpdir(), …))` in tests (and `mktemp` in the scripts they call) lands below it; teardown
 * removes the whole root. Without this every full test run left ~570 /tmp/factory-* folders behind
 * (≈60k inodes; the box ran out of inodes on 31.10).
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "factory-test-"));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  return () => {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  };
}
