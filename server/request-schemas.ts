import { z } from "zod";
import { LISTEN_ENDPOINTING } from "../src/lib/domain.js";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/, "Identifiers may contain letters, numbers, dots, colons, dashes and underscores.");
const condition = z.object({
  intent: z.string().min(1).max(80).optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "uncertain"]).optional(),
  confidenceBelow: z.number().min(0).max(1).optional(),
  fallback: z.boolean().optional()
}).strict();

export const flowDefinitionSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  version: z.number().int().min(0),
  status: z.enum(["draft", "published"]),
  startNodeId: identifier,
  nodes: z.array(z.object({
    id: identifier,
    type: z.enum(["start", "playClip", "listen", "classify", "condition", "retry", "end"]),
    position: z.object({ x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000) }).strict(),
    data: z.object({
      label: z.string().trim().min(1).max(80),
      clipId: identifier.optional(),
      prompt: z.string().max(4_000).optional(),
      threshold: z.number().min(0).max(1).optional(),
      description: z.string().max(2_000).optional(),
      noSpeechTimeoutMs: z.number().int().min(100).max(60_000).optional(),
      endpointingMs: z.number().int().min(LISTEN_ENDPOINTING.minMs).max(LISTEN_ENDPOINTING.maxMs).optional(),
      maxAttempts: z.number().int().min(1).max(10).optional()
    }).strict()
  }).strict()).max(250),
  edges: z.array(z.object({ id: identifier, source: identifier, target: identifier, label: z.string().max(80).optional(), condition: condition.optional() }).strict()).max(1_000),
  updatedAt: z.string().datetime({ offset: true })
}).strict().superRefine((flow, context) => {
  for (const [items, label] of [[flow.nodes, "node"], [flow.edges, "edge"]] as const) {
    if (new Set(items.map((item) => item.id)).size !== items.length) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${label} identifiers are not allowed.` });
  }
});

// Duration supplied by a browser is a hint only; the decoded file determines stored duration.
export const clipUploadFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  durationSeconds: z.coerce.number().finite().nonnegative().optional()
}).strict();
