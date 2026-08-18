import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:3001",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "systemctl restart terrence.service && sleep 2",
    url: "http://127.0.0.1:3001/readyz",
    reuseExistingServer: true,
  },
});
