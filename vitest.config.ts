import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 60_000,
    maxWorkers: 4,
    maxConcurrency: 2,
    coverage: {
      enabled: false,
    },
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    passWithNoTests: false,
  },
});
