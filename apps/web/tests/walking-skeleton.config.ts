import { defineConfig } from "@playwright/test";

/** Real Compose only: no webServer/test-owned API or fixture controls. */
export default defineConfig({
  testDir: "../walking-skeleton",
  outputDir: `../../../.local/walking-skeleton-artifacts/${process.env.WALKING_SKELETON_SCENARIO ?? "healthy"}/playwright`,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `../../.local/walking-skeleton-artifacts/${process.env.WALKING_SKELETON_SCENARIO ?? "healthy"}/results.json`,
      },
    ],
  ],
  use: {
    baseURL: "http://localhost:3000",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
