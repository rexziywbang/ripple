import { defineConfig, devices } from "@playwright/test";

const PORT = 3111;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx concurrently -k "npx next dev -p ${PORT}" "npx tsx worker/index.ts"`,
    url: `http://localhost:${PORT}/api/projects`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_PATH: "data/e2e.db" },
  },
});
