import net from "node:net";
import { EventEmitter } from "node:events";

export type EslFrame = { headers: Record<string, string>; body: string };
export type EslEvent = { name: string; headers: Record<string, string>; body: string };

function headersFrom(text: string, decode = false): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const value = line.slice(colon + 1).trim();
    headers[line.slice(0, colon).toLowerCase()] = decode ? decodeURIComponent(value) : value;
  }
  return headers;
}

/** ESL Content-Length counts bytes, including when a UTF-8 body is fragmented. */
export class EslFrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): EslFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error("ESL frame exceeds 8 MiB.");
    const frames: EslFrame[] = [];
    while (this.buffer.length) {
      const lf = this.buffer.indexOf("\n\n");
      const crlf = this.buffer.indexOf("\r\n\r\n");
      const separator = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
      if (separator < 0) break;
      const delimiter = separator === crlf ? 4 : 2;
      const headers = headersFrom(this.buffer.subarray(0, separator).toString("utf8"));
      const lengthText = headers["content-length"] ?? "0";
      if (!/^\d+$/.test(lengthText)) throw new Error("ESL Content-Length is invalid.");
      const length = Number(lengthText);
      if (length > 8 * 1024 * 1024) throw new Error("ESL body exceeds 8 MiB.");
      const end = separator + delimiter + length;
      if (this.buffer.length < end) break;
      frames.push({ headers, body: this.buffer.subarray(separator + delimiter, end).toString("utf8") });
      this.buffer = this.buffer.subarray(end);
    }
    return frames;
  }
}

export class EslCommandError extends Error {
  constructor(readonly reply: string) { super(`FreeSWITCH rejected command: ${reply.trim()}`); }
}

export type CommandGuard = { prepare(): Promise<void>; check(): void };

export type EslOptions = {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
  reconnectMs?: number;
};
const subscriptions = "BACKGROUND_JOB CHANNEL_CREATE CHANNEL_PROGRESS CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE PLAYBACK_STOP CUSTOM avmd::beep";

/** One authenticated connection; commands are serialized and never replayed on reconnect. */
export class EslClient {
  private readonly events = new EventEmitter();
  private socket?: net.Socket;
  private ready = false;
  private closed = false;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private pending?: { resolve: (frame: EslFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private commandQueue: Promise<unknown> = Promise.resolve();
  private retry = 0;
  lastError?: string;

  constructor(private readonly options: EslOptions) {}
  get connected(): boolean { return this.ready; }
  onEvent(listener: (event: EslEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }
  onConnection(listener: (connected: boolean) => void): () => void {
    this.events.on("connection", listener);
    return () => this.events.off("connection", listener);
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("ESL client is closed.");
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    clearTimeout(this.reconnectTimer);
    const connection = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      this.socket = socket;
      socket.setNoDelay(true);
      const decoder = new EslFrameDecoder();
      let phase: "challenge" | "auth" | "subscribe" | "ready" = "challenge";
      const timeout = setTimeout(() => socket.destroy(new Error("ESL authentication timed out.")), this.options.timeoutMs ?? 5000);
      const fail = (error: Error) => {
        this.lastError = error.message;
        reject(error);
        this.rejectPending(error);
      };
      socket.on("data", (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) {
            const type = frame.headers["content-type"];
            if (type === "text/event-plain") {
              const parts = frame.body.split(/\r?\n\r?\n/);
              const headers = headersFrom(parts.shift() ?? "", true);
              this.events.emit("event", { name: headers["event-name"] ?? "", headers, body: parts.join("\n\n") } satisfies EslEvent);
              continue;
            }
            if (type === "text/disconnect-notice") throw new Error("FreeSWITCH closed the event session.");
            if (phase === "challenge") {
              if (type !== "auth/request") throw new Error("FreeSWITCH did not request ESL authentication.");
              if (/[\r\n]/.test(this.options.password)) throw new Error("ESL password contains a line break.");
              socket.write(`auth ${this.options.password}\n\n`);
              phase = "auth";
            } else if (phase === "auth" || phase === "subscribe") {
              if (!frame.headers["reply-text"]?.startsWith("+OK")) throw new Error(`ESL ${phase} failed.`);
              if (phase === "auth") {
                socket.write(`event plain ${subscriptions}\n\n`);
                phase = "subscribe";
              } else {
                clearTimeout(timeout);
                phase = "ready";
                this.ready = true;
                this.retry = 0;
                this.lastError = undefined;
                this.events.emit("connection", true);
                resolve();
              }
            } else if (type === "command/reply" || type === "api/response") {
              const pending = this.pending;
              if (!pending) throw new Error("ESL received an unmatched command reply.");
              clearTimeout(pending.timer);
              this.pending = undefined;
              const reply = frame.body || frame.headers["reply-text"] || "";
              if (reply.trimStart().startsWith("-ERR")) pending.reject(new EslCommandError(reply));
              else pending.resolve(frame);
            }
          }
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error("Invalid ESL frame."));
        }
      });
      socket.on("error", fail);
      socket.on("close", () => {
        clearTimeout(timeout);
        this.ready = false;
        this.socket = undefined;
        const error = new Error("ESL connection closed; in-flight commands were not replayed.");
        fail(error);
        this.events.emit("connection", false);
        if (!this.closed) {
          const wait = Math.min(5000, (this.options.reconnectMs ?? 250) * 2 ** Math.min(this.retry++, 5));
          this.reconnectTimer = setTimeout(() => {
            void this.connect().catch((reconnectError: unknown) => {
              this.lastError = reconnectError instanceof Error ? reconnectError.message : "ESL reconnect failed.";
            });
          }, wait);
          this.reconnectTimer.unref();
        }
      });
    });
    this.connecting = connection;
    try { await connection; } finally { if (this.connecting === connection) this.connecting = undefined; }
  }

  command(command: string, guard?: CommandGuard): Promise<EslFrame> {
    if (/[\r\n]/.test(command)) return Promise.reject(new Error("ESL command contains a line break."));
    const next = this.commandQueue.then(async () => {
      await this.connect();
      await guard?.prepare();
      if (!this.ready || !this.socket || this.closed) throw new Error("ESL disconnected before command write.");
      guard?.check();
      return new Promise<EslFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.socket?.destroy(new Error("ESL command timed out; outcome is unknown."));
        }, this.options.timeoutMs ?? 5000);
        this.pending = { resolve, reject, timer };
        this.socket!.write(`${command}\n\n`);
      });
    });
    // The returned promise retains the error; this continuation only releases the queue.
    this.commandQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    this.rejectPending(new Error("ESL client closed."));
    this.socket?.destroy();
  }
  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }
}
