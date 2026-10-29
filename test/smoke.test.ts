import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("cli", () => {
  it("loads", async () => {
    expect(await main([])).toBe(0);
  });
});
