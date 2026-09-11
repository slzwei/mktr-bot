import http from "node:http";
import type net from "node:net";

export type WindowCall = { method: "POST" | "DELETE"; callId: string; windowId: string; endpointingMs?: number; authorization?: string };

/**
 * Stands in for the media worker's listen-window control routes so adapter behaviour can be
 * asserted without a worker process. Explicit dependency injection for tests only; this file is
 * excluded from the production compiler and Docker build context.
 */
export class FakeMediaWorker {
  readonly windows: WindowCall[] = [];
  /** Status returned to every window request; set to 500 to exercise a refusing worker. */
  status = 204;
  /** Optional hold applied before replying, for races against the reply. */
  respond?: (call: WindowCall) => Promise<void> | void;
  port = 0;
  private readonly connections = new Set<net.Socket>();
  private readonly server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-media-worker.invalid");
    const match = /^\/calls\/([^/]+)\/window\/([^/]+)$/.exec(url.pathname);
    if (!match || (request.method !== "POST" && request.method !== "DELETE")) { response.writeHead(404).end(); return; }
    const endpointing = url.searchParams.get("endpointingMs");
    const call: WindowCall = {
      method: request.method, callId: match[1], windowId: match[2],
      ...(endpointing === null ? {} : { endpointingMs: Number(endpointing) }),
      authorization: request.headers.authorization
    };
    this.windows.push(call);
    void Promise.resolve(this.respond?.(call)).then(() => { if (!response.writableEnded) response.writeHead(this.status).end(); });
  });

  async start(): Promise<this> {
    this.server.on("connection", (socket) => { this.connections.add(socket); socket.on("close", () => this.connections.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  /** The `ws://` form the adapter is configured with; it derives the http origin itself. */
  get url(): string { return `ws://127.0.0.1:${this.port}`; }
  opened(callId: string): WindowCall[] { return this.windows.filter((call) => call.method === "POST" && call.callId === callId); }
  closed(callId: string): WindowCall[] { return this.windows.filter((call) => call.method === "DELETE" && call.callId === callId); }

  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
