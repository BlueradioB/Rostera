import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4174/api/health",
    reuseExistingServer: !process.env.CI,
    env: {
      HOST: "127.0.0.1",
      PORT: "4174",
      ROSTERA_DATABASE: resolve(".playwright/rostera.sqlite"),
      ROSTERA_BACKUP_INTERVAL_MS: "86400000"
    },
    timeout: 30_000
  }
});
