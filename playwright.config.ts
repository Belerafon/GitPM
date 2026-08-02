import { defineConfig, devices } from "@playwright/test";

const worktreeApiUrl = "http://127.0.0.1:3100";
const worktreeWebUrl = "http://127.0.0.1:5174";
const directApiUrl = "http://127.0.0.1:3200";
const directWebUrl = "http://127.0.0.1:5274";
const configuredWorkers = Number(process.env.GITPM_E2E_WORKERS);
const workers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : 1;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.(?:ts|mjs)$/u,
  fullyParallel: false,
  workers,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: ".tmp/playwright-results",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    locale: "ru-RU",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-worktree", grepInvert: /@direct/u, use: { ...devices["Desktop Chrome"], baseURL: worktreeWebUrl } },
    { name: "chromium-direct", grep: /@(parity|direct)/u, use: { ...devices["Desktop Chrome"], baseURL: directWebUrl } },
  ],
  webServer: [
    {
      command: "node scripts/start-e2e-server.mjs worktree 3100",
      url: `${worktreeApiUrl}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "corepack pnpm --filter @gitpm/web exec vite --host 127.0.0.1 --port 5174 --strictPort",
      url: worktreeWebUrl,
      env: { GITPM_API_TARGET: worktreeApiUrl },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node scripts/start-e2e-server.mjs direct 3200",
      url: `${directApiUrl}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "corepack pnpm --filter @gitpm/web exec vite --host 127.0.0.1 --port 5274 --strictPort",
      url: directWebUrl,
      env: { GITPM_API_TARGET: directApiUrl },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
