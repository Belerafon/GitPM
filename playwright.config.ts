import { defineConfig, devices } from "@playwright/test";

const apiUrl = "http://127.0.0.1:3100";
const webUrl = "http://127.0.0.1:5174";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.(?:ts|mjs)$/u,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: ".tmp/playwright-results",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: webUrl,
    locale: "ru-RU",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node scripts/start-e2e-server.mjs",
      url: `${apiUrl}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "corepack pnpm --filter @gitpm/web exec vite --host 127.0.0.1 --port 5174 --strictPort",
      url: webUrl,
      env: { GITPM_API_TARGET: apiUrl },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
