import { defineConfig } from "vitest/config";

const configuredWorkers = Number(process.env.GITPM_TEST_WORKERS);
const maxWorkers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : 2;

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 60_000,
    maxWorkers,
    maxConcurrency: 2,
    env: {
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
    },
    coverage: {
      enabled: false,
    },
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    passWithNoTests: false,
  },
});
