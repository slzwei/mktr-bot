import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { z } from "zod";
import { CALLER_IDS, type FlowDefinition, type TestCallInput } from "../src/lib/domain.js";
import { config } from "./config.js";
import { createTranscriptClassifier } from "./classifier.js";
import { validateFlow } from "./flow-validation.js";
import { CallOrchestrator } from "./orchestrator.js";
import { InMemoryStore } from "./store.js";
import { createTelephonyAdapter, getTrunkStatus } from "./telephony.js";
import { clipUpload, ensureClipStorage, uploadedClipAssetUrl } from "./uploads.js";

const store = new InMemoryStore();
const adapter = createTelephonyAdapter();
const classifier = createTranscriptClassifier();
const calls = new CallOrchestrator(store, adapter, classifier);
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
ensureClipStorage();
app.use("/media/clips", express.static(config.clipStorageDir, { fallthrough: false, maxAge: "1h" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, mode: adapter.mode, configured: adapter.configured });
});

app.get("/api/bootstrap", (_request, response) => {
  response.json({
    flows: store.listFlows(),
    clips: store.listClips(),
    calls: store.listCalls(),
    trunk: getTrunkStatus(calls.activeCallCount(), adapter)
  });
});

app.get("/api/flows/:id", (request, response) => {
  const flow = store.getFlow(request.params.id);
  if (!flow) return response.status(404).json({ error: "Flow not found." });
  return response.json(flow);
});

app.post("/api/flows", (request, response) => {
  const schema = z.object({ name: z.string().trim().min(1).max(80) });
  const body = schema.parse(request.body);
  return response.status(201).json(store.createDraft(body.name));
});

app.put("/api/flows/:id", (request, response) => {
  const existing = store.getFlow(request.params.id);
  if (!existing) return response.status(404).json({ error: "Flow not found." });
  const flow = request.body as FlowDefinition;
  if (!flow || flow.id !== existing.id || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return response.status(400).json({ error: "Invalid flow payload." });
  }
  // Keep the latest published revision as the draft baseline. Publishing this
  // draft will create the next revision instead of resetting to v1.
  return response.json(store.saveFlow({ ...flow, status: "draft", version: existing.version }));
});

app.post("/api/flows/:id/publish", (request, response) => {
  const flow = store.getFlow(request.params.id);
  if (!flow) return response.status(404).json({ error: "Flow not found." });
  const validation = validateFlow(flow, store.listClips());
  if (!validation.valid) return response.status(422).json(validation);
  const published = store.saveFlow({
    ...flow,
    status: "published",
    version: Math.max(1, flow.version + 1)
  });
  return response.json({ flow: published, validation });
});

app.post("/api/clips", (request, response) => {
  const schema = z.object({ name: z.string().trim().min(1).max(80), durationSeconds: z.number().int().min(1).max(180) });
  const body = schema.parse(request.body);
  return response.status(201).json(store.createClip(body.name, body.durationSeconds));
});

app.post("/api/clips/upload", clipUpload.single("file"), (request, response) => {
  const schema = z.object({ name: z.string().trim().min(1).max(80), durationSeconds: z.coerce.number().int().min(1).max(180) });
  const body = schema.parse(request.body);
  if (!request.file) return response.status(400).json({ error: "Select a WAV or MP3 file." });
  const extension = request.file.filename.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
  return response.status(201).json(store.createClip(body.name, body.durationSeconds, {
    format: extension,
    originalFilename: request.file.originalname,
    assetUrl: uploadedClipAssetUrl(request.file.filename)
  }));
});

app.post("/api/classify", async (request, response, next) => {
  try {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000) }).parse(request.body);
    response.json(await classifier.classify(body.transcript));
  } catch (error) {
    next(error);
  }
});

app.post("/api/calls", async (request, response, next) => {
  try {
    const schema = z.object({
      destination: z.string(),
      callerId: z.enum(CALLER_IDS),
      flowId: z.string(),
      scenario: z.enum(["interested", "not_interested", "callback", "uncertain"]).optional()
    });
    const input = schema.parse(request.body) as TestCallInput;
    const call = await calls.start(input);
    response.status(201).json(call);
  } catch (error) {
    next(error);
  }
});

app.get("/api/calls/:id", (request, response) => {
  const call = calls.get(request.params.id);
  if (!call) return response.status(404).json({ error: "Call not found." });
  return response.json(call);
});

app.post("/api/calls/:id/end", async (request, response, next) => {
  try {
    response.json(await calls.stop(request.params.id));
  } catch (error) {
    next(error);
  }
});

const requireMediaGateway = (request: Request, response: Response, next: NextFunction) => {
  const token = request.header("authorization");
  if (!config.mediaGateway.webhookToken || token !== `Bearer ${config.mediaGateway.webhookToken}`) {
    return response.status(401).json({ error: "Media gateway authorization failed." });
  }
  return next();
};

app.post("/api/calls/:id/answered", requireMediaGateway, async (request, response, next) => {
  try {
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await calls.markAnswered(id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/calls/:id/transcript", requireMediaGateway, async (request, response, next) => {
  try {
    const body = z.object({ transcript: z.string().trim().min(1).max(2_000) }).parse(request.body);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await calls.submitTranscript(id, body.transcript));
  } catch (error) {
    next(error);
  }
});

app.get("/api/calls/:id/events", (request, response) => {
  const call = calls.get(request.params.id);
  if (!call) return response.status(404).json({ error: "Call not found." });
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write(`data: ${JSON.stringify(call)}\n\n`);
  const unsubscribe = calls.subscribe(request.params.id, (session) => {
    response.write(`data: ${JSON.stringify(session)}\n\n`);
  });
  request.on("close", unsubscribe);
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: error.issues[0]?.message ?? "Invalid request." });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  const status = message.includes("limit") || message.includes("reserved") || message.includes("Publish") ? 409 : 500;
  return response.status(status).json({ error: message });
});

const webRoot = path.resolve(process.cwd(), "dist");
app.use(express.static(webRoot, { index: "index.html" }));
app.get(/^(?!\/api(?:\/|$)|\/media(?:\/|$)).*/, (_request, response) => {
  response.sendFile(path.join(webRoot, "index.html"));
});

app.listen(config.port, () => {
  console.log(`MKTR Voice API listening on http://localhost:${config.port}`);
});
