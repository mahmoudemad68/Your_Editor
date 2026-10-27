import { defineConfig } from "@playwright/test";
import path from "node:path";
if (!process.env.CAPTION_DEMO_URL)
  throw new Error("Use the real caption render qualification driver.");
export default defineConfig({
  testDir: "../caption-demo",
  workers: 1,
  retries: 0,
  timeout: 360000,
  outputDir: path.resolve(__dirname, "../../../.local/caption-private/playwright"),
  reporter: "list",
  use: {
    baseURL: process.env.CAPTION_DEMO_URL,
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
