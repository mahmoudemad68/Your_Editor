import { defineConfig } from "@playwright/test";
import path from "node:path";

const artifacts = path.resolve(
  __dirname,
  "../../../.local/walking-skeleton-artifacts",
  process.env.WALKING_SKELETON_SCENARIO ?? "healthy",
);

/** Real Compose only: no webServer/test-owned API or fixture controls. */
export default defineConfig({
  testDir: "../walking-skeleton",
  outputDir: path.join(artifacts, "playwright"),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: path.join(artifacts, "results.json"),
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
