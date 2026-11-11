import { describe, expect, it } from "vitest";
import { improveAspectArgs } from "../../src/cli.js";

describe("improve --aspect", () => {
  it("accepts several values after one flag, repeated flags and comma lists", () => {
    expect(improveAspectArgs(["ci"], ["tests"])).toEqual(["ci", "tests"]);
    expect(improveAspectArgs(["ci", "tests"], [])).toEqual(["ci", "tests"]);
    expect(improveAspectArgs(["ci,tests", " security "], [])).toEqual(["ci", "tests", "security"]);
  });
});
