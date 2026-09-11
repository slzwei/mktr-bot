import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { InMemoryStore } from "./store.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { createApp } from "./app.js";
import { InMemoryAuthStore } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { EslClient } from "./esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";

test("HTTP transcript receipts reject stale windows and replay safely after flow completion", async (t) => {
  const store = new InMemoryStore();
  store.saveFlow({ id: "window-flow", name: "Window flow", version: 1, status: "published", updatedAt: new Date().toISOString(), startNodeId: "start", nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "listen", type: "listen", position: { x: 1, y: 0 }, data: { label: "Listen" } },
    { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }
  ], edges: [{ id: "a", source: "start", target: "listen" }, { id: "b", source: "listen", target: "end", condition: { fallback: true } }] });
  const fake = new FakeEslServer(); await fake.start(); t.after(() => fake.close());
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true, { webhookToken: "fixture-token-url-safe", workerUrl: "ws://media-worker:8090" }); t.after(() => adapter.close());
  let classifications = 0;
  const classifier = new RuleClassifier();
  const calls = new CallOrchestrator(store, adapter, { mode: "rules", async classify(text) { classifications++; return classifier.classify(text); } });
  const { app } = createApp({ store, adapter, classifier, calls, authStore: new InMemoryAuthStore(), mediaGatewayToken: "fixture-token-url-safe" });
  const call = await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "window-flow" });
  fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => calls.get(call.id)?.status === "listening");
  await waitFor(() => fake.commands.some((value) => value.includes("uuid_audio_stream") && value.includes(" start ")));
  const token = "Bearer fixture-token-url-safe";
  const info = await request(app).get(`/api/media/calls/${call.id}/window`).set("Authorization", token).expect(200);
  await request(app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "yes", windowId: randomUUID(), utteranceId: randomUUID() }).expect(409);
  const receipt = { transcript: "yes", windowId: info.body.listenWindowId, utteranceId: randomUUID(), sttLatencyMs: 80 };
  await request(app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send(receipt).expect(200);
  await request(app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send(receipt).expect(200);
  assert.equal(classifications, 1); assert.equal(calls.get(call.id)?.status, "ended");
  assert.equal(fake.commands.filter((value) => value.includes("uuid_kill")).length, 1);
  assert.equal(fake.commands.filter((value) => value.includes("uuid_audio_stream") && value.endsWith(" stop")).length, 1);
});
