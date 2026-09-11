import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { FlowDefinition, FlowEdge, FlowNode } from "../src/lib/domain.js";
import { InMemoryStore } from "./store.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { createApp } from "./app.js";
import { InMemoryAuthStore } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { EslClient } from "./esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";
import { FakeMediaWorker } from "./test-support/fake-media-worker.js";

const token = "Bearer fixture-token-url-safe";

function listenFlow(id: string, listens: number): FlowDefinition {
  const nodes: FlowNode[] = [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } }];
  const edges: FlowEdge[] = [];
  for (let index = 0; index < listens; index++) {
    nodes.push({ id: `listen-${index}`, type: "listen", position: { x: index + 1, y: 0 }, data: { label: `Listen ${index}`, endpointingMs: 300 } });
    edges.push({ id: `e-${index}`, source: index === 0 ? "start" : `listen-${index - 1}`, target: `listen-${index}`, ...(index === 0 ? {} : { condition: { fallback: true } }) });
  }
  nodes.push({ id: "end", type: "end", position: { x: listens + 1, y: 0 }, data: { label: "End" } });
  edges.push({ id: "e-end", source: `listen-${listens - 1}`, target: "end", condition: { fallback: true } });
  return { id, name: id, version: 1, status: "published", updatedAt: new Date().toISOString(), startNodeId: "start", nodes, edges };
}

async function fixture(t: { after(fn: () => unknown): void }, flowId: string, listens: number) {
  const store = new InMemoryStore();
  store.saveFlow(listenFlow(flowId, listens));
  const fake = new FakeEslServer(); await fake.start(); t.after(() => fake.close());
  const media = await new FakeMediaWorker().start(); t.after(() => media.close());
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true, { webhookToken: "fixture-token-url-safe", workerUrl: media.url }); t.after(() => adapter.close());
  let classifications = 0;
  const classifier = new RuleClassifier();
  const calls = new CallOrchestrator(store, adapter, { mode: "rules", async classify(text) { classifications++; return classifier.classify(text); } });
  const { app } = createApp({ store, adapter, classifier, calls, authStore: new InMemoryAuthStore(), mediaGatewayToken: "fixture-token-url-safe" });
  const streams = (suffix: string) => fake.commands.filter((value) => value.includes("uuid_audio_stream") && value.includes(suffix));
  return { store, fake, media, adapter, calls, app, streams, classifications: () => classifications };
}

test("one audio stream starts at answer, serves every listen window and stops with the channel", async (t) => {
  const f = await fixture(t, "two-listens", 2);
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "two-listens" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  // The stream is addressed to the call, not to a window, and started before the first window.
  assert.deepEqual(f.streams(" start ").map((command) => command.split(" ")[4]), [`ws://127.0.0.1:${f.media.port}/audio/${call.id}`]);
  assert.equal(f.streams(" stop").length, 0);

  const first = f.calls.get(call.id)!.listenWindowId!;
  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "hello", windowId: first, utteranceId: randomUUID() }).expect(200);
  await waitFor(() => f.calls.get(call.id)?.status === "listening" && f.calls.get(call.id)?.listenWindowId !== first);
  const second = f.calls.get(call.id)!.listenWindowId!;
  assert.equal(f.streams(" start ").length, 1, "the second window reuses the call's stream");

  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "no need", windowId: second, utteranceId: randomUUID() }).expect(200);
  await waitFor(() => f.calls.get(call.id)?.status === "ended");
  assert.deepEqual(f.media.opened(call.id).map(({ windowId }) => windowId), [first, second]);
  assert.deepEqual(f.media.closed(call.id).map(({ windowId }) => windowId), [first, second]);
  // Cleanup on hangup: the stream stops once, immediately before the channel is killed.
  assert.deepEqual(f.streams(" stop").length, 1);
  const commands = f.fake.commands.filter((value) => value.includes("uuid_audio_stream") || value.includes("uuid_kill"));
  assert.match(commands.at(-2)!, /uuid_audio_stream \S+ stop$/);
  assert.match(commands.at(-1)!, /uuid_kill/);
});

test("HTTP transcript receipts reject stale windows and replay safely after flow completion", async (t) => {
  const f = await fixture(t, "window-flow", 1);
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "window-flow" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  await waitFor(() => f.streams(" start ").length === 1);
  const info = await request(f.app).get(`/api/media/calls/${call.id}/window`).set("Authorization", token).expect(200);
  // A receipt naming any other window is refused even while the call is listening.
  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "yes", windowId: randomUUID(), utteranceId: randomUUID() }).expect(409);
  const receipt = { transcript: "yes", windowId: info.body.listenWindowId, utteranceId: randomUUID(), sttLatencyMs: 80 };
  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send(receipt).expect(200);
  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send(receipt).expect(200);
  assert.equal(f.classifications(), 1); assert.equal(f.calls.get(call.id)?.status, "ended");
  assert.equal(f.fake.commands.filter((value) => value.includes("uuid_kill")).length, 1);
  assert.equal(f.streams(" stop").length, 1);
});

test("a worker that refuses a listen window fails the call instead of leaving it deaf", async (t) => {
  const f = await fixture(t, "refused", 1);
  f.media.status = 500;
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "refused" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "failed");
  assert.match(f.calls.get(call.id)!.endReason!, /returned HTTP 500/);
  assert.equal(f.streams(" stop").length, 1, "the call's stream is stopped with its channel");
});

test("a worker that never confirms a closed window does not fail a call that already answered", async (t) => {
  const f = await fixture(t, "close-refused", 1);
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "close-refused" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  f.media.status = 500;
  const windowId = f.calls.get(call.id)!.listenWindowId!;
  await request(f.app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "yes", windowId, utteranceId: randomUUID() }).expect(200);
  await waitFor(() => f.calls.get(call.id)?.status === "ended");
  assert.equal(f.calls.get(call.id)?.endReason, "Flow completed");
});

test("an API restart hangs up an interrupted call and stops its audio stream", async (t) => {
  const f = await fixture(t, "restart", 1);
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "restart" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  assert.equal(f.streams(" start ").length, 1);
  // A fresh orchestrator over the same store is what a restart looks like; the channel is still up.
  f.fake.respond = (command) => command.startsWith("api show channels as json")
    ? JSON.stringify({ row_count: 1, rows: [{ uuid: call.providerCallId }] })
    : command.includes("origination_caller_id_name") ? "MKTR" : "+OK";
  const restarted = new CallOrchestrator(f.store, f.adapter, new RuleClassifier());
  await restarted.initialize();
  assert.equal(f.calls.get(call.id)?.status, "failed");
  assert.equal(f.calls.get(call.id)?.endReason, "SERVICE_RESTART");
  assert.equal(f.streams(" stop").length, 1);
  assert.equal(f.fake.commands.filter((value) => value.includes("uuid_kill")).length, 1);
});

test("a flow that only announces opens no speech stream and buys no provider minutes", async (t) => {
  const f = await fixture(t, "announce", 1);
  const clip = f.store.createClip("Announcement", 1, { assetUrl: "/media/clips/a.mp3", telephonyAssetUrl: "/media/clips/33333333-3333-3333-3333-333333333333.wav", format: "wav" });
  f.store.saveFlow({ id: "announce-only", name: "Announce only", version: 1, status: "published", updatedAt: new Date().toISOString(), startNodeId: "start",
    nodes: [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
      { id: "clip", type: "playClip", position: { x: 1, y: 0 }, data: { label: "Notice", clipId: clip.id } },
      { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }],
    edges: [{ id: "a", source: "start", target: "clip" }, { id: "b", source: "clip", target: "end" }] });
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "announce-only" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.fake.commands.some((command) => command.includes("uuid_broadcast")));
  assert.deepEqual(f.streams(" start "), []);
  assert.deepEqual(f.media.windows, []);
});

test("a refused audio stream stop still terminates the channel", async (t) => {
  const f = await fixture(t, "stubborn-stream", 1);
  const call = await f.calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "stubborn-stream" });
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  f.fake.respond = (command) => command.includes("uuid_audio_stream") && command.endsWith(" stop") ? "-ERR injected stream failure" : "+OK";
  await f.calls.stop(call.id);
  await waitFor(() => f.calls.get(call.id)?.status === "ended");
  assert.equal(f.fake.commands.filter((value) => value.includes("uuid_kill")).length, 1);
});
