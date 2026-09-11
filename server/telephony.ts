import { randomUUID } from "node:crypto";
import net from "node:net";
import type { CallerId, Clip, TelephonyMode, TestCallInput, TrunkStatus } from "../src/lib/domain.js";
import { CALLER_IDS, RESERVED_CALLER_ID } from "../src/lib/domain.js";
import { config, isProductionGatewayConfigured } from "./config.js";

export type TelephonyCall = {
  providerCallId: string;
};

export interface TelephonyAdapter {
  readonly mode: TelephonyMode;
  readonly configured: boolean;
  originate(input: Pick<TestCallInput, "destination" | "callerId">): Promise<TelephonyCall>;
  playClip(providerCallId: string, clip: Clip): Promise<void>;
  hangup(providerCallId: string): Promise<void>;
}

export class SimulatedTelephonyAdapter implements TelephonyAdapter {
  readonly mode = "simulated" as const;
  readonly configured = true;

  async originate(): Promise<TelephonyCall> {
    return { providerCallId: `sim-${randomUUID()}` };
  }

  async hangup(): Promise<void> {
    return;
  }

  async playClip(): Promise<void> {
    return;
  }
}

/**
 * Minimal Event Socket Layer client. FreeSWITCH owns the TLS/SRTP SIP leg;
 * this adapter only sends internal originate and hangup commands to it.
 */
export class FreeSwitchEslAdapter implements TelephonyAdapter {
  readonly mode = "freeswitch" as const;
  readonly configured = isProductionGatewayConfigured();

  async originate(input: Pick<TestCallInput, "destination" | "callerId">): Promise<TelephonyCall> {
    if (!this.configured) {
      throw new Error("FreeSWITCH mode requires SIP and ESL passwords in the deployment secret store.");
    }
    const providerCallId = randomUUID();
    const dial = `sofia/gateway/singtel/${input.destination}`;
    const variables = [
      `origination_uuid=${providerCallId}`,
      `origination_caller_id_number=${input.callerId}`,
      "origination_caller_id_name=MKTR",
      "absolute_codec_string=PCMA",
      "rtp_secure_media=true",
      "hangup_after_bridge=true"
    ].join(",");
    await this.command(`bgapi originate {${variables}}${dial} &park()`);
    return { providerCallId };
  }

  async hangup(providerCallId: string): Promise<void> {
    if (!this.configured) return;
    await this.command(`api uuid_kill ${providerCallId}`);
  }

  async playClip(providerCallId: string, clip: Clip): Promise<void> {
    if (!this.configured) return;
    if (!clip.assetUrl) {
      throw new Error(`Live playback requires an uploaded file for ${clip.name}.`);
    }
    const filename = clip.assetUrl.split("/").at(-1);
    if (!filename || !/^[a-f0-9-]+\.(wav|mp3)$/i.test(filename)) {
      throw new Error("Clip media path is invalid.");
    }
    const mediaPath = `${config.freeswitch.mediaDirectory}/${filename}`;
    await this.command(`api uuid_broadcast ${providerCallId} ${mediaPath} aleg`);
  }

  private async command(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: config.freeswitch.host, port: config.freeswitch.port });
      let buffer = "";
      let stage: "auth-request" | "auth-reply" | "command-reply" = "auth-request";
      let settled = false;
      const finish = (error?: Error, response?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.end();
        if (error) reject(error);
        else resolve(response ?? "");
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        finish(new Error("Timed out while connecting to FreeSWITCH ESL."));
      }, 5000);

      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const separator = buffer.indexOf("\n\n");
          if (separator === -1) return;
          const headerBlock = buffer.slice(0, separator);
          const contentLength = Number.parseInt(
            headerBlock.match(/^Content-Length:\s*(\d+)\s*$/im)?.[1] ?? "0",
            10
          );
          const frameLength = separator + 2 + contentLength;
          if (buffer.length < frameLength) return;
          const frame = buffer.slice(0, frameLength);
          buffer = buffer.slice(frameLength);

          if (stage === "auth-request") {
            if (!/Content-Type:\s*auth\/request/i.test(headerBlock)) {
              finish(new Error(`FreeSWITCH did not request ESL authentication: ${headerBlock}`));
              return;
            }
            stage = "auth-reply";
            socket.write(`auth ${config.freeswitch.password}\n\n`);
            continue;
          }

          if (/Reply-Text:\s*-ERR/i.test(headerBlock) || /-ERR\b/.test(frame)) {
            finish(new Error(`FreeSWITCH command failed: ${frame.trim()}`));
            return;
          }
          if (stage === "auth-reply") {
            if (!/Reply-Text:\s*\+OK/i.test(headerBlock)) {
              finish(new Error(`FreeSWITCH authentication failed: ${frame.trim()}`));
              return;
            }
            stage = "command-reply";
            socket.write(`${command}\n\n`);
            continue;
          }
          finish(undefined, frame);
          return;
        }
      });
      socket.on("error", (error) => {
        finish(error);
      });
    });
  }
}

export function createTelephonyAdapter(): TelephonyAdapter {
  return config.telephonyMode === "freeswitch"
    ? new FreeSwitchEslAdapter()
    : new SimulatedTelephonyAdapter();
}

export function getTrunkStatus(activeCalls: number, adapter: TelephonyAdapter): TrunkStatus {
  return {
    mode: adapter.mode,
    available: adapter.mode === "simulated" || adapter.configured,
    configured: adapter.configured,
    trunkUsername: config.singtel.username,
    endpoint: `${config.singtel.host} (${config.singtel.ip})`,
    signalingPort: config.singtel.pcmaPort,
    codecs: ["PCMA", "G.711u", "Opus"],
    media: `SRTP ${config.singtel.mediaIpRange}:${config.singtel.mediaPortRange}`,
    maxConcurrentCalls: config.maxConcurrentCalls,
    activeCalls,
    classifierMode: config.classifier.mode,
    callerIds: CALLER_IDS,
    reservedCallerId: RESERVED_CALLER_ID
  };
}

export function assertAllowedCallerId(callerId: string): asserts callerId is CallerId {
  if (callerId === RESERVED_CALLER_ID) {
    throw new Error(`${RESERVED_CALLER_ID} is reserved for Retell and cannot be used.`);
  }
  if (!(CALLER_IDS as readonly string[]).includes(callerId)) {
    throw new Error("Caller ID is not assigned to the MKTR bot pool.");
  }
}
