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
  });
});
