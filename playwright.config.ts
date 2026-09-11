import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:15173",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "node --import tsx server/index.ts",
      url: "http://127.0.0.1:18877/api/health",
      env: {
        PORT: "18877",
        MKTR_TELEPHONY_MODE: "simulated",
        MKTR_CLASSIFIER_MODE: "rules",
        MKTR_CLIP_STORAGE_DIR: path.resolve("test-results", "clips")
      }
    },
    {
      command: "npm run dev:web -- --host 127.0.0.1 --port 15173 --strictPort",
      url: "http://127.0.0.1:15173",
      env: { MKTR_API_PROXY_TARGET: "http://127.0.0.1:18877" }
    }
  ]
});
