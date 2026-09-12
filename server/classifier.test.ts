import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import test from "node:test";
import OpenAI from "openai";
import pino from "pino";
import { z } from "zod";
import { OpenAiClassifier, RuleClassifier } from "./classifier.js";
import { classifierTimeoutFromEnvironment, config } from "./config.js";
import { VoiceMetrics } from "./metrics.js";

function measurements() {
  const logs: string[] = [];
  const logger = pino({}, new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }));
  return { metrics: new VoiceMetrics(logger), logger, logs };
}

test("Singapore English rules classify every transcript fixture correctly", async () => {
  const fixtures = z.array(z.object({ transcript: z.string(), intent: z.enum(["interested", "callback", "not_interested", "unknown"]) })).parse(JSON.parse(await readFile(new URL("./fixtures/classifier-transcripts.json", import.meta.url), "utf8")));
  assert.ok(fixtures.length >= 60);
  assert.equal(new Set(fixtures.map((fixture) => fixture.transcript)).size, fixtures.length);
  const classifier = new RuleClassifier();
  const mismatches: string[] = [];
  for (const fixture of fixtures) {
    const result = await classifier.classify(fixture.transcript);
    if (result.intent !== fixture.intent) mismatches.push(`${JSON.stringify(fixture.transcript)}: wanted ${fixture.intent}, got ${result.intent}`);
    assert.equal(result.transcript, fixture.transcript);
    assert.equal(result.provider, "rules");
  }
  assert.deepEqual(mismatches, [], `${fixtures.length - mismatches.length}/${fixtures.length} fixtures correct`);
});

test("hanging fake OpenAI provider aborts at the default deadline and returns rules within 2 seconds", async () => {
  const captured: { model?: string; store?: boolean }[] = [];
  const server = http.createServer((request) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => { captured.push(JSON.parse(body)); });
    // Deliberately never respond: the SDK's AbortSignal must cancel the request.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { metrics, logger, logs } = measurements();
  const client = new OpenAI({ apiKey: "fake-local-provider-key", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, maxRetries: 5 });
  try {
    const classifier = new OpenAiClassifier({ client, metrics, logger });
    const started = performance.now();
    const result = await classifier.classify("no, call me later");
    const elapsed = performance.now() - started;
    assert.equal(result.intent, "callback");
    assert.equal(result.provider, "rules");
    assert.ok(elapsed < 2000, `Fallback took ${Math.round(elapsed)} ms`);
    assert.equal(captured.length, 1, "the per-request retry override prevents duplicate provider requests");
    assert.equal(captured[0].model, config.classifier.openaiModel);
    assert.equal(captured[0].store, false);
    const exposition = await metrics.registry.metrics();
    assert.match(exposition, /mktr_classifier_fallbacks_total\{reason="timeout"\} 1/);
    assert.match(exposition, /mktr_classifier_duration_seconds_count\{provider="rules"\} 1/);
    assert.match(logs.join(""), /Classifier fell back to rules/);
    assert.doesNotMatch(logs.join(""), /no, call me later|fake-local-provider-key/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("classifier deadline also bounds a provider that ignores cancellation", async () => {
  const { metrics, logger } = measurements();
  let signal: AbortSignal | undefined;
  const classifier = new OpenAiClassifier({ timeoutMs: 20, metrics, logger, provider: { classify: async (_transcript, options) => {
    signal = options.signal;
    return new Promise(() => undefined);
  } } });
  // AbortSignal.timeout is unref'ed by Node; a running HTTP service supplies this handle in production.
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    const result = await classifier.classify("can lah");
    assert.equal(result.intent, "interested");
    assert.equal(result.provider, "rules");
    assert.equal(signal?.aborted, true);
  } finally { clearInterval(keepAlive); }
});

test("provider errors and invalid structured results fall back once without disclosing provider bodies", async () => {
  for (const failure of ["error", "invalid"] as const) {
    const { metrics, logger, logs } = measurements();
    const classifier = new OpenAiClassifier({ metrics, logger, provider: { classify: async () => {
      if (failure === "error") throw new Error("secret-provider-detail-and-transcript");
      return { intent: "interested", sentiment: "positive", confidence: 50 };
    } } });
    const result = await classifier.classify("don't call me back");
    assert.equal(result.intent, "not_interested");
    assert.equal(result.provider, "rules");
    const exposition = await metrics.registry.metrics();
    assert.match(exposition, new RegExp(`mktr_classifier_fallbacks_total\\{reason="${failure === "error" ? "provider_error" : "invalid_response"}"\\} 1`));
    assert.match(exposition, /mktr_classifier_duration_seconds_count\{provider="rules"\} 1/);
    assert.doesNotMatch(logs.join(""), /secret-provider-detail|don't call me back/);
  }
});

test("successful provider results retain the transcript and record one latency with an injectable clock", async () => {
  const { metrics, logger } = measurements();
  let now = 100;
  const classifier = new OpenAiClassifier({ metrics, logger, now: () => now, provider: { classify: async () => {
    now = 275;
    return { intent: "callback", sentiment: "neutral", confidence: 0.95 };
  } } });
  const result = await classifier.classify("Please call next Tuesday");
  assert.deepEqual(result, { intent: "callback", sentiment: "neutral", confidence: 0.95, transcript: "Please call next Tuesday", provider: "openai" });
  const exposition = await metrics.registry.metrics();
  assert.match(exposition, /mktr_classifier_duration_seconds_sum\{provider="openai"\} 0\.175/);
  assert.match(exposition, /mktr_classifier_fallbacks_total\{reason="provider_error"\} 0/);
});

test("classifier timeout configuration defaults to 1500ms and rejects malformed or unbounded values", () => {
  assert.equal(classifierTimeoutFromEnvironment({}), 1500);
  assert.equal(classifierTimeoutFromEnvironment({ MKTR_CLASSIFIER_TIMEOUT_MS: "750" }), 750);
  for (const value of ["-1", "0", "1500ms", "1.5", "30001"]) {
    assert.throws(() => classifierTimeoutFromEnvironment({ MKTR_CLASSIFIER_TIMEOUT_MS: value }), /MKTR_CLASSIFIER_TIMEOUT_MS/);
  }
});
