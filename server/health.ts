import type { EslClient } from "./esl.js";

export type TelephonyHealth = {
  ok: boolean;
  esl: "connected" | "disconnected" | "n/a";
  gateway: string;
  reason?: "unconfigured" | "gateway_unregistered" | "esl_unavailable" | "invalid_gateway_reply" | "probe_timeout";
};

const gatewayStates = new Set(["REGED", "NOREG", "TRYING", "REGISTER", "FAILED", "FAIL_WAIT", "UNREGED", "EXPIRED", "UNREGISTER"]);

/** Health queries share the event connection and never enqueue more than one probe. */
export class FreeSwitchHealthProbe {
  private pending?: Promise<TelephonyHealth>;
  private cached?: { value: TelephonyHealth; expires: number };
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;

  constructor(
    private readonly client: Pick<EslClient, "connected" | "command">,
    private readonly configured: boolean,
    options: { now?: () => number; timeoutMs?: number; cacheMs?: number } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.cacheMs = options.cacheMs ?? 1000;
  }

  async read(): Promise<TelephonyHealth> {
    if (!this.configured) return { ok: false, esl: "disconnected", gateway: "UNKNOWN", reason: "unconfigured" };
    if (this.cached && this.cached.expires > this.now() && (this.client.connected || this.cached.value.esl === "disconnected")) return this.cached.value;
    const operation = this.pending ?? this.start();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<TelephonyHealth>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, esl: this.client.connected ? "connected" : "disconnected", gateway: "UNKNOWN", reason: "probe_timeout" }), this.timeoutMs);
    });
    try {
      const value = await Promise.race([operation, timeout]);
      this.cached = { value, expires: this.now() + this.cacheMs };
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private start(): Promise<TelephonyHealth> {
    const operation = this.query();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined; });
    return operation;
  }

  private async query(): Promise<TelephonyHealth> {
    try {
      const response = await this.client.command("api sofia status gateway singtel");
      const rawState = response.body.match(/^\s*State\s+([A-Z_]+)\s*$/im)?.[1]?.toUpperCase();
      const gateway = rawState && gatewayStates.has(rawState) ? rawState : "UNKNOWN";
      const connected = this.client.connected;
      return {
        ok: connected && gateway === "REGED",
        esl: connected ? "connected" : "disconnected",
        gateway,
        ...(!connected ? { reason: "esl_unavailable" as const } : gateway === "UNKNOWN" ? { reason: "invalid_gateway_reply" as const } : gateway !== "REGED" ? { reason: "gateway_unregistered" as const } : {})
      };
    } catch {
      // No provider reply/credentials are included in this unauthenticated endpoint.
      return { ok: false, esl: this.client.connected ? "connected" : "disconnected", gateway: "UNKNOWN", reason: "esl_unavailable" };
    }
  }
}
