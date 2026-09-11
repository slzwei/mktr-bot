import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierResult, FlowDefinition } from "../src/lib/domain.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";

const routingFlow: FlowDefinition = {
  id: "routing-flow", name: "Route selection", version: 1, status: "published", startNodeId: "start", updatedAt: new Date().toISOString(),
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "listen", type: "listen", position: { x: 1, y: 0 }, data: { label: "Listen" } },
    { id: "classify", type: "classify", position: { x: 2, y: 0 }, data: { label: "Classify", threshold: 0.7 } },
    ...["positive", "fallback", "callback"].map((id, index) => ({ id, type: "end" as const, position: { x: 3, y: index }, data: { label: id } }))
  ],
  edges: [
    { id: "start-listen", source: "start", target: "listen" },
    { id: "listen-classify", source: "listen", target: "classify", condition: { fallback: true } },
    { id: "positive", source: "classify", target: "positive", label: "Matched positive", condition: { intent: "interested", sentiment: "positive" } },
    { id: "callback", source: "classify", target: "callback", label: "Matched callback", condition: { intent: "callback" } },
    { id: "fallback", source: "classify", target: "fallback", label: "Safe fallback", condition: { fallback: true } }
  ]
};

for (const [name, result, target] of [
  ["specific intent and sentiment", { intent: "interested", sentiment: "positive", confidence: 0.95 }, "positive"],
  ["intent-only callback", { intent: "callback", sentiment: "neutral", confidence: 0.95 }, "callback"],
  ["below-threshold positive response", { intent: "interested", sentiment: "positive", confidence: 0.4 }, "fallback"],
  ["unknown response", { intent: "unknown", sentiment: "uncertain", confidence: 0.95 }, "fallback"]
] as const) {
  test(`public orchestrator routes ${name} to ${target}`, async () => {
    const store = new InMemoryStore();
    store.saveFlow(routingFlow);
    const classifierResult: ClassifierResult = { ...result, transcript: "fixture utterance", provider: "rules" };
    const calls = new CallOrchestrator(store, {
      mode: "freeswitch", configured: true,
      async originate(_input, providerCallId?: string) { return { providerCallId: providerCallId ?? "fake-routing-call" }; },
      async playClip() {},
      async hangup() {}
    }, { mode: "rules", async classify() { return classifierResult; } });
    const call = await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: routingFlow.id });
    await calls.markAnswered(call.id);
    await calls.submitTranscript(call.id, "fixture utterance");
    assert.equal(calls.get(call.id)?.status, "ended");
    assert.equal(calls.get(call.id)?.currentNodeId, target);
    assert.equal(calls.activeCallCount(), 0);
  });
}
