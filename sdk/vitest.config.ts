import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Yaci tests hit a real node: generous timeouts, and never in parallel
    // (a timed-out test keeps running and would race the next one).
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
