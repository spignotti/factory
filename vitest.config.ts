import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Per-run temp root, removed after the run: tests leave nothing in /tmp.
    globalSetup: ["test/helpers/tmp-root.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
