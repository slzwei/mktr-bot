export type { UtteranceEnding } from "../src/lib/domain.js";
import type { UtteranceEnding } from "../src/lib/domain.js";
export type Utterance = { transcript: string; latencyMs?: number; finalizedBy?: UtteranceEnding };
export type SpeechCallbacks = {
  onUtterance: (utterance: Utterance) => void;
  onError: (error: Error) => void;
  /** The caller has been heard saying recognizable words. Fires once per utterance, ahead of the transcript. */
  onSpeechStarted?: () => void;
};
/** Per-window settings the API resolves from the listen node; the provider applies them to that window only. */
export type ListenSettings = { endpointingMs: number };
export interface SpeechStream {
  write(pcm: Buffer, receivedAt?: number): void;
  close(): void;
}
export interface SpeechToText {
  readonly provider: string;
  open(callbacks: SpeechCallbacks, signal?: AbortSignal, listen?: ListenSettings): Promise<SpeechStream>;
}
