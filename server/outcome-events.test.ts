import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CALLER_IDS } from "../src/lib/domain.js";
import { EslClient } from "./esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { InMemoryStore } from "./store.js";
import { FixtureCallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";
import { FakeMediaWorker } from "./test-support/fake-media-worker.js";

async function fixture(t: TestContext, recording = false, noSpeechTimeoutMs = 6000) {
  const fake = await new FakeEslServer().start();
  const media = await new FakeMediaWorker().start();
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true, { webhookToken: "fake-media-token-for-test", workerUrl: media.url });
  const store = new InMemoryStore();
  const graph = store.getFlow("flow-prospect-intake")!;
  store.saveFlow({ ...graph, version: 4, nodes: [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } }, { id: "listen", type: "listen", position: { x: 200, y: 0 }, data: { label: "Listen", noSpeechTimeoutMs } }, { id: "end", type: "end", position: { x: 400, y: 0 }, data: { label: "End" } }], edges: [{ id: "s-l", source: "start", target: "listen" }, { id: "l-e", source: "listen", target: "end", condition: { fallback: true } }] });
  const calls = new FixtureCallOrchestrator(store, adapter, undefined, undefined, undefined, undefined, { enabled: recording, directory: "/unused-fixture-recordings", retentionDays: 30 });
  t.after(async () => { await calls.shutdown(); await media.close(); await fake.close(); });
  const start = () => calls.start({ destination: "+6591234519", callerId: CALLER_IDS[0], flowId: graph.id });
  return { store, fake, media, calls, start };
}

test("answer starts AMD and optional recording; detected voicemail hangs up once and preserves its outcome across the provider hangup", async (t) => {
  const f = await fixture(t, true), call = await f.start();
  f.fake.respond = (command) => {
    if (command.startsWith("api uuid_kill")) f.fake.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": "NORMAL_CLEARING" });
    return "+OK";
  };
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  assert.equal(f.fake.commands.filter((command) => command === `api avmd ${call.providerCallId} start`).length, 1);
  assert.equal(f.fake.commands.filter((command) => command === `api uuid_record ${call.providerCallId} start /var/lib/freeswitch/recordings/sessions/${call.id}.wav`).length, 1);
  const recording = f.calls.get(call.id)!;
  assert.equal(recording.recordingFile, `${call.id}.wav`);
  assert.ok(Date.parse(recording.recordingExpiresAt!) > Date.now() + 29 * 86_400_000);
  f.fake.event("CUSTOM", { "Unique-ID": call.providerCallId, "Event-Subclass": "avmd::beep", "Beep-Status": "DETECTED" });
  await waitFor(() => f.calls.get(call.id)?.outcome === "voicemail" && f.calls.activeCallCount() === 0);
  assert.equal(f.calls.get(call.id)?.endReason, "AMD_VOICEMAIL");
  assert.equal(f.fake.commands.filter((command) => command.startsWith("api uuid_kill")).length, 1);
  f.fake.event("CUSTOM", { "Unique-ID": call.providerCallId, "Event-Subclass": "avmd::beep", "Beep-Status": "DETECTED" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.fake.commands.filter((command) => command.startsWith("api uuid_kill")).length, 1);
});

test("provider hangup causes produce busy, no-answer or failed outcomes through the orchestrator", async (t) => {
  const f = await fixture(t);
  for (const [cause, expected] of [["USER_BUSY", "busy"], ["BUSY_EVERYWHERE", "busy"], ["NO_ANSWER", "no_answer"], ["NO_USER_RESPONSE", "no_answer"], ["PROGRESS_TIMEOUT", "no_answer"], ["NORMAL_TEMPORARY_FAILURE", "failed"], ["NORMAL_CLEARING", "completed"]]) {
    const call = await f.start();
    f.fake.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": cause });
    await waitFor(() => f.calls.get(call.id)?.status === "ended");
    assert.equal(f.calls.get(call.id)?.outcome, expected, cause);
    assert.equal(f.calls.activeCallCount(), 0);
    assert.equal(f.calls.get(call.id)?.recordingFile, undefined);
  }
  assert.equal(f.fake.commands.filter((command) => command.startsWith("api uuid_kill")).length, 0);
});


test("a beep or remote hangup during no-speech window shutdown cannot revive the call or overwrite its outcome", async (t) => {
  for (const signal of ["beep", "hangup"] as const) {
    const f = await fixture(t, false, 30), call = await f.start();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The no-speech path waits for the worker to confirm the window closed; hold that reply.
    f.media.respond = (window) => window.method === "DELETE" ? held : undefined;
    f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
    await waitFor(() => f.media.windows.some((window) => window.method === "DELETE" && window.callId === call.id));
    if (signal === "beep") f.fake.event("CUSTOM", { "Unique-ID": call.providerCallId, "Event-Subclass": "avmd::beep", "Beep-Status": "DETECTED" });
    else f.fake.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": "NORMAL_TEMPORARY_FAILURE" });
    // Events travel independently of the held command reply.
    await new Promise((resolve) => setTimeout(resolve, 15)); release();
    await waitFor(() => f.calls.activeCallCount() === 0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const ended = f.calls.get(call.id)!;
    assert.equal(ended.outcome, signal === "beep" ? "voicemail" : "failed");
    assert.equal(ended.events.some((event) => event.title === "No speech: fallback selected"), false);
    assert.equal(f.calls.activeCallCount(), 0);
  }
});

test("a failed voicemail hangup retains its intent until a delayed provider hangup is confirmed", async (t) => {
  const f = await fixture(t), call = await f.start();
  f.fake.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => f.calls.get(call.id)?.status === "listening");
  f.fake.respond = (command) => command.startsWith("api uuid_kill") ? "-ERR injected unconfirmed hangup" : "+OK";
  f.fake.event("CUSTOM", { "Unique-ID": call.providerCallId, "Event-Subclass": "avmd::beep", "Beep-Status": "DETECTED" });
  await waitFor(() => f.calls.get(call.id)?.events.at(-1)?.title === "Hangup not confirmed");
  assert.equal(f.calls.activeCallCount(), 1);
  assert.deepEqual(f.store.getCall(call.id)?.terminationIntent, { status: "ended", reason: "AMD_VOICEMAIL" });
  f.fake.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": "NORMAL_CLEARING" });
  await waitFor(() => f.calls.get(call.id)?.outcome === "voicemail");
  assert.equal(f.calls.activeCallCount(), 0); assert.equal(f.calls.get(call.id)?.terminationIntent, undefined);
});
