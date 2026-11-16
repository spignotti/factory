import { describe, expect, it } from "vitest";
import { withThinking } from "../../src/commands/improve.js";
import type { Profile } from "../../src/schemas/profile.js";

describe("improve thinking", () => {
  it("sets the repo level on the first model and keeps the fallback's own level", () => {
    const profile = {
      roles: {
        harden: [
          { model: "a/first", thinking: "medium" },
          { model: "b/fallback", thinking: "xhigh" },
        ],
      },
    } as unknown as Profile;
    const out = withThinking(profile, "harden", "high");
    expect(out.roles.harden).toEqual([
      { model: "a/first", thinking: "high" },
      { model: "b/fallback", thinking: "xhigh" },
    ]);
    expect(profile.roles.harden[0]!.thinking).toBe("medium");
  });
});
