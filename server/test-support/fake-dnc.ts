import { createHmac, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dncConfig } from "../dnc.js";

export type BatchRequest = { timestamp: string; caller: string; numbers: string[] };
/** Mirrors the gateway contract: createdTime and validUntil are nullable there, so the
 *  fake must be able to express a reply that omits them. */
export type BatchReply = {
  success: boolean;
  data: {
    statusCode: string; transactionId: string;
    createdTime: string | null; validUntil: string | null;
    results: { number: string; noVoiceCall: boolean; noTextMessage: boolean; noFax: boolean }[];
  };
};
export const successfulDncReply = (numbers: string[]): BatchReply => ({
  success: true,
  data: {
    statusCode: "S000", transactionId: "fixture-transaction-001", createdTime: "2026-09-11 16:00:02",
    validUntil: "2026-10-11T15:59:59.000Z",
    results: numbers.map((number) => ({ number, noVoiceCall: false, noTextMessage: false, noFax: false }))
  }
});

/** Loopback only. Validates the signature against the exact received bytes. */
export class FakeDncGateway {
  readonly secret = randomBytes(32).toString("hex");
  readonly requests: { body: BatchRequest; raw: string; signatureValid: boolean }[] = [];
  respond: (body: BatchRequest, response: ServerResponse) => void = (body, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(successfulDncReply(body.numbers)));
  };
  private readonly server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = `sha256=${createHmac("sha256", this.secret).update(raw).digest("hex")}`;
    const body = JSON.parse(raw) as BatchRequest;
    const signatureValid = request.headers["x-webhook-signature"] === signature;
    this.requests.push({ body, raw, signatureValid });
    if (!signatureValid || request.method !== "POST" || request.url !== "/batch") { response.writeHead(401).end(); return; }
    this.respond(body, response);
  });
  url = "";
  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/batch`;
    return this;
  }
  async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
  config() { return dncConfig({ MKTR_DNC_ENABLED: "true", MKTR_DNC_GATEWAY_URL: this.url, MKTR_DNC_GATEWAY_SECRET: this.secret }); }
}
