import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { CALLER_IDS, type FlowDefinition, type TestCallInput } from "../src/lib/domain.js";
import { createAuth, requireAdmin, requireMediaGateway, type AuthStore } from "./auth.js";
import { config } from "./config.js";
import type { TranscriptClassifier } from "./classifier.js";
import { validateFlow } from "./flow-validation.js";
import { logger as defaultLogger } from "./logger.js";
import type { CallOrchestrator } from "./orchestrator.js";
import type { InMemoryStore } from "./store.js";
import { getTrunkStatus, type TelephonyAdapter } from "./telephony.js";
import { clipUpload, ensureClipStorage, uploadedClipAssetUrl } from "./uploads.js";

type StoreMethods = Pick<InMemoryStore, "listFlows" | "getFlow" | "saveFlow" | "createDraft" | "listClips" | "createClip" | "listCalls">;
type ApplicationStore = { [K in keyof StoreMethods]: (...args: Parameters<StoreMethods[K]>) => ReturnType<StoreMethods[K]> | Promise<ReturnType<StoreMethods[K]>> };
export type AppDependencies = {
  store: ApplicationStore;
  adapter: TelephonyAdapter;
  classifier: TranscriptClassifier;
  calls: Pick<CallOrchestrator, "activeCallCount" | "start" | "get" | "stop" | "markAnswered" | "submitTranscript" | "subscribe">;
  authStore: AuthStore;
  webOrigin?: string;
  mediaGatewayToken?: string;
  trustProxy?: string[];
  logger?: Logger;
  callRateLimit?: number;
};

export function createApp(dependencies: AppDependencies) {
  const { store, adapter, classifier, calls, authStore } = dependencies;
  const logger = dependencies.logger ?? defaultLogger;
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
    response.locals.requestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    response.on("finish", () => logger.info({ requestId, method: request.method, path: request.path, statusCode: response.statusCode }, "HTTP request completed"));
    const origin = request.header("origin");
    if (origin && origin !== webOrigin) return response.status(403).json({ error: "Request origin is not allowed." });
    return next();
  });
  app.use(cors({ origin: webOrigin, credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Last-Event-ID"] }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  ensureClipStorage();

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, mode: adapter.mode, configured: adapter.configured });
  });
  app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many sign-in attempts. Try again later." } }), auth.login);

  const mediaOnly = requireMediaGateway(dependencies.mediaGatewayToken ?? config.mediaGateway.webhookToken);
  app.post("/api/calls/:id/answered", mediaOnly, async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    response.json(await calls.markAnswered(z.string().parse(request.params.id)));
  });
  app.post("/api/calls/:id/transcript", mediaOnly, async (request, response) => {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    response.json(await calls.submitTranscript(z.string().parse(request.params.id), body.transcript));
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
  app.post("/api/flows", async (request, response) => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
    return response.status(201).json(await store.createDraft(body.name));
  });
  app.put("/api/flows/:id", async (request, response) => {
    const existing = await store.getFlow(request.params.id);
    if (!existing) return response.status(404).json({ error: "Flow not found." });
    const flow = request.body as FlowDefinition;
    if (!flow || flow.id !== existing.id || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
      return response.status(400).json({ error: "Invalid flow payload." });
    }
    return response.json(await store.saveFlow({ ...flow, status: "draft", version: existing.version }));
  });
  app.post("/api/flows/:id/publish", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const flow = await store.getFlow(request.params.id);
    if (!flow) return response.status(404).json({ error: "Flow not found." });
    const validation = validateFlow(flow, await store.listClips());
    if (!validation.valid) return response.status(422).json(validation);
    const published = await store.saveFlow({ ...flow, status: "published", version: Math.max(1, flow.version + 1) });
    return response.json({ flow: published, validation });
  });
  app.post("/api/clips", async (request, response) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), durationSeconds: z.number().int().min(1).max(180) }).strict().parse(request.body);
    return response.status(201).json(await store.createClip(body.name, body.durationSeconds));
  });
  app.post("/api/clips/upload", clipUpload.single("file"), async (request, response) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), durationSeconds: z.coerce.number().int().min(1).max(180) }).strict().parse(request.body);
    if (!request.file) return response.status(400).json({ error: "Select a WAV or MP3 file." });
    const extension = request.file.filename.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
    return response.status(201).json(await store.createClip(body.name, body.durationSeconds, { format: extension, originalFilename: request.file.originalname, assetUrl: uploadedClipAssetUrl(request.file.filename) }));
  });
  app.post("/api/classify", async (request, response) => {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    response.json(await classifier.classify(body.transcript));
  });
  app.post("/api/calls", rateLimit({ windowMs: 60_000, limit: dependencies.callRateLimit ?? 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Call start rate exceeded. Try again in one minute." }, keyGenerator: (_request, response) => response.locals.operator.id as string }), async (request, response) => {
    const input = z.object({ destination: z.string(), callerId: z.enum(CALLER_IDS), flowId: z.string(), scenario: z.enum(["interested", "not_interested", "callback", "uncertain"]).optional() }).strict().parse(request.body) as TestCallInput;
    response.status(201).json(await calls.start(input));
  });
  app.get("/api/calls/:id", async (request, response) => {
    const call = await calls.get(request.params.id);
    if (!call) return response.status(404).json({ error: "Call not found." });
    return response.json(call);
  });
  app.post("/api/calls/:id/end", async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    response.json(await calls.stop(request.params.id));
  });
  app.get("/api/calls/:id/events", async (request, response) => {
    const call = await calls.get(request.params.id);
    if (!call) return response.status(404).json({ error: "Call not found." });
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    streams.add(response);
    response.write(`data: ${JSON.stringify(call)}\n\n`);
    const unsubscribe = calls.subscribe(request.params.id, (session) => { response.write(`data: ${JSON.stringify(session)}\n\n`); });
    request.on("close", () => { unsubscribe(); streams.delete(response); });
  });
  app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));
  const webRoot = path.resolve(process.cwd(), "dist");
  app.use(express.static(webRoot, { index: "index.html" }));
  app.get(/^(?!\/api(?:\/|$)|\/media(?:\/|$)).*/, (_request, response) => response.sendFile(path.join(webRoot, "index.html")));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof z.ZodError) return response.status(400).json({ error: error.issues[0]?.message ?? "Invalid request." });
    const statusCode = (error as { status?: number })?.status;
    if (statusCode === 400 || statusCode === 413 || statusCode === 404) return response.status(statusCode).json({ error: statusCode === 413 ? "Request is too large." : statusCode === 404 ? "Resource not found." : "Invalid request." });
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (/^The Singtel trunk is at its \d+-call limit\.$/.test(message) || message === "Publish the flow before starting a call.") return response.status(409).json({ error: message });
    logger.error({ err: error, requestId: response.locals.requestId, method: request.method, path: request.path }, "Unhandled request failure");
    return response.status(500).json({ error: "Unexpected server error. Contact the administrator with the request ID.", requestId: response.locals.requestId });
  });
  return { app, closeSseStreams() { for (const stream of streams) stream.end(); streams.clear(); } };
}
