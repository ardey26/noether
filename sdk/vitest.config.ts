import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Yaci tests hit a real node: generous timeouts, and never in parallel
    // (a timed-out test keeps running and would race the next one).
    testTimeout: 900_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
