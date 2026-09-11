import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import pino from "pino";
import request from "supertest";
import { createApp } from "./app.js";
import { InMemoryAuthStore } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { EslClient } from "./esl.js";
import { FreeSwitchHealthProbe } from "./health.js";
import { VoiceMetrics } from "./metrics.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { FreeSwitchEslAdapter, SimulatedTelephonyAdapter, type TelephonyAdapter } from "./telephony.js";

function application(adapter: TelephonyAdapter) {
  const store = new InMemoryStore();
  const calls = new CallOrchestrator(store, adapter, new RuleClassifier());
  const entries: Record<string, unknown>[] = [];
  const logger = pino({}, new Writable({ write(chunk, _encoding, done) { entries.push(JSON.parse(String(chunk))); done(); } }));
  const metrics = new VoiceMetrics(logger);
  const { app } = createApp({ store, calls, adapter, classifier: new RuleClassifier(), authStore: new InMemoryAuthStore(), logger, metrics, mediaGatewayToken: "fake-health-test-token" });
  return { app, metrics, calls, store, entries };
}

async function fakeGateway(state: string) {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("Content-Type: auth/request\n\n");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n");
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(command);
        if (command.startsWith("auth ") || command.startsWith("event plain ")) socket.write("Content-Type: command/reply\nReply-Text: +OK\n\n");
        else if (command === "api sofia status gateway singtel") {
          const body = `Name\tsingtel\nProfile\texternal\nState\t${state}\nStatus\tUP\n`;
          socket.write(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
        } else socket.write("Content-Type: command/reply\nReply-Text: -ERR unexpected command\n\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new EslClient({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, password: "fake-health-test-password", timeoutMs: 250 });
  const adapter = new FreeSwitchEslAdapter(client, true);
  return { adapter, commands, async close() { adapter.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("curl simulator health returns HTTP 200 with gateway n/a", async () => {
  const { app } = application(new SimulatedTelephonyAdapter());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { stdout } = await promisify(execFile)("curl", ["--fail", "--silent", "--show-error", `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/health`]);
    assert.deepEqual(JSON.parse(stdout), { ok: true, esl: "n/a", gateway: "n/a", mode: "simulated", configured: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("health with fake ESL returning NOREG returns 503 and exposes no provider secrets", async () => {
  const fake = await fakeGateway("NOREG");
  try {
    const { app, entries } = application(fake.adapter);
    const response = await request(app).get("/api/health").expect(503);
    assert.equal(response.body.gateway, "NOREG");
    assert.equal(response.body.esl, "connected");
    assert.equal(response.body.ok, false);
    assert.equal(response.body.reason, "gateway_unregistered");
    assert.deepEqual(fake.commands.filter((command) => command.startsWith("api ")), ["api sofia status gateway singtel"]);
    assert.equal(entries.find((entry) => entry.msg === "Gateway readiness changed")?.level, 40);
    assert.doesNotMatch(JSON.stringify(response.body) + JSON.stringify(entries), /fake-health-test-password/);
  } finally { await fake.close(); }
});

test("health with fake ESL requires exact REGED and caches concurrent probes", async () => {
  const fake = await fakeGateway("REGED");
  try {
    const { app } = application(fake.adapter);
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).get("/api/health").expect(200)));
    for (const response of responses) assert.equal(response.body.gateway, "REGED");
    assert.equal(fake.commands.filter((command) => command === "api sofia status gateway singtel").length, 1);
  } finally { await fake.close(); }
});

test("a stuck ESL health command has a bounded response and is not duplicated", async () => {
  let commandCount = 0;
  let time = 0;
  const probe = new FreeSwitchHealthProbe({ connected: true, command: async () => { commandCount += 1; return new Promise(() => undefined); } }, true, { timeoutMs: 20, cacheMs: 10, now: () => time });
  assert.equal((await probe.read()).reason, "probe_timeout");
  time = 100;
  assert.equal((await probe.read()).reason, "probe_timeout");
  assert.equal(commandCount, 1);
});

test("HTTP errors include request and call IDs in error-level pino logs with a stack", async () => {
  const { app, entries } = application(new SimulatedTelephonyAdapter());
  const response = await request(app).post("/api/calls/missing-call/answered").set("Authorization", "Bearer fake-health-test-token").send({}).expect(500);
  const error = entries.find((entry) => entry.level === 50);
  assert.equal(error?.requestId, response.headers["x-request-id"]);
  assert.equal(error?.callId, "missing-call");
  assert.match(String((error?.err as { stack: string }).stack), /Error: Call not found/);
  assert.doesNotMatch(JSON.stringify(response.body), /stack|Call not found/);
});

test("metrics expose current trunk occupancy, one terminal outcome and bounded latency labels", async () => {
  const { app, metrics, calls, store, entries } = application(new SimulatedTelephonyAdapter());
  store.saveFlow({ id: "flow-metrics", name: "Metrics", status: "published", version: 1, startNodeId: "start", updatedAt: new Date().toISOString(), nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start" } },
    { id: "end", type: "end", position: { x: 1, y: 0 }, data: { label: "End" } }
  ], edges: [{ id: "next", source: "start", target: "end" }] });
  const call = await calls.start({ callerId: "+6562773211", destination: "+6591234567", flowId: "flow-metrics" });
  const unsubscribe = calls.subscribe(call.id, (session) => metrics.observeCall(session));
  try {
    const active = await request(app).get("/metrics").expect(200);
    assert.match(active.text, /mktr_active_calls 1/);
    const ended = await calls.markAnswered(call.id);
    metrics.observeCall(ended);
    metrics.observeCall(ended);
    metrics.observeClassifierLatency(125, "rules");
    metrics.observeSttLatency(250, "deepgram");
    metrics.observeTurnLatency(1250, "deepgram");
    metrics.observeTurnLatency(900, "unregistered-provider");
    const result = await request(app).get("/metrics").expect(200);
    assert.match(result.headers["content-type"], /text\/plain/);
    assert.match(result.text, /mktr_active_calls 0/);
    assert.match(result.text, /mktr_calls_total\{outcome="completed"\} 1/);
    assert.match(result.text, /mktr_classifier_duration_seconds_count\{provider="rules"\} 1/);
    assert.match(result.text, /mktr_stt_duration_seconds_sum\{provider="deepgram"\} 0\.25/);
    assert.match(result.text, /mktr_turn_duration_seconds_count\{provider="deepgram"\} 1/);
    assert.match(result.text, /mktr_turn_duration_seconds_bucket\{le="1"(?:,[^}]*)?,provider="deepgram"\} 0/);
    assert.match(result.text, /mktr_turn_duration_seconds_bucket\{le="1\.25"(?:,[^}]*)?,provider="deepgram"\} 1/);
    assert.match(result.text, /mktr_turn_duration_seconds_count\{provider="unknown"\} 1/);
    assert.doesNotMatch(result.text, /91234567|flow-metrics/);
    assert.equal(entries.filter((entry) => entry.msg === "Call state changed" && entry.status === "ended").length, 1);
    assert.ok(entries.some((entry) => entry.callId === call.id && typeof entry.requestId === "string"));
  } finally {
    unsubscribe();
    await calls.stop(call.id);
  }
});
