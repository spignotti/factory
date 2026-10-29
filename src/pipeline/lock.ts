import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Per-task lock `<factoryHome>/locks/<repo-id>-<task>.lock`. A lock whose process is gone is stale
 * and taken over. Returns a release function, or undefined when the lock is held.
 */
export function acquireTaskLock(factoryHome: string, repoId: string, task: string): (() => void) | undefined {
  const dir = join(factoryHome, "locks");
  mkdirSync(dir, { recursive: true });
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  const path = join(dir, `${safe(repoId)}-${safe(task)}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
}
