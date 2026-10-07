import { defineConfig } from "vitest/config";

/** Shared convention for domain and future TypeScript unit suites.
 * Resolve src/ and coverage/ against the invoking package's working directory. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 5000,
    hookTimeout: 10000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // The sole authoritative domain percentage gate (also used by the proof).
      thresholds: { lines: 80 },
    },
  },
});
