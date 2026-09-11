import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { LISTEN_ENDPOINTING, type CallSession, type FlowDefinition, type FlowNode } from "../src/lib/domain.js";
import { createApp } from "./app.js";
import { InMemoryAuthStore } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { EslClient } from "./esl.js";
import { validateFlow } from "./flow-validation.js";
import { listenWindow } from "./listen-window.js";
import { flowDefinitionSchema } from "./request-schemas.js";
import { InMemoryStore } from "./store.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";
import { FakeMediaWorker } from "./test-support/fake-media-worker.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";

const token = "Bearer fixture-token-url-safe";
const bounds = new RegExp(`needs endpointing from ${LISTEN_ENDPOINTING.minMs} to ${LISTEN_ENDPOINTING.maxMs} milliseconds`);
function flow(id: string, data: FlowNode["data"]): FlowDefinition {
  return { id, name: id, version: 1, status: "published", updatedAt: new Date().toISOString(), startNodeId: "start", nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "listen", type: "listen", position: { x: 1, y: 0 }, data },
    { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }
  ], edges: [{ id: "a", source: "start", target: "listen" }, { id: "b", source: "listen", target: "end", condition: { fallback: true } }] };
}

test("the media window lookup carries each listen node's endpointing, the shared default, and nothing once the window closes", async (t) => {
  const store = new InMemoryStore();
  store.saveFlow(flow("yes-no", { label: "Yes or no", endpointingMs: 180 }));
  store.saveFlow(flow("open-question", { label: "Open question" }));
  const fake = new FakeEslServer(); await fake.start(); t.after(() => fake.close());
  const media = await new FakeMediaWorker().start(); t.after(() => media.close());
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true, { webhookToken: "fixture-token-url-safe", workerUrl: media.url }); t.after(() => adapter.close());
  const calls = new CallOrchestrator(store, adapter, new RuleClassifier());
  const { app } = createApp({ store, adapter, classifier: new RuleClassifier(), calls, authStore: new InMemoryAuthStore(), mediaGatewayToken: "fixture-token-url-safe" });
  for (const [flowId, expected] of [["yes-no", 180], ["open-question", LISTEN_ENDPOINTING.defaultMs]] as const) {
    const call = await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId });
    fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
    await waitFor(() => calls.get(call.id)?.status === "listening");
    const listening = (await request(app).get(`/api/media/calls/${call.id}/window`).set("Authorization", token).expect(200)).body;
    assert.deepEqual(listening, { status: "listening", listenWindowId: calls.get(call.id)!.listenWindowId, endpointingMs: expected });
    // The same value reaches the worker, which holds one provider connection for the whole call.
    assert.deepEqual(media.opened(call.id).map(({ windowId, endpointingMs, authorization }) => ({ windowId, endpointingMs, authorization })),
      [{ windowId: listening.listenWindowId, endpointingMs: expected, authorization: "Bearer fixture-token-url-safe" }]);
    await request(app).post(`/api/calls/${call.id}/transcript`).set("Authorization", token).send({ transcript: "yes", windowId: listening.listenWindowId, utteranceId: randomUUID() }).expect(200);
    await waitFor(() => calls.get(call.id)?.status === "ended");
    assert.deepEqual(media.closed(call.id).map(({ windowId }) => windowId), [listening.listenWindowId]);
    assert.deepEqual((await request(app).get(`/api/media/calls/${call.id}/window`).set("Authorization", token).expect(200)).body, { status: "ended" });
  }
});

test("a listening call outside a valid listen node fails the lookup instead of guessing a window", () => {
  const graph = flow("guard", { label: "Guard", endpointingMs: LISTEN_ENDPOINTING.minMs - 1 });
  const call: CallSession = { id: "call-guard", providerCallId: "provider-guard", destination: "+6591234567", callerId: "+6562773211", flowId: "guard", flowVersion: 1, status: "listening", currentNodeId: "listen", listenWindowId: randomUUID(), createdAt: new Date().toISOString(), events: [] };
  assert.throws(() => listenWindow(call, graph), bounds);
  assert.throws(() => listenWindow({ ...call, currentNodeId: "start" }, graph), /outside a listen node/);
  assert.throws(() => listenWindow(call, undefined), /outside a listen node/);
  assert.deepEqual(listenWindow({ ...call, status: "playing", listenWindowId: undefined }, graph), { status: "playing", listenWindowId: undefined });
});

test("endpointing bounds are enforced by the request schema and by publication validation", () => {
  const store = new InMemoryStore();
  for (const endpointingMs of [LISTEN_ENDPOINTING.minMs, LISTEN_ENDPOINTING.defaultMs, LISTEN_ENDPOINTING.maxMs]) {
    const graph = flow("bounds", { label: "Listen", endpointingMs });
    assert.equal(flowDefinitionSchema.safeParse(graph).success, true);
    assert.deepEqual(validateFlow(graph, store.listClips()), { valid: true, errors: [] });
  }
  for (const endpointingMs of [LISTEN_ENDPOINTING.minMs - 1, LISTEN_ENDPOINTING.maxMs + 1, LISTEN_ENDPOINTING.defaultMs + 0.5]) {
    const graph = flow("bounds", { label: "Listen", endpointingMs });
    assert.equal(flowDefinitionSchema.safeParse(graph).success, false);
    assert.match(validateFlow(graph, store.listClips()).errors.join(" "), bounds);
  }
});
