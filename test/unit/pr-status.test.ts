import { describe, expect, it } from "vitest";
import { prStatusFromView } from "../../src/gh.js";

describe("prStatusFromView", () => {
  it("reads draft, failing checks, behind and conflicting from a gh pr view payload", () => {
    expect(
      prStatusFromView({
        state: "OPEN",
        isDraft: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
        statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    ).toEqual({ state: "open", draft: true, ci: "red", behind: true, conflicting: false });

    expect(
      prStatusFromView({
        state: "MERGED",
        isDraft: false,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        statusCheckRollup: { nodes: [{ conclusion: "SUCCESS", status: "COMPLETED" }] },
      }),
    ).toEqual({ state: "merged", draft: false, ci: "green", behind: false, conflicting: true });

    expect(prStatusFromView({ state: "CLOSED", isDraft: false, mergeStateStatus: "UNSTABLE", statusCheckRollup: [] })).toEqual({
      state: "closed",
      draft: false,
      ci: "red",
      behind: false,
      conflicting: false,
    });

    expect(prStatusFromView({ state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] })).toMatchObject({ ci: "pending" });
    expect(prStatusFromView({ state: "OPEN", statusCheckRollup: [] })).toMatchObject({ ci: "none" });
    expect(prStatusFromView({ state: "OPEN" })).toMatchObject({ ci: "none" });
  });

  it("uses aggregateCheckRuns: latest run wins, a draft hold is pending, a skipped done is red", () => {
    expect(
      prStatusFromView({
        state: "OPEN",
        statusCheckRollup: [
          { name: "check", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-06T00:00:01Z", id: 1 },
          { name: "check", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-06T00:05:00Z", id: 2 },
          { name: "done", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-06T00:06:00Z", id: 3 },
          { name: "dependabot", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-06T00:00:01Z", id: 4 },
        ],
      }),
    ).toMatchObject({ ci: "green" });

    expect(
      prStatusFromView({
        state: "OPEN",
        statusCheckRollup: [
          { name: "select", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-06T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/11/job/1" },
          { name: "check", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-06T00:00:00Z", detailsUrl: "https://github.com/o/r/actions/runs/11/job/2" },
          { name: "done", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-06T00:00:01Z", detailsUrl: "https://github.com/o/r/actions/runs/11/job/3" },
        ],
      }),
    ).toMatchObject({ ci: "pending" });

    expect(
      prStatusFromView({
        state: "OPEN",
        statusCheckRollup: [
          { name: "done", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-06T00:00:01Z", suite: 1, id: 1 },
          { name: "select", status: "COMPLETED", conclusion: "SKIPPED", suite: 1, id: 2 },
          { name: "select", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-06T00:01:00Z", suite: 2, id: 3 },
          { name: "done", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-06T00:03:00Z", suite: 2, id: 4 },
        ],
      }),
    ).toMatchObject({ ci: "green" });

    expect(
      prStatusFromView({
        state: "OPEN",
        statusCheckRollup: [{ name: "done", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-06T00:00:01Z" }],
      }),
    ).toMatchObject({ ci: "red" });
  });
});
