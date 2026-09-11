import { createApp } from "./app.js";
import { InMemoryAuthStore, seedAdmin } from "./auth.js";
import { config } from "./config.js";
import { createTranscriptClassifier } from "./classifier.js";
import { logger } from "./logger.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { createTelephonyAdapter } from "./telephony.js";

const store = new InMemoryStore();
const authStore = new InMemoryAuthStore();
await seedAdmin(authStore);
const adapter = createTelephonyAdapter();
const classifier = createTranscriptClassifier();
const calls = new CallOrchestrator(store, adapter, classifier);
const { app } = createApp({ store, adapter, classifier, calls, authStore });
app.listen(config.port, () => logger.info({ port: config.port, mode: adapter.mode }, "MKTR Voice API listening"));
