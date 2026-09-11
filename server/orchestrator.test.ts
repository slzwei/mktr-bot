import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Histogram } from "prom-client";
import type { ClassifierResult, FlowDefinition, TestCallInput } from "../src/lib/domain.js";
import { voiceMetrics } from "./metrics.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter, type TelephonyAdapter, type TelephonyEvent } from "./telephony.js";

const validInput: TestCallInput = {
  destination: "+6591234567",
  callerId: "+6562773211",
  flowId: "flow-prospect-intake",
  scenario: "interested"
};

const waitFor = async (predicate: () => boolean, timeoutMs = 500) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for call state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("reserves the Retell caller ID", async () => {
  const orchestrator = new CallOrchestrator(new InMemoryStore(), new SimulatedTelephonyAdapter());
  await assert.rejects(
    () => orchestrator.start({ ...validInput, callerId: "+6562773210" as TestCallInput["callerId"] }),
    /reserved for Retell/
  );
});

test("enforces the configured five-call trunk ceiling", async () => {
  const orchestrator = new CallOrchestrator(new InMemoryStore(), new SimulatedTelephonyAdapter());
  const calls = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      orchestrator.start({ ...validInput, destination: `+65912345${(60 + index).toString().padStart(2, "0")}` })
    )
  );
  assert.equal(calls.length, 5);
  await assert.rejects(() => orchestrator.start(validInput), /5-call limit/);
  await Promise.all(calls.map((call) => orchestrator.stop(call.id)));
});

test("enforces the five-call ceiling for simultaneous starts", async () => {
  const orchestrator = new CallOrchestrator(new InMemoryStore(), {
    mode: "simulated",
    configured: true,
    async originate() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { providerCallId: `sim-${Math.random()}` };
    },
    async playClip() {},
    async hangup() {}
  });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) => orchestrator.start({
      ...validInput,
      destination: `+6591234${(500 + index).toString().padStart(3, "0")}`
    }))
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await Promise.all(
    results.flatMap((result) => result.status === "fulfilled" ? [orchestrator.stop(result.value.id)] : [])
  );
});

test("continues through a second listen and decision drawn in the flow", async () => {
  const store = new InMemoryStore();
  const flow: FlowDefinition = {
    id: "flow-two-turns",
    name: "Two-turn qualification",
    version: 1,
    status: "published",
    startNodeId: "start",
    updatedAt: new Date().toISOString(),
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
      { id: "opening", type: "playClip", position: { x: 1, y: 0 }, data: { label: "Opening", clipId: "clip-welcome" } },
      { id: "listen-one", type: "listen", position: { x: 2, y: 0 }, data: { label: "First reply" } },
      { id: "classify-one", type: "classify", position: { x: 3, y: 0 }, data: { label: "First decision", threshold: 0.7 } },
      { id: "interest", type: "playClip", position: { x: 4, y: 0 }, data: { label: "Interest follow-up", clipId: "clip-interest" } },
      { id: "listen-two", type: "listen", position: { x: 5, y: 0 }, data: { label: "Second reply" } },
      { id: "classify-two", type: "classify", position: { x: 6, y: 0 }, data: { label: "Second decision", threshold: 0.7 } },
      { id: "callback", type: "playClip", position: { x: 7, y: 0 }, data: { label: "Callback", clipId: "clip-callback" } },
      { id: "end", type: "end", position: { x: 8, y: 0 }, data: { label: "End" } }
    ],
    edges: [
      { id: "start-opening", source: "start", target: "opening" },
      { id: "opening-listen", source: "opening", target: "listen-one" },
      { id: "listen-classify-one", source: "listen-one", target: "classify-one", condition: { fallback: true } },
      { id: "interest-route", source: "classify-one", target: "interest", label: "Interested", condition: { intent: "interested" } },
      { id: "first-fallback", source: "classify-one", target: "end", condition: { fallback: true } },
      { id: "interest-listen", source: "interest", target: "listen-two" },
      { id: "listen-classify-two", source: "listen-two", target: "classify-two", condition: { fallback: true } },
      { id: "callback-route", source: "classify-two", target: "callback", label: "Callback", condition: { intent: "callback" } },
      { id: "second-fallback", source: "classify-two", target: "end", condition: { fallback: true } },
      { id: "callback-end", source: "callback", target: "end" }
    ]
  };
  store.saveFlow(flow);

  const results: Record<string, ClassifierResult> = {
    first: { intent: "interested", sentiment: "positive", confidence: 0.94, transcript: "first", provider: "rules" },
    second: { intent: "callback", sentiment: "neutral", confidence: 0.91, transcript: "second", provider: "rules" }
  };
  let emit: ((event: TelephonyEvent) => void) | undefined;
  const orchestrator = new CallOrchestrator(
    store,
    {
      mode: "freeswitch",
      configured: true,
      async originate() {
        return { providerCallId: "test-call" };
      },
      onEvent(listener) { emit = listener; return () => { emit = undefined; }; },
      async playClip(providerCallId, _clip, playbackId) {
        queueMicrotask(() => emit?.({ type: "playbackStopped", providerCallId, playbackId }));
      },
      async hangup() {}
    },
    {
      mode: "rules",
      async classify(transcript) {
        return results[transcript];
      }
    },
    () => 0
  );

  const call = await orchestrator.start({ ...validInput, flowId: flow.id });
  await orchestrator.markAnswered(call.id);
  await waitFor(() => orchestrator.get(call.id)?.status === "listening");
  assert.equal(orchestrator.get(call.id)?.currentNodeId, "listen-one");

  await orchestrator.submitTranscript(call.id, "first");
  await waitFor(() => orchestrator.get(call.id)?.currentNodeId === "listen-two");

  await orchestrator.submitTranscript(call.id, "second");
  await waitFor(() => orchestrator.get(call.id)?.status === "ended");
  const completed = orchestrator.get(call.id);
  assert.equal(completed?.endReason, "Flow completed");
  assert.deepEqual(
    completed?.events
      .filter((event) => event.type === "branch_selected")
      .map((event) => event.title),
    ["Branch selected: Interested", "Branch selected: Callback"]
  );
});

test("a flow error hangs up once and a failed hangup retains the trunk slot for retry", async () => {
  const store = new InMemoryStore();
  const flow = store.getFlow(validInput.flowId)!;
  flow.version += 1;
  flow.edges = [];
  store.saveFlow(flow);
  let hangups = 0;
  let rejectHangup = true;
  const orchestrator = new CallOrchestrator(store, {
    mode: "simulated", configured: true,
    async originate() { return { providerCallId: "fixture" }; },
    async playClip() {},
    async hangup() { hangups++; if (rejectHangup) throw new Error("Fake ESL disconnected"); }
  });
  const call = await orchestrator.start(validInput);
  await assert.rejects(orchestrator.markAnswered(call.id), /Fake ESL disconnected/);
  assert.equal(orchestrator.activeCallCount(), 1);
  assert.equal(hangups, 1);
  rejectHangup = false;
  await Promise.all([orchestrator.stop(call.id), orchestrator.stop(call.id)]);
  assert.equal(hangups, 2);
  assert.equal(orchestrator.activeCallCount(), 0);
});

test("a flow with no route terminates its provider channel", async () => {
  const store = new InMemoryStore();
  const flow = store.getFlow(validInput.flowId)!;
  flow.version += 1;
  flow.edges = [];
  store.saveFlow(flow);
  let hangups = 0;
  const orchestrator = new CallOrchestrator(store, {
    mode: "simulated", configured: true,
    async originate() { return { providerCallId: "fixture" }; },
    async playClip() {}, async hangup() { hangups++; }
  });
  const call = await orchestrator.start(validInput);
  await assert.rejects(orchestrator.markAnswered(call.id), /start node has no route/);
  assert.equal(hangups, 1);
  assert.equal(orchestrator.get(call.id)?.status, "failed");
  assert.equal(orchestrator.activeCallCount(), 0);
});

async function turnSamples(provider = "deepgram") {
  const histogram = voiceMetrics.registry.getSingleMetric("mktr_turn_duration_seconds") as Histogram<"provider">;
  const { values } = await histogram.get();
  const read = (suffix: string) => values.find((value) => value.metricName === `mktr_turn_duration_seconds_${suffix}` && value.labels.provider === provider)?.value ?? 0;
  return { count: read("count"), seconds: read("sum") };
}

test("a turn runs from the receipt's speech-end anchor to the reply clip command completing, and is sampled only then", async () => {
  const store = new InMemoryStore();
  const flow: FlowDefinition = {
    id: "flow-turn", name: "Turn timing", version: 1, status: "published", startNodeId: "start", updatedAt: new Date().toISOString(),
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
      { id: "listen", type: "listen", position: { x: 1, y: 0 }, data: { label: "Reply" } },
      { id: "classify", type: "classify", position: { x: 2, y: 0 }, data: { label: "Decision", threshold: 0.5 } },
      { id: "reply", type: "playClip", position: { x: 3, y: 0 }, data: { label: "Interest follow-up", clipId: "clip-interest" } },
      { id: "end", type: "end", position: { x: 4, y: 0 }, data: { label: "End" } }
    ],
    edges: [
      { id: "start-listen", source: "start", target: "listen" },
      { id: "listen-classify", source: "listen", target: "classify", condition: { fallback: true } },
      { id: "interested", source: "classify", target: "reply", label: "Interested", condition: { intent: "interested" } },
      { id: "otherwise", source: "classify", target: "end", condition: { fallback: true } },
      { id: "reply-end", source: "reply", target: "end" }
    ]
  };
  store.saveFlow(flow);
  let emit: ((event: TelephonyEvent) => void) | undefined;
  const clipCommandMs = 40;
  const adapter: TelephonyAdapter = {
    mode: "freeswitch", configured: true,
    async originate(_input, uuid) { return { providerCallId: uuid! }; },
    onEvent(listener) { emit = listener; return () => { emit = undefined; }; },
    async playClip(providerCallId, _clip, playbackId) {
      // Two ESL round trips stand between the clip decision and audible playback.
      await new Promise((resolve) => setTimeout(resolve, clipCommandMs));
      queueMicrotask(() => emit?.({ type: "playbackStopped", providerCallId, playbackId }));
    },
    async hangup() {}
  };
  const positive: ClassifierResult = { intent: "interested", sentiment: "positive", confidence: 0.9, transcript: "can lah", provider: "rules" };
  const negative: ClassifierResult = { intent: "not_interested", sentiment: "negative", confidence: 0.9, transcript: "no need", provider: "rules" };
  const orchestrator = new CallOrchestrator(store, adapter, { mode: "rules", async classify(transcript) { return transcript === "can lah" ? positive : negative; } }, () => 0);
  const run = async (transcript: string, sttLatencyMs?: number) => {
    const before = await turnSamples();
    const call = await orchestrator.start({ ...validInput, flowId: flow.id });
    await orchestrator.markAnswered(call.id);
    await waitFor(() => orchestrator.get(call.id)?.status === "listening");
    const windowId = orchestrator.get(call.id)!.listenWindowId!;
    await orchestrator.submitTranscript(call.id, transcript, { windowId, utteranceId: randomUUID(), sttLatencyMs });
    await waitFor(() => orchestrator.get(call.id)?.status === "ended");
    const after = await turnSamples();
    return { count: after.count - before.count, seconds: after.seconds - before.seconds };
  };

  const measured = await run("can lah", 850);
  assert.equal(measured.count, 1);
  // 850 ms of speech-end-to-receipt plus at least the clip command; well under a second of orchestration on top.
  assert.ok(measured.seconds >= 0.85 + clipCommandMs / 1000 && measured.seconds < 1.85, `unexpected turn of ${measured.seconds}s`);
  assert.deepEqual(await run("can lah"), { count: 0, seconds: 0 }, "a receipt without speech-end timing produces no turn sample");
  assert.deepEqual(await run("no need", 850), { count: 0, seconds: 0 }, "a reply that hangs up instead of playing a clip produces no turn sample");
});
