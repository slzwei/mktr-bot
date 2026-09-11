import { startRecordingPurger } from "./recordings.js";
import { createApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { config } from "./config.js";
import { createTranscriptClassifier } from "./classifier.js";
import { logger } from "./logger.js";
import { CallOrchestrator } from "./orchestrator.js";
import { initializeStore } from "./runtime-store.js";
import { createTelephonyAdapter } from "./telephony.js";
import { installShutdown } from "./shutdown.js";
import { CampaignDialer } from "./campaigns.js";
import { OutcomeDispatcher } from "./outcome-delivery.js";
import { attachInboundCallbacks } from "./inbound-callbacks.js";

const { store, authStore } = await initializeStore();
await seedAdmin(authStore);
const adapter = createTelephonyAdapter();
const classifier = createTranscriptClassifier();
const calls = new CallOrchestrator(store, adapter, classifier);
const inboundCallbacks = await attachInboundCallbacks(adapter, store);
await calls.initialize();
const recordingPurger = await startRecordingPurger(store, config.recording);
const campaignDialer = new CampaignDialer(store, calls);
const outcomeDispatcher = new OutcomeDispatcher(store, config.outcomeWebhook);
const { app, closeSseStreams } = createApp({ store, adapter, classifier, calls, authStore, campaignDialer });
campaignDialer.start();
outcomeDispatcher.start();
const server = app.listen(config.port, () => logger.info({ port: config.port, mode: adapter.mode }, "MKTR Voice API listening"));
installShutdown({ server, calls, closeSseStreams,
  beforeDrain: async () => {
    const results = await Promise.allSettled([campaignDialer.close(), outcomeDispatcher.close(), recordingPurger.close()]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Background services could not be fully drained.");
  }, closeStore: async () => { try { await inboundCallbacks?.close(); } finally { await store.close(); } }, logger });
