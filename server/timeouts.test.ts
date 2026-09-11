import assert from "node:assert/strict";
import test from "node:test";
import type { FlowDefinition } from "../src/lib/domain.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { validateFlow } from "./flow-validation.js";
import { boundedInteger } from "./config.js";
import { EslClient } from "./esl.js";
import { FreeSwitchEslAdapter, type TelephonyAdapter, type TelephonyEvent } from "./telephony.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";

function fixture(retry = false) {
  const store = new InMemoryStore();
  const flow: FlowDefinition = { id: "timeout-flow", name: "Timeout", version: 1, status: "published", updatedAt: new Date().toISOString(), startNodeId: "start", nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "listen", type: "listen", position: { x: 1, y: 0 }, data: { label: "Listen", noSpeechTimeoutMs: 20 } },
    { id: "end", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }
  ], edges: [{ id: "a", source: "start", target: "listen" }, { id: "b", source: "listen", target: retry ? "retry" : "end", condition: { fallback: true } }] };
  if (retry) {
    flow.nodes.push({ id: "retry", type: "retry", position: { x: 2, y: 1 }, data: { label: "Retry", clipId: "clip-clarify", maxAttempts: 1 } });
    flow.edges.push({ id: "r", source: "retry", target: "listen" });
    // End is unnecessary: an exhausted retry without an exhaustion fallback terminates.
    flow.nodes = flow.nodes.filter((node) => node.id !== "end");
  }
  store.saveFlow(flow);
  let listener: ((event: TelephonyEvent) => void) | undefined;
  let kills = 0; let plays = 0;
  const adapter: TelephonyAdapter = { mode: "freeswitch", configured: true,
    async originate(_input, uuid) { return { providerCallId: uuid! }; },
    async hangup() { kills++; },
    onEvent(value) { listener = value; return () => { listener = undefined; }; },
    async playClip(providerCallId, _clip, playbackId) { plays++; queueMicrotask(() => listener?.({ type: "playbackStopped", providerCallId, playbackId })); }
  };
  return { store, flow, adapter, kills: () => kills, plays: () => plays };
}
const input = { destination: "+6591234567", callerId: "+6562773211", flowId: "timeout-flow" } as const;

test("a silent listen takes its fallback and terminates the provider", async () => {
  const f = fixture(); const calls = new CallOrchestrator(f.store, f.adapter);
  const call = await calls.start(input); await calls.markAnswered(call.id);
  await waitFor(() => calls.activeCallCount() === 0);
  assert.equal(f.kills(), 1); assert.equal(calls.get(call.id)?.endReason, "Flow completed");
  assert.ok(calls.get(call.id)?.events.some((event) => event.title === "No speech: fallback selected"));
});

test("default no-speech deadline is six seconds and ignores an already closed window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const flow = f.store.getFlow(f.flow.id)!; flow.version++; delete flow.nodes[1].data.noSpeechTimeoutMs; f.store.saveFlow(flow);
  const calls = new CallOrchestrator(f.store, f.adapter); const call = await calls.start(input); await calls.markAnswered(call.id);
  t.mock.timers.tick(5999); await Promise.resolve(); assert.equal(calls.get(call.id)?.status, "listening");
  t.mock.timers.tick(1); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.get(call.id)?.status, "ended"); assert.equal(f.kills(), 1);
});

test("retry loop is capped across repeated listens and uncapped graphs cannot publish", async () => {
  const f = fixture(true); assert.equal(validateFlow(f.flow, f.store.listClips()).valid, true);
  const uncapped = structuredClone(f.flow); delete uncapped.nodes.find((node) => node.type === "retry")!.data.maxAttempts;
  assert.match(validateFlow(uncapped, f.store.listClips()).errors.join(" "), /explicit maxAttempts/);
  const calls = new CallOrchestrator(f.store, f.adapter); const call = await calls.start(input); await calls.markAnswered(call.id);
  await waitFor(() => calls.activeCallCount() === 0);
  assert.equal(f.plays(), 1); assert.equal(f.kills(), 1); assert.equal(calls.get(call.id)?.endReason, "Retry limit reached");
});

test("unanswered and answered call deadlines terminate once without waiting for a transcript", async () => {
  for (const answered of [false, true]) {
    const f = fixture(); const flow = f.store.getFlow(f.flow.id)!; flow.version++; flow.nodes[1].data.noSpeechTimeoutMs = 1000; f.store.saveFlow(flow);
    const calls = new CallOrchestrator(f.store, f.adapter, undefined, undefined, { originateTimeoutMs: 30, maxCallMs: 20 });
    const call = await calls.start(input); if (answered) await calls.markAnswered(call.id);
    await waitFor(() => calls.activeCallCount() === 0); assert.equal(f.kills(), 1);
    assert.equal(calls.get(call.id)?.endReason, answered ? "ALLOTTED_TIMEOUT" : "NO_ANSWER");
  }
});

test("ESL originate carries provider-owned answer and duration deadlines; trunk configuration rejects unsafe caps", async (t) => {
  const fake = await new FakeEslServer().start(); t.after(() => fake.close());
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true); t.after(() => adapter.close());
  await adapter.originate(input);
  const originate = fake.commands.find((command) => command.startsWith("bgapi originate"))!;
  assert.match(originate, /originate_timeout=30/); assert.match(originate, /execute_on_answer='sched_hangup \+180 ALLOTTED_TIMEOUT'/);
  for (const value of ["0", "6", "NaN", "2.5", "5bad"]) assert.throws(() => boundedInteger(value, 5, 1, 5));
});
