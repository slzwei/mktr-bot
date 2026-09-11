import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ClassifierResult } from "../src/lib/domain.js";
import { config } from "./config.js";

const classifierOutput = z.object({
  intent: z.enum(["interested", "callback", "not_interested", "unknown"]),
  sentiment: z.enum(["positive", "neutral", "negative", "uncertain"]),
  confidence: z.number().min(0).max(1)
});

export interface TranscriptClassifier {
  readonly mode: "rules" | "openai";
  classify(transcript: string): Promise<ClassifierResult>;
}

export class RuleClassifier implements TranscriptClassifier {
  readonly mode = "rules" as const;

  async classify(transcript: string): Promise<ClassifierResult> {
    const normalised = transcript.toLowerCase().replace(/\s+/g, " ").trim();
    if (/\b(call|phone|ring)\b.*\b(back|later|tomorrow|next week)\b|\bcallback\b/.test(normalised)) {
      return { intent: "callback", sentiment: "neutral", confidence: 0.86, transcript, provider: this.mode };
    }
    if (/\b(no|not interested|don't want|do not want|stop|remove me|busy)\b/.test(normalised)) {
      return { intent: "not_interested", sentiment: "negative", confidence: 0.88, transcript, provider: this.mode };
    }
    if (/\b(yes|interested|tell me more|sounds good|sure|okay)\b/.test(normalised)) {
      return { intent: "interested", sentiment: "positive", confidence: 0.88, transcript, provider: this.mode };
    }
    return { intent: "unknown", sentiment: "uncertain", confidence: 0.42, transcript, provider: this.mode };
  }
}

class OpenAiClassifier implements TranscriptClassifier {
  readonly mode = "openai" as const;
  private readonly client = new OpenAI({ apiKey: config.classifier.openaiApiKey });

  async classify(transcript: string): Promise<ClassifierResult> {
    const response = await this.client.responses.parse({
      model: config.classifier.openaiModel,
      input: [
        {
          role: "system",
          content: "Classify one callee response for a phone-call flow. Return interested only for clear interest, callback only for a request to be contacted later, not_interested only for a clear refusal, and unknown when uncertain. Estimate confidence from zero to one."
        },
        { role: "user", content: transcript }
      ],
      text: { format: zodTextFormat(classifierOutput, "callee_response") }
    });
    if (!response.output_parsed) throw new Error("The classifier did not return a structured result.");
    return { ...response.output_parsed, transcript, provider: this.mode };
  }
}

class ResilientClassifier implements TranscriptClassifier {
  readonly mode: "rules" | "openai";

  constructor(
    private readonly primary: TranscriptClassifier,
    private readonly fallback = new RuleClassifier()
  ) {
    this.mode = primary.mode;
  }

  async classify(transcript: string): Promise<ClassifierResult> {
    try {
      return await this.primary.classify(transcript);
    } catch {
      return this.fallback.classify(transcript);
    }
  }
}

export function createTranscriptClassifier(): TranscriptClassifier {
  return config.classifier.mode === "openai"
    ? new ResilientClassifier(new OpenAiClassifier())
    : new RuleClassifier();
}
