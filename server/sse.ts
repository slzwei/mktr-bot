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
    if (closed) return;
    if (response.writableLength > 1024 * 1024) { response.end(); return; }
    const id = (call.events.at(-1)?.id ?? `snapshot:${call.id}`).replace(/[\r\n]/g, "");
    response.write(`id: ${id}\ndata: ${JSON.stringify(call)}\n\n`);
  };
  send(initial);
  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => { if (!closed) response.write(": ping\n\n"); }, options.heartbeatMs ?? 15_000);
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
