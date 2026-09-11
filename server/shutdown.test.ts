import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { EslClient } from "./esl.js";
import { FreeSwitchEslAdapter } from "./telephony.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { FakeEslServer, fixtureEslPassword, waitFor } from "./test-support/fake-esl.js";

test("SIGTERM drains two active fake channels with exactly two uuid_kill commands and exits before grace expires", async (t) => {
  const fake = await new FakeEslServer().start(); t.after(() => fake.close());
  const child = spawn(process.execPath, ["--import", "tsx", "server/test-support/shutdown-child.ts", String(fake.port)], { env: { ...process.env, MKTR_TELEPHONY_MODE: "simulated", MKTR_CLASSIFIER_MODE: "rules" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = ""; child.stdout.on("data", (data: Buffer) => { output += data.toString(); }); child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  await waitFor(() => output.includes("READY"), 4000);
  const exited = once(child, "exit"); const started = performance.now(); child.kill("SIGTERM");
  const [code, signal] = await exited;
  assert.equal(code, 0, output); assert.equal(signal, null); assert.ok(performance.now() - started < 3000);
  assert.equal(fake.commands.filter((command) => command.startsWith("api uuid_kill")).length, 2);
});

test("boot reconciliation kills only orphan MKTR channels and quarantines known interrupted calls", async (t) => {
  const fake = await new FakeEslServer().start(); t.after(() => fake.close());
  const orphan = randomUUID(); const unrelated = randomUUID();
  const store = new InMemoryStore();
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword }), true); t.after(() => adapter.close());
  const calls = new CallOrchestrator(store, adapter);
  const active = await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "flow-prospect-intake" });
  fake.respond = (command) => command === "api show channels as json" ? JSON.stringify({ rows: [orphan, unrelated, active.providerCallId].map((uuid) => ({ uuid })) })
    : command.startsWith("api uuid_getvar") ? command.includes(unrelated) ? "Other application" : "MKTR" : "+OK";
  await calls.initialize();
  assert.equal(calls.activeCallCount(), 0); assert.equal(calls.get(active.id)?.endReason, "SERVICE_RESTART");
  const kills = fake.commands.filter((command) => command.startsWith("api uuid_kill"));
  assert.equal(kills.length, 2); assert.ok(kills.some((command) => command.includes(orphan))); assert.ok(kills.every((command) => !command.includes(unrelated)));
});

test("ESL disconnect blocks new dials until reconnect reconciles missed hangups", async (t) => {
  const fake = await new FakeEslServer().start(); t.after(() => fake.close()); fake.respond = (command) => command === "api show channels as json" ? JSON.stringify({ row_count: 0 }) : "+OK";
  const adapter = new FreeSwitchEslAdapter(new EslClient({ host: "127.0.0.1", port: fake.port, password: fixtureEslPassword, reconnectMs: 50 }), true); t.after(() => adapter.close());
  const calls = new CallOrchestrator(new InMemoryStore(), adapter); await calls.initialize();
  const active = await calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "flow-prospect-intake" });
  for (const socket of fake.sockets) socket.destroy();
  await waitFor(() => !adapter.client.connected);
  await assert.rejects(() => calls.start({ destination: "+6591234568", callerId: "+6562773211", flowId: "flow-prospect-intake" }), /reconciling/);
  await waitFor(() => calls.get(active.id)?.status === "failed");
  assert.equal(calls.get(active.id)?.endReason, "ESL_RECONNECTED"); assert.equal(calls.activeCallCount(), 0);
});
