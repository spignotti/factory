import { describe, expect, it } from "vitest";
import { FakeGitHub, type BaseStatus } from "../../src/gh.js";
import { pollCommitCi } from "../../src/pipeline/ci-wait.js";

function github(statuses: BaseStatus[]): FakeGitHub {
  const gh = new FakeGitHub();
  let i = 0;
  gh.baseStatus = async () => statuses[Math.min(i++, statuses.length - 1)]!;
  return gh;
}

const poll = (statuses: BaseStatus[], over: { waitMinutes?: number; waitWhile?: readonly BaseStatus[] } = {}) => {
  const slept: number[] = [];
  return {
    slept,
    done: pollCommitCi({
      github: github(statuses),
      repoDir: ".",
      sha: "abc",
      waitMinutes: over.waitMinutes ?? 2,
      pollMs: 30_000,
      waitWhile: over.waitWhile,
      sleep: async (ms) => void slept.push(ms),
    }),
  };
};

describe("pollCommitCi", () => {
  it("polls none until green when none is unsettled", async () => {
    const { slept, done } = poll(["none", "none", "green"], { waitWhile: ["pending", "none"] });
    expect(await done).toMatchObject({ status: "green" });
    expect(slept).toEqual([30_000, 30_000]);
  });

  it("returns none when the wait ends still none", async () => {
    const { slept, done } = poll(["none"], { waitMinutes: 1, waitWhile: ["pending", "none"] });
    expect(await done).toMatchObject({ status: "none" });
    expect(slept).toEqual([30_000, 30_000]);
  });

  it("returns pending when the wait ends still pending", async () => {
    const { slept, done } = poll(["pending"], { waitMinutes: 1 });
    expect(await done).toMatchObject({ status: "pending" });
    expect(slept).toEqual([30_000, 30_000]);
  });

  it("does not wait on none unless asked, and red settles at once", async () => {
    const none = poll(["none", "green"]);
    expect(await none.done).toMatchObject({ status: "none" });
    expect(none.slept).toEqual([]);
    const red = poll(["red"], { waitWhile: ["pending", "none"] });
    expect(await red.done).toMatchObject({ status: "red" });
    expect(red.slept).toEqual([]);
  });

  it("a zero wait is one sample", async () => {
    const { slept, done } = poll(["none", "green"], { waitMinutes: 0, waitWhile: ["pending", "none"] });
    expect(await done).toMatchObject({ status: "none", waitedMs: 0 });
    expect(slept).toEqual([]);
  });
});
