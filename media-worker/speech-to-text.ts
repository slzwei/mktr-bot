/** `endpoint` means the configured endpointing silence ended the reply; `utterance_end` means
 *  Deepgram's fixed 1000 ms UtteranceEnd fallback did, so endpointing was not the binding limit. */
export type UtteranceEnding = "endpoint" | "utterance_end";
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
