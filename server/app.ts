import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { CALLER_IDS, type TestCallInput } from "../src/lib/domain.js";
import { createAuth, requireAdmin, requireMediaGateway, type AuthStore } from "./auth.js";
import { config } from "./config.js";
import type { TranscriptClassifier } from "./classifier.js";
import { validateFlow } from "./flow-validation.js";
import { logger as defaultLogger, withLogContext } from "./logger.js";
import { voiceMetrics, type VoiceMetrics } from "./metrics.js";
import type { TelephonyHealth } from "./health.js";
import { HttpError } from "./http-error.js";
import { clipUploadFieldsSchema, flowDefinitionSchema } from "./request-schemas.js";
import type { CallOrchestrator } from "./orchestrator.js";
import type { Store } from "./store.js";
import { getTrunkStatus, type TelephonyAdapter } from "./telephony.js";
import { clipUpload, discardTemporaryUpload, ensureClipStorage, processUploadedClip, removeClipFiles } from "./uploads.js";
import { openCallEventStream } from "./sse.js";

export type AppDependencies = {
  store: Store;
  adapter: TelephonyAdapter;
  classifier: TranscriptClassifier;
  calls: Pick<CallOrchestrator, "activeCallCount" | "start" | "get" | "stop" | "markAnswered" | "submitTranscript" | "subscribe"> & Partial<Pick<CallOrchestrator, "mediaError">>;
  authStore: AuthStore;
  webOrigin?: string;
  mediaGatewayToken?: string;
  trustProxy?: string[];
  logger?: Logger;
  metrics?: VoiceMetrics;
  callRateLimit?: number;
};

export function createApp(dependencies: AppDependencies) {
  const { store, adapter, classifier, calls, authStore } = dependencies;
  const logger = dependencies.logger ?? defaultLogger;
  const metrics = dependencies.metrics ?? voiceMetrics;
  metrics.setActiveCallSource(() => calls.activeCallCount());
  const webOrigin = dependencies.webOrigin ?? config.webOrigin;
  const app = express();
  const streams = new Set<Response>();
  const auth = createAuth(authStore);
  app.disable("x-powered-by");
  app.set("trust proxy", dependencies.trustProxy ?? config.trustProxy);
  app.use(helmet({
    // The React Flow canvas positions nodes with style attributes.
    contentSecurityPolicy: { directives: { "style-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:"], "upgrade-insecure-requests": process.env.NODE_ENV === "production" ? [] : null } },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true }
  }));
  app.use((request, response, next) => {
    const requestId = randomUUID();
    const callId = request.path.match(/^\/api\/calls\/([^/]+)(?:\/|$)/)?.[1];
    response.locals.requestId = requestId;
    response.locals.callId = callId;
    response.setHeader("X-Request-ID", requestId);
    const startedAt = performance.now();
    response.on("finish", () => logger.info({ requestId, callId: response.locals.callId, method: request.method, path: request.path, statusCode: response.statusCode, durationMs: Math.round(performance.now() - startedAt) }, "HTTP request completed"));
    const origin = request.header("origin");
    if (origin && origin !== webOrigin) return response.status(403).json({ error: "Request origin is not allowed." });
    return withLogContext({ requestId, callId }, next);
  });
  app.use(cors({ origin: webOrigin, credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Last-Event-ID"] }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  ensureClipStorage();

  app.get("/api/health", async (_request, response) => {
    const health: TelephonyHealth = adapter.mode === "simulated" ? { ok: true, esl: "n/a", gateway: "n/a" }
      : adapter.health ? await adapter.health() : { ok: false, esl: "disconnected", gateway: "UNKNOWN", reason: "unconfigured" };
    metrics.observeHealth(adapter.mode, health);
    response.status(health.ok ? 200 : 503).json({ ...health, mode: adapter.mode, configured: adapter.configured });
  });
  // Metrics contain aggregate labels only. Caddy denies this path externally.
  app.get("/metrics", async (_request, response) => {
    response.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many sign-in attempts. Try again later." } }), auth.login);

  const mediaOnly = requireMediaGateway(dependencies.mediaGatewayToken ?? config.mediaGateway.webhookToken);
  app.post("/api/calls/:id/answered", mediaOnly, async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    response.json(await calls.markAnswered(z.string().parse(request.params.id)));
  });
  app.post("/api/calls/:id/transcript", mediaOnly, async (request, response) => {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000), windowId: z.string().uuid(), utteranceId: z.string().uuid(), sttLatencyMs: z.number().min(0).max(60_000).optional() }).strict().parse(request.body);
    response.json(await calls.submitTranscript(z.string().parse(request.params.id), body.transcript, body));
  });
  app.get("/api/media/calls/:id/window", mediaOnly, async (request, response) => {
    const call = await calls.get(z.string().parse(request.params.id));
    if (!call) return response.status(404).json({ error: "Call not found." });
    return response.json({ status: call.status, listenWindowId: call.listenWindowId });
  });
  app.post("/api/media/calls/:id/error", mediaOnly, async (request, response) => {
    const body = z.object({ windowId: z.string().uuid(), error: z.literal("Speech transcription unavailable.") }).strict().parse(request.body);
    if (!calls.mediaError) return response.status(503).json({ error: "Media error handling unavailable." });
    return response.json(await calls.mediaError(z.string().parse(request.params.id), body.windowId));
  });

  // Every remaining API route, including SSE/history/media, uses the operator session.
  app.use("/api", auth.requireOperator);
  app.use("/media/clips", auth.requireOperator, express.static(config.clipStorageDir, { fallthrough: false, maxAge: "1h" }));
  app.get("/api/auth/session", (_request, response) => response.json({ user: response.locals.operator }));
  app.post("/api/auth/logout", (request, response, next) => { z.object({}).strict().parse(request.body ?? {}); next(); }, auth.logout);
  app.put("/api/settings/telephony-mode", requireAdmin, (request, response) => {
    const body = z.object({ mode: z.enum(["simulated", "freeswitch"]) }).strict().parse(request.body);
    if (body.mode === adapter.mode) return response.json({ mode: adapter.mode });
    return response.status(409).json({ error: "Telephony mode is set by the administrator on the deployment host and requires a restart. Follow the first-live-call runbook." });
  });

  app.get("/api/bootstrap", async (_request, response) => {
    response.json({ flows: await store.listFlows(), clips: await store.listClips(), calls: await store.listCalls(), trunk: getTrunkStatus(calls.activeCallCount(), adapter) });
  });
  app.get("/api/flows/:id", async (request, response) => {
    const flow = await store.getFlow(request.params.id);
    if (!flow) return response.status(404).json({ error: "Flow not found." });
    return response.json(flow);
  });
  app.get("/api/flows/:id/versions/:version", (request, response) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    const flow = store.getFlowVersion(request.params.id, version);
    if (!flow) return response.status(404).json({ error: "Published flow version not found." });
    return response.json(flow);
  });
  app.post("/api/flows", async (request, response) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
    const draft = store.createDraft(body.name);
    await store.flush();
    return response.status(201).json(draft);
  });
  app.put("/api/flows/:id", async (request, response) => {
    const existing = await store.getFlow(request.params.id);
    if (!existing) return response.status(404).json({ error: "Flow not found." });
    const flow = flowDefinitionSchema.parse(request.body);
    if (flow.id !== existing.id) {
      return response.status(400).json({ error: "Invalid flow payload." });
    }
    const draft = store.saveFlow({ ...flow, status: "draft", version: existing.version });
    await store.flush();
    return response.json(draft);
  });
  app.post("/api/flows/:id/publish", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const flow = await store.getFlow(request.params.id);
    if (!flow) return response.status(404).json({ error: "Flow not found." });
    const validation = validateFlow(flow, await store.listClips());
    if (!validation.valid) return response.status(422).json(validation);
    const published = await store.saveFlow({ ...flow, status: "published", version: Math.max(1, flow.version + 1) });
    await store.flush();
    return response.json({ flow: published, validation });
  });
  app.delete("/api/flows/:id", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const deleted = store.deleteFlow(request.params.id);
    if (!deleted) return response.status(404).json({ error: "Flow not found." });
    await store.flush();
    return response.json({ deleted: true, id: deleted.id });
  });
  app.post("/api/clips", async (request, response) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), durationSeconds: z.number().int().min(1).max(180) }).strict().parse(request.body);
    const clip = store.createClip(body.name, body.durationSeconds);
    await store.flush();
    return response.status(201).json(clip);
  });
  app.post("/api/clips/upload", clipUpload.single("file"), async (request, response) => {
    try {
      const body = clipUploadFieldsSchema.parse(request.body);
      if (!request.file) throw new HttpError(400, "Select a WAV or MP3 file.");
      const { durationSeconds, ...asset } = await processUploadedClip(request.file);
      const clip = store.createClip(body.name, durationSeconds, asset);
      await store.flush();
      return response.status(201).json(clip);
    } finally { await discardTemporaryUpload(request.file); }
  });
  app.delete("/api/clips/:id", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const clip = store.getClip(request.params.id);
    if (!clip) return response.status(404).json({ error: "Clip not found." });
    if (store.isClipReferencedByPublishedVersion(clip.id)) {
      const archived = store.saveClip({ ...clip, status: "archived" });
      await store.flush();
      return response.json({ archived: true, clip: archived });
    }
    const deleted = store.deleteClip(clip.id);
    await store.flush();
    if (deleted) await removeClipFiles(deleted);
    return response.json({ archived: false, deleted: true, id: clip.id });
  });
  app.post("/api/classify", async (request, response) => {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    response.json(await classifier.classify(body.transcript));
  });
  app.post("/api/calls", rateLimit({ windowMs: 60_000, limit: dependencies.callRateLimit ?? 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Call start rate exceeded. Try again in one minute." }, keyGenerator: (_request, response) => response.locals.operator.id as string }), async (request, response) => {
    const input = z.object({ destination: z.string(), callerId: z.enum(CALLER_IDS), flowId: z.string(), scenario: z.enum(["interested", "not_interested", "callback", "uncertain"]).optional() }).strict().parse(request.body) as TestCallInput;
    const call = await calls.start(input);
    await store.flush();
    response.locals.callId = call.id;
    response.status(201).json(call);
  });
  app.get("/api/calls/:id", async (request, response) => {
    const call = await calls.get(request.params.id);
    if (!call) return response.status(404).json({ error: "Call not found." });
    return response.json(call);
  });
  app.post("/api/calls/:id/end", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const call = await calls.stop(request.params.id);
    await store.flush();
    response.json(call);
  });
  app.get("/api/calls/:id/events", async (request, response) => {
    const call = calls.get(request.params.id);
    if (!call) return response.status(404).json({ error: "Call not found." });
    streams.add(response);
    openCallEventStream(response, call, (listener) => calls.subscribe(request.params.id, listener), { onClose: () => streams.delete(response) });
  });
  app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));
  const webRoot = path.resolve(process.cwd(), "dist");
  app.use(express.static(webRoot, { index: "index.html" }));
  app.get(/^(?!\/api(?:\/|$)|\/media(?:\/|$)).*/, (_request, response) => response.sendFile(path.join(webRoot, "index.html")));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof z.ZodError) return response.status(400).json({ error: error.issues[0]?.message ?? "Invalid request." });
    if (error instanceof multer.MulterError) return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Audio clips must be 10 MB or smaller." : "Invalid multipart audio upload." });
    if (error instanceof HttpError) {
      if (error.cause || error.status >= 500) logger.error({ err: error, requestId: response.locals.requestId }, "Request could not be completed");
      return response.status(error.status).json({ error: error.message });
    }
    const statusCode = (error as { status?: number })?.status;
    if (statusCode === 409) return response.status(409).json({ error: "The listen window has closed." });
    if (statusCode === 400 || statusCode === 413 || statusCode === 404) return response.status(statusCode).json({ error: statusCode === 413 ? "Request is too large." : statusCode === 404 ? "Resource not found." : "Invalid request." });
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (/^The Singtel trunk is at its \d+-call limit\.$/.test(message) || message === "Publish the flow before starting a call.") return response.status(409).json({ error: message });
    logger.error({ err: error, requestId: response.locals.requestId, callId: response.locals.callId, method: request.method, path: request.path }, "Unhandled request failure");
    return response.status(500).json({ error: "Unexpected server error. Contact the administrator with the request ID.", requestId: response.locals.requestId });
  });
  return { app, closeSseStreams() { for (const stream of streams) stream.end(); streams.clear(); } };
}
