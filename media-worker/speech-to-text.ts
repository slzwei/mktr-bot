export type Utterance = { transcript: string; latencyMs: number };
export type SpeechCallbacks = { onUtterance: (utterance: Utterance) => void; onError: (error: Error) => void };
export interface SpeechStream {
  write(pcm: Buffer): void;
  close(): void;
}
export interface SpeechToText {
  readonly provider: string;
  open(callbacks: SpeechCallbacks): Promise<SpeechStream>;
}
