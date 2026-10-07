import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3030",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      cwd: path.resolve(__dirname, ".."),
      command: "node ../../tests/e2e/us119-api.mjs",
      url: "http://127.0.0.1:3032/health",
      reuseExistingServer: false,
    },
    {
      cwd: path.resolve(__dirname, ".."),
      command: "pnpm start --hostname 127.0.0.1 --port 3030",
      url: "http://127.0.0.1:3030/health",
      env: { API_BASE_URL: "http://127.0.0.1:3031" },
      reuseExistingServer: false,
    },
  ],
});
