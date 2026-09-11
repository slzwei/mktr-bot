import net from "node:net";
import { randomUUID } from "node:crypto";

export const fixtureEslPassword = "local-test-fixture-only";
export const waitFor = async (predicate: () => boolean, timeoutMs = 1500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fake ESL behavior.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export class FakeEslServer {
  readonly commands: string[] = [];
  readonly sockets = new Set<net.Socket>();
  readonly jobs = new Map<string, string>();
  readonly socketErrors: string[] = [];
  connections = 0;
  port = 0;
  response = "+OK";
  respond?: (command: string) => string;
  private sequence = 0;
  private readonly server = net.createServer((socket) => {
    this.connections++;
    this.sockets.add(socket);
    socket.on("error", (error) => this.socketErrors.push(error.message));
    socket.on("close", () => this.sockets.delete(socket));
    socket.write("Content-Type: auth/request\n\n");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n");
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        this.commands.push(command.startsWith("auth ") ? "auth [redacted]" : command);
        if (command.startsWith("auth ")) this.reply(socket, command === `auth ${fixtureEslPassword}` ? "+OK accepted" : "-ERR invalid");
        else if (command.startsWith("event plain ")) this.reply(socket, "+OK event listener enabled");
        else if (command.startsWith("bgapi originate ")) {
          const uuid = command.match(/origination_uuid=([^,}]+)/)![1];
          const job = randomUUID();
          this.jobs.set(uuid, job);
          socket.write(`Content-Type: command/reply\nReply-Text: +OK Job-UUID: ${job}\nJob-UUID: ${job}\n\n`);
        } else this.frame(socket, "api/response", this.respond?.(command) ?? this.response);
      }
    });
  });

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }
  event(name: string, headers: Record<string, string> = {}, body = "", fragment = false): void {
    const data = Object.entries({ "Event-Name": name, "Event-Sequence": String(++this.sequence), "Core-UUID": "fixture", ...headers })
      .map(([key, value]) => `${key}: ${encodeURIComponent(value)}`).join("\n") + `\n\n${body}`;
    for (const socket of this.sockets) this.frame(socket, "text/event-plain", data, fragment);
  }
  private reply(socket: net.Socket, reply: string): void {
    socket.write(`Content-Type: command/reply\nReply-Text: ${reply}\n\n`);
  }
  private frame(socket: net.Socket, type: string, body: string, fragment = false): void {
    const packet = Buffer.concat([Buffer.from(`Content-Type: ${type}\nContent-Length: ${Buffer.byteLength(body)}\n\n`), Buffer.from(body)]);
    if (!fragment) { socket.write(packet); return; }
    socket.write(packet.subarray(0, packet.length - 2));
    setTimeout(() => { if (!socket.destroyed) socket.write(packet.subarray(packet.length - 2)); }, 5);
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
