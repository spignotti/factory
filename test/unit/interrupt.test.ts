import { afterEach, describe, expect, it } from "vitest";
import { resetKilledCommands, sh } from "../../src/exec.js";
import { installSignalHandlers, Interrupted } from "../../src/interrupt.js";

describe("signal handlers", () => {
  afterEach(() => resetKilledCommands());

  it("first SIGTERM aborts with Interrupted and stops commands; second calls onSecond; uninstall removes them", async () => {
    const before = process.listenerCount("SIGTERM");
    const controller = new AbortController();
    const logs: string[] = [];
    const seconds: string[] = [];
    const uninstall = installSignalHandlers(controller, { log: (t) => logs.push(t), onSecond: (s) => seconds.push(s) });
    try {
      process.emit("SIGTERM", "SIGTERM");
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(Interrupted);
      expect((controller.signal.reason as Interrupted).message).toBe("interrupted by SIGTERM");
      expect(logs.join("")).toMatch(/SIGTERM received/);
      expect((await sh("echo x", { cwd: "/", env: {} })).code).toBe(130);
      process.emit("SIGINT", "SIGINT");
      expect(seconds).toEqual(["SIGINT"]);
    } finally {
      uninstall();
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
