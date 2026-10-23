import { defineConfig } from "@playwright/test";
import path from "node:path";

/** QA-owned config: real Compose stack only, no webServer, routes or fixtures. */
export default defineConfig({
  testDir: ".",
  testMatch: "independent.spec.ts",
  outputDir: path.join(process.env.QA_PRIVATE ?? "/tmp/qa-private", "playwright"),
  workers: 1,
  retries: 0,
  timeout: 100 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    browserName: "chromium",
    launchOptions: { executablePath: "/opt/google/chrome/chrome", args: ["--no-sandbox"] },
    acceptDownloads: true,
    trace: "off",
    screenshot: "off",
  },
});
