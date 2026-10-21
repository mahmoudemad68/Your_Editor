import { defineConfig } from "@playwright/test";
import path from "node:path";
const baseURL = process.env.GRADUATION_DEMO_URL;
if (!baseURL)
  throw new Error("Run the real graduation demo through pnpm render:test --graduation-demo.");
export default defineConfig({
  testDir: "../graduation-demo",
  workers: 1,
  retries: 0,
  timeout: 360_000,
  outputDir: path.resolve(__dirname, "../../../.local/graduation-demo/private/playwright"),
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    },
    trace: "off",
    screenshot: "off",
    video: "off",
    acceptDownloads: true,
  },
});
