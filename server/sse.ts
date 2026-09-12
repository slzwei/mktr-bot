import type { Response } from "express";
import type { CallSession } from "../src/lib/domain.js";

/** Every frame is a complete current snapshot; clients refetch on reconnect. */
export function openCallEventStream(
  response: Response,
  initial: CallSession,
  subscribe: (listener: (call: CallSession) => void) => () => void,
  options: { heartbeatMs?: number; onClose?: () => void } = {}
): () => void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write("retry: 1000\n\n");
  let closed = false;
  const send = (call: CallSession) => {
    // `closed` only flips on the response's own close event, which lands a tick or more after
    // anything that ends the stream directly: the backpressure guard below, and shutdown. A
    // publish arriving in that window used to throw "write after end" out of the orchestrator.
    if (closed || response.writableEnded || response.destroyed) return;
    if (response.writableLength > 1024 * 1024) { close(); response.end(); return; }
    const id = (call.events.at(-1)?.id ?? `snapshot:${call.id}`).replace(/[\r\n]/g, "");
    response.write(`id: ${id}\ndata: ${JSON.stringify(call)}\n\n`);
  };
  send(initial);
  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => { if (!closed && !response.writableEnded && !response.destroyed) response.write(": ping\n\n"); }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    options.onClose?.();
  };
  response.once("close", close);
  return close;
}
