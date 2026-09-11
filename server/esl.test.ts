import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EslClient, type EslEvent } from "./esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { RuleClassifier } from "./classifier.js";
import { CALLER_IDS, type FlowDefinition } from "../src/lib/domain.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";

const fixture = async (t: TestContext) => {
  const server = await new FakeEslServer().start();
  const client = new EslClient({ host: "127.0.0.1", port: server.port, password: fixtureEslPassword, reconnectMs: 10, timeoutMs: 500 });
  t.after(async () => { client.close(); await server.close(); });
  return { server, client };
};

test("persistent ESL authenticates once and decodes fragmented Content-Length events while serving commands", async (t) => {
  const { server, client } = await fixture(t);
  const events: EslEvent[] = [];
  client.onEvent((event) => events.push(event));
  await client.command("api status");
  server.event("BACKGROUND_JOB", { "Job-UUID": "fixture-job" }, "+OK 答复", true);
  await waitFor(() => events.length === 1);
  assert.equal(events[0].body, "+OK 答复");
  assert.equal(events[0].headers["job-uuid"], "fixture-job");
  await Promise.all([client.command("api status"), client.command("api status")]);
  assert.equal(server.connections, 1);
  assert.equal(server.commands.filter((command) => command.startsWith("auth")).length, 1);
  assert.match(server.commands.find((command) => command.startsWith("event plain"))!, /BACKGROUND_JOB.*CHANNEL_ANSWER.*CHANNEL_HANGUP_COMPLETE.*PLAYBACK_STOP/);
});

test("ESL rejects -ERR command replies and continues without replaying commands", async (t) => {
  const { server, client } = await fixture(t);
  server.response = "-ERR rejected by fake ESL";
  await assert.rejects(client.command("api bad-command"), /rejected by fake ESL/);
  server.response = "+OK healthy";
  assert.equal((await client.command("api status")).body, "+OK healthy");
  assert.equal(server.commands.filter((command) => command === "api bad-command").length, 1);
});

test("ESL rejects failed authentication", async (t) => {
  const server = await new FakeEslServer().start();
  const client = new EslClient({ host: "127.0.0.1", port: server.port, password: "wrong-fixture-password", reconnectMs: 500 });
  t.after(async () => { client.close(); await server.close(); });
  await assert.rejects(client.connect(), /ESL auth failed/);
  assert.equal(client.connected, false);
  assert.equal(server.commands.some((command) => command.startsWith("event plain")), false);
});

test("ESL reconnects and resubscribes after socket close", async (t) => {
  const { server, client } = await fixture(t);
  await client.connect();
  for (const socket of server.sockets) socket.destroy();
  await waitFor(() => server.connections === 2 && client.connected);
  await client.command("api status");
  assert.equal(server.commands.filter((command) => command.startsWith("event plain")).length, 2);
});

const input = { destination: "+6591234567", callerId: CALLER_IDS[0], flowId: "flow-prospect-intake" };

test("CHANNEL_HANGUP_COMPLETE frees an active call slot without sending another hangup", async (t) => {
  const { server, client } = await fixture(t);
  const calls = new CallOrchestrator(new InMemoryStore(), new FreeSwitchEslAdapter(client, true), new RuleClassifier());
  const call = await calls.start(input);
  assert.equal(calls.activeCallCount(), 1);
  server.event("CHANNEL_HANGUP_COMPLETE", { "Unique-ID": call.providerCallId, "Hangup-Cause": "NORMAL_CLEARING" });
  await waitFor(() => calls.activeCallCount() === 0);
  assert.equal(calls.get(call.id)?.endReason, "NORMAL_CLEARING");
  assert.equal(server.commands.filter((command) => command.startsWith("api uuid_kill")).length, 0);
});

test("originate BACKGROUND_JOB failure records the cause and releases the slot", async (t) => {
  const { server, client } = await fixture(t);
  const calls = new CallOrchestrator(new InMemoryStore(), new FreeSwitchEslAdapter(client, true), new RuleClassifier());
  const call = await calls.start(input);
  server.event("BACKGROUND_JOB", { "Job-UUID": server.jobs.get(call.providerCallId)! }, "-ERR USER_BUSY");
  await waitFor(() => calls.get(call.id)?.status === "failed");
  assert.equal(calls.get(call.id)?.endReason, "USER_BUSY");
  assert.equal(calls.activeCallCount(), 0);
});

test("answer and PLAYBACK_STOP drive a flow to exactly one provider hangup", async (t) => {
  const { server, client } = await fixture(t);
  const store = new InMemoryStore();
  const clip = store.createClip("Fixture", 1, { assetUrl: "/media/clips/22222222-2222-2222-2222-222222222222.mp3", telephonyAssetUrl: "/media/clips/11111111-1111-1111-1111-111111111111.wav", format: "wav" });
  const flow: FlowDefinition = { id: "event-flow", name: "Event flow", version: 1, status: "published", startNodeId: "s", updatedAt: new Date().toISOString(),
    nodes: [{ id: "s", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
      { id: "p", type: "playClip", position: { x: 1, y: 0 }, data: { label: "Clip", clipId: clip.id } },
      { id: "e", type: "end", position: { x: 2, y: 0 }, data: { label: "End" } }],
    edges: [{ id: "sp", source: "s", target: "p" }, { id: "pe", source: "p", target: "e" }] };
  store.saveFlow(flow);
  const calls = new CallOrchestrator(store, new FreeSwitchEslAdapter(client, true), new RuleClassifier(), () => 0);
  const call = await calls.start({ ...input, flowId: flow.id });
  store.saveClip({ ...clip, status: "archived" });
  server.event("CHANNEL_ANSWER", { "Unique-ID": call.providerCallId });
  await waitFor(() => server.commands.some((command) => command.startsWith("api uuid_broadcast")));
  assert.equal(calls.get(call.id)?.status, "playing");
  assert.ok(server.commands.some((command) => command.includes("uuid_broadcast") && command.includes("11111111-1111-1111-1111-111111111111.wav")));
  assert.ok(server.commands.every((command) => !command.includes("22222222-2222-2222-2222-222222222222.mp3")));
  const playbackId = server.commands.find((command) => command.includes("mktr_playback_id"))!.split(" ").at(-1)!;
  server.event("PLAYBACK_STOP", { "Unique-ID": call.providerCallId, variable_mktr_playback_id: playbackId });
  await waitFor(() => calls.get(call.id)?.status === "ended");
  server.event("PLAYBACK_STOP", { "Unique-ID": call.providerCallId, variable_mktr_playback_id: playbackId });
  await calls.stop(call.id);
  assert.equal(server.commands.filter((command) => command.startsWith("api uuid_kill")).length, 1);
  assert.equal(calls.activeCallCount(), 0);
});
