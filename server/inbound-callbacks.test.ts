import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pino from "pino";
import request from "supertest";
import { CALLER_IDS, RESERVED_CALLER_ID, type CallSession } from "../src/lib/domain.js";
import { inboundLoopbackCommand } from "../scripts/inbound-loopback.js";
import { createApp } from "./app.js";
import { InMemoryAuthStore, seedAdmin } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { EslClient } from "./esl.js";
import { InboundCallbackTracker } from "./inbound-callbacks.js";
import { callbackCallerId, inboundConfiguration } from "./inbound-config.js";
import { VoiceMetrics } from "./metrics.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";

const fixture = async (t: TestContext, record = false, maxConcurrentCalls = 5) => {
  const server = await new FakeEslServer().start();
  const client = new EslClient({ host: "127.0.0.1", port: server.port, password: fixtureEslPassword, timeoutMs: 300 });
  const store = new InMemoryStore();
  const logger = pino({ level: "silent" });
  const metrics = new VoiceMetrics(logger);
  const clipFile = `${randomUUID()}.wav`;
  store.createClip("Callback greeting fixture", 1, { format: "wav", telephonyAssetUrl: `/media/clips/${clipFile}` });
  const environment = { MKTR_INBOUND_CALLBACK_ENABLED: "true", MKTR_INBOUND_CLIP_FILE: clipFile, MKTR_INBOUND_RECORD_MESSAGE: String(record), MKTR_RECORDING_RETENTION_DAYS: "7", MKTR_MAX_CONCURRENT_CALLS: String(maxConcurrentCalls) };
  const tracker = new InboundCallbackTracker(client, store, { environment, now: () => Date.UTC(2026, 8, 11), metrics, logger });
  t.after(async () => { await tracker.close(); client.close(); await server.close(); });
  await client.connect();
  const emit = (name: string, id: string, extra: Record<string, string> = {}) => server.event(name, { "Unique-ID": id, variable_mktr_direction: "inbound_callback", variable_mktr_callback_to: CALLER_IDS[0], "Caller-Caller-ID-Number": "+6591234567", ...extra });
  return { server, client, store, tracker, metrics, emit, logger };
};

test("callback destinations derive from the caller-ID pool and unsafe or unbounded configuration is rejected", () => {
  const settings = inboundConfiguration({});
  assert.equal(settings.enabled, false);
  for (const id of CALLER_IDS) {
    assert.equal(callbackCallerId(id), id);
    assert.equal(callbackCallerId(id.slice(1)), id);
    assert.ok(new RegExp(settings.destinationExpression).test(id));
    assert.match(inboundLoopbackCommand(id), new RegExp(`loopback/\\${id}/public`));
  }
  assert.equal(callbackCallerId(RESERVED_CALLER_ID), undefined);
  assert.equal(new RegExp(settings.destinationExpression).test(RESERVED_CALLER_ID), false);
  assert.throws(() => inboundLoopbackCommand("+6590000000" as typeof CALLER_IDS[number]), /approved/);
  assert.throws(() => inboundConfiguration({ MKTR_INBOUND_CALLBACK_ENABLED: "true" }), /UUID.wav/);
  assert.throws(() => inboundConfiguration({ MKTR_INBOUND_CLIP_FILE: "../greeting.wav" }), /UUID.wav/);
  for (const environment of [{ MKTR_MAX_CONCURRENT_CALLS: "6" }, { MKTR_INBOUND_MAX_MESSAGE_SECONDS: "0" }, { MKTR_RECORDING_RETENTION_DAYS: "366" }]) assert.throws(() => inboundConfiguration(environment), /integer/);
  assert.throws(() => inboundConfiguration({ MKTR_INBOUND_RECORD_MESSAGE: "true" }), /callbacks/);
});

test("fake ESL inbound answer and hangup create one authenticated history call and occupy then release a slot", async (t) => {
  const { store, tracker, emit, logger, metrics, server } = await fixture(t);
  const adapter = new SimulatedTelephonyAdapter();
  const calls = new CallOrchestrator(store, adapter);
  const id = randomUUID();
  emit("CHANNEL_ANSWER", id);
  emit("CHANNEL_ANSWER", id);
  await waitFor(() => store.getCall(id)?.status === "answered");
  await tracker.flush();
  assert.equal(calls.activeCallCount(), 1);
  assert.ok(store.getFlowVersion(store.getCall(id)!.flowId, 1));
  const greeting = store.listClips().find((clip) => clip.name === "Callback greeting fixture")!;
  assert.equal(store.isClipReferencedByPublishedVersion(greeting.id), true);
  assert.equal(store.getCall(id)!.events.filter((event) => event.type === "inbound_callback").length, 1);
  emit("CHANNEL_HANGUP_COMPLETE", id, { "Hangup-Cause": "NORMAL_CLEARING" });
  await waitFor(() => store.getCall(id)?.status === "ended");
  emit("CHANNEL_HANGUP_COMPLETE", id);
  await tracker.flush();
  assert.equal(calls.activeCallCount(), 0);
  assert.equal(store.getCall(id)?.outcome, "inbound_callback");
  assert.equal(store.getCall(id)?.recordingFile, undefined);
  assert.ok(server.commands.every((command) => !command.includes("originate") && !command.includes("uuid_kill")));
  assert.match(await metrics.registry.metrics(), /mktr_calls_total\{outcome="inbound_callback"\} 1/);

  const authStore = new InMemoryAuthStore();
  const password = randomUUID();
  await seedAdmin(authStore, { MKTR_ADMIN_EMAIL: "inbound@example.test", MKTR_ADMIN_PASSWORD: password });
  const { app } = createApp({ store, adapter, calls, authStore, classifier: new RuleClassifier(), logger, metrics });
  await request(app).get(`/api/calls/${id}`).expect(401);
  const login = await request(app).post("/api/auth/login").send({ email: "inbound@example.test", password }).expect(200);
  const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  const history = await request(app).get("/api/bootstrap").set("Cookie", cookie).expect(200);
  assert.equal(history.body.calls.filter((call: CallSession) => call.id === id).length, 1);
  assert.equal(history.body.calls.find((call: CallSession) => call.id === id).direction, "inbound_callback");
});

test("callback tracker ignores unapproved destinations, foreign directions and unsafe UUIDs", async (t) => {
  const { store, emit } = await fixture(t);
  emit("CHANNEL_ANSWER", randomUUID(), { variable_mktr_callback_to: "+6590000000" });
  emit("CHANNEL_ANSWER", randomUUID(), { variable_mktr_direction: "outbound" });
  emit("CHANNEL_ANSWER", "bad-uuid\napi originate injected");
  const validId = randomUUID();
  emit("CHANNEL_ANSWER", validId);
  await waitFor(() => Boolean(store.getCall(validId)));
  assert.equal(store.listCalls().length, 1);
});

test("optional callback recording keeps only the channel UUID leaf and expiry, including metadata after operator stop", async (t) => {
  const { store, tracker, emit } = await fixture(t, true);
  const id = randomUUID();
  emit("CHANNEL_ANSWER", id);
  await waitFor(() => Boolean(store.getCall(id)));
  store.saveCall({ ...store.getCall(id)!, status: "ended", endedAt: "2026-09-11T00:00:00.000Z" });
  emit("CHANNEL_HANGUP_COMPLETE", id, { variable_mktr_recording_file: `${id}.wav`, variable_record_ms: "1200" });
  await waitFor(() => Boolean(store.getCall(id)?.recordingFile));
  await tracker.flush();
  assert.equal(store.getCall(id)?.recordingFile, `${id}.wav`);
  assert.equal(store.getCall(id)?.recordingExpiresAt, "2026-09-18T00:00:00.000Z");
  const invalidId = randomUUID();
  emit("CHANNEL_HANGUP_COMPLETE", invalidId, { variable_mktr_recording_file: "../private.wav", variable_record_ms: "1200" });
  await waitFor(() => Boolean(store.getCall(invalidId)));
  assert.equal(store.getCall(invalidId)?.recordingFile, undefined);
});

test("callback capacity overflow sends one bounded UUID hangup and retains earlier occupied slots", async (t) => {
  const { store, server, tracker, emit } = await fixture(t, false, 1);
  const first = randomUUID();
  const second = randomUUID();
  emit("CHANNEL_ANSWER", first);
  emit("CHANNEL_ANSWER", second);
  await waitFor(() => store.getCall(second)?.status === "failed");
  await tracker.flush();
  assert.equal(store.getCall(first)?.status, "answered");
  assert.deepEqual(server.commands.filter((command) => command.startsWith("api uuid_kill")), [`api uuid_kill ${second} USER_BUSY`]);
});

test("inbound callbacks share the orchestrator ceiling and shutdown while bypassing outbound playback and AMD", async (t) => {
  const f = await fixture(t);
  const { FreeSwitchEslAdapter } = await import("./telephony.js");
  f.server.respond = (command) => command === "api show channels as json" ? JSON.stringify({ row_count: 0, rows: [] }) : "+OK";
  const calls = new CallOrchestrator(f.store, new FreeSwitchEslAdapter(f.client, true));
  await calls.initialize();
  try {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const id of ids) f.emit("CHANNEL_ANSWER", id);
    await waitFor(() => calls.activeCallCount() === 5); await f.tracker.flush();
    for (const id of ids) { f.emit("CHANNEL_ANSWER", id); f.emit("PLAYBACK_STOP", id); await calls.markAnswered(id); }
    await f.tracker.flush();
    await assert.rejects(calls.start({ destination: "+6591234519", callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" }), /5-call limit/);
    assert.equal(f.server.commands.some((command) => /originate|uuid_broadcast|api avmd/.test(command)), false);
    assert.equal(calls.activeCallCount(), 5);
    await calls.shutdown();
    assert.equal(calls.activeCallCount(), 0);
    assert.equal(f.server.commands.filter((command) => command.startsWith("api uuid_kill")).length, 5);
    for (const id of ids) assert.equal(calls.get(id)?.outcome, "inbound_callback");
  } finally { await calls.shutdown(); }
});
