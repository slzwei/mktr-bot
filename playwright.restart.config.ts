import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /sse-restart\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { viewport: { width: 1440, height: 1000 }, actionTimeout: 10_000, trace: "retain-on-failure" }
});
