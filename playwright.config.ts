import path from "node:path";
import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const apiPort = process.env.MKTR_E2E_API_PORT || "18877";
const webPort = process.env.MKTR_E2E_WEB_PORT || "15173";
const webOrigin = `http://127.0.0.1:${webPort}`;
process.env.MKTR_E2E_ADMIN_EMAIL ??= "e2e-operator@example.test";
process.env.MKTR_E2E_ADMIN_PASSWORD ??= randomBytes(32).toString("hex");
process.env.MKTR_E2E_AUTH_STATE = path.resolve("test-results", `auth-${apiPort}.json`);

export default defineConfig({
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", testIgnore: /(auth\.setup|sse-restart\.spec)\.ts/, dependencies: ["setup"], use: { storageState: process.env.MKTR_E2E_AUTH_STATE } }
  ],
  testDir: "./tests",
  workers: 1,
  use: {
    baseURL: webOrigin,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "node --import tsx server/index.ts",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: {
        PORT: apiPort,
        MKTR_STORE: "memory",
        MKTR_WEB_ORIGIN: webOrigin,
        MKTR_ADMIN_EMAIL: process.env.MKTR_E2E_ADMIN_EMAIL,
        MKTR_ADMIN_PASSWORD: process.env.MKTR_E2E_ADMIN_PASSWORD,
        MKTR_TELEPHONY_MODE: "simulated",
        MKTR_DNC_ENABLED: "",
        MKTR_DNC_GATEWAY_URL: "",
        MKTR_DNC_GATEWAY_SECRET: "",
        MKTR_CLASSIFIER_MODE: "rules",
        MKTR_CLIP_STORAGE_DIR: path.resolve("test-results", "clips")
      }
    },
    {
      command: `npm run dev:web -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webOrigin,
      env: { MKTR_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }
    }
  ]
});
