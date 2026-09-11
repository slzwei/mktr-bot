import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { CallSession } from "../src/lib/domain.js";
import { openCallEventStream } from "./sse.js";

test("SSE reconnect sends a current snapshot with an event ID, periodic comments and disconnect cleanup", async () => {
  let listener: ((call: CallSession) => void) | undefined;
  let unsubscribed = 0;
  let closed = 0;
  const call: CallSession = {
    id: "sse-call", providerCallId: "sse-provider", flowId: "flow", flowVersion: 1,
    callerId: "+6562773211", destination: "+6591234567", status: "listening", createdAt: new Date().toISOString(),
    events: [{ id: "current-event", timestamp: new Date().toISOString(), type: "listening", title: "Waiting for reply" }]
  };
  const app = express();
  app.get("/events", (_request, response) => openCallEventStream(response, call, (next) => {
    listener = next;
    return () => { listener = undefined; unsubscribed += 1; };
  }, { heartbeatMs: 20, onClose: () => { closed += 1; } }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/events`, {
      headers: { "Last-Event-ID": "previous-event" }, signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.match(response.headers.get("cache-control")!, /no-transform/);
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes(": ping\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += Buffer.from(chunk.value!).toString();
    }
    assert.match(received, /retry: 1000\n\n/);
    assert.match(received, /id: current-event\ndata: /);
    assert.equal(JSON.parse(received.split("data: ")[1].split("\n")[0]).status, "listening");
    listener!({ ...call, status: "ended", events: [...call.events, { id: "terminal-event", timestamp: new Date().toISOString(), type: "ended", title: "Finished" }] });
    while (!received.includes("id: terminal-event")) received += Buffer.from((await reader.read()).value!).toString();
    assert.match(received, /"status":"ended"/);
    controller.abort();
    for (let attempt = 0; attempt < 50 && !closed; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unsubscribed, 1);
    assert.equal(closed, 1);
    assert.equal(listener, undefined);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
