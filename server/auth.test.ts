import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import test, { before } from "node:test";
import pino from "pino";
import request from "supertest";
import { createApp } from "./app.js";
import { hashPassword, InMemoryAuthStore, seedAdmin, SESSION_COOKIE, type AuthUser } from "./auth.js";
import { RuleClassifier } from "./classifier.js";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { config } from "./config.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";

const password = randomBytes(24).toString("hex");
const email = "operator@example.test";
const origin = "https://voice.example.test";
let admin: AuthUser;
before(async () => { admin = { id: "test-admin", email, passwordHash: await hashPassword(password), role: "admin" }; });

async function fixture(options: { role?: "operator" | "admin"; failBootstrap?: boolean } = {}) {
  const authStore = new InMemoryAuthStore();
  await authStore.saveUser({ ...admin, role: options.role ?? "admin" });
  const store = new InMemoryStore();
  const adapter = new SimulatedTelephonyAdapter();
  const calls = new CallOrchestrator(store, adapter);
  let logs = "";
  const logger = pino({}, new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } }));
  if (options.failBootstrap) store.listFlows = () => { throw new Error("private-database-detail"); };
  const { app } = createApp({ store, adapter, calls, authStore, classifier: new RuleClassifier(), webOrigin: origin, logger, callRateLimit: 2, mediaGatewayToken: "test-media-token" });
  const login = async () => {
    const response = await request(app).post("/api/auth/login").set("Origin", origin).send({ email, password }).expect(200);
    const setCookie = response.headers["set-cookie"] as unknown as string[];
    return { response, cookie: setCookie[0].split(";")[0] };
  };
  return { app, authStore, login, logs: () => logs };
}

test("auth middleware rejects unauthenticated calls, publishing, uploads, flow writes and history", async () => {
  const { app } = await fixture();
  await request(app).post("/api/calls").send({}).expect(401);
  await request(app).post("/api/flows/flow-prospect-intake/publish").expect(401);
  await request(app).post("/api/clips/upload").attach("file", Buffer.from("unused"), "test.wav").expect(401);
  await request(app).post("/api/flows").send({ name: "Unauthenticated" }).expect(401);
  await request(app).put("/api/flows/flow-prospect-intake").send({}).expect(401);
  await request(app).get("/api/bootstrap").expect(401);
  await request(app).get("/api/calls/missing/events").expect(401);
  await request(app).get("/api/settings").expect(401);
  await request(app).get("/api/help/runbook").expect(401);
  await request(app).get("/api/health").expect(200);
});

test("operator settings never serialize credentials and the runbook is served after sign-in", async () => {
  const { app, login } = await fixture();
  const { cookie } = await login();
  const previousKey = config.classifier.openaiApiKey;
  const previousPassword = config.singtel.password;
  config.classifier.openaiApiKey = "private-provider-sentinel";
  config.singtel.password = "private-trunk-sentinel";
  try {
    const settings = await request(app).get("/api/settings").set("Cookie", cookie).expect(200);
    assert.equal(settings.body.telephony.mode, "simulated");
    assert.equal(settings.body.classifier.mode, "rules");
    assert.doesNotMatch(settings.text, /private-provider-sentinel|private-trunk-sentinel|password|ApiKey|webhookToken|database/i);
    const runbook = await request(app).get("/api/help/runbook").set("Cookie", cookie).expect(200);
    assert.match(runbook.headers["content-type"], /^text\/plain/);
    assert.match(runbook.text, /Shawn/);
  } finally {
    config.classifier.openaiApiKey = previousKey;
    config.singtel.password = previousPassword;
  }
});

test("wrong-origin preflight is rejected and allowed CORS is credentialed without a wildcard", async () => {
  const { app } = await fixture();
  const denied = await request(app).options("/api/calls").set("Origin", "https://untrusted.example.test").set("Access-Control-Request-Method", "POST").expect(403);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  const allowed = await request(app).options("/api/calls").set("Origin", origin).set("Access-Control-Request-Method", "POST").expect(204);
  assert.equal(allowed.headers["access-control-allow-origin"], origin);
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
});

test("argon2id sign-in issues a secure opaque cookie, stores its hash, and rotates and revokes sessions", async () => {
  const { app, authStore, login } = await fixture();
  assert.match(admin.passwordHash, /^\$argon2id\$/);
  const { cookie, response } = await login();
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(response.headers["set-cookie"]), /Secure/);
  assert.match(String(response.headers["set-cookie"]), /SameSite=Strict/);
  assert.equal(response.body.user.passwordHash, undefined);
  const raw = cookie.slice(SESSION_COOKIE.length + 1);
  const hash = createHash("sha256").update(raw).digest("hex");
  assert.equal(await authStore.getSession(raw), undefined);
  assert.equal((await authStore.getSession(hash))?.userId, admin.id);
  await request(app).get("/api/bootstrap").set("Cookie", cookie).expect(200);
  const replacement = await request(app).post("/api/auth/login").set("Cookie", cookie).send({ email, password }).expect(200);
  await request(app).get("/api/auth/session").set("Cookie", cookie).expect(401);
  const second = (replacement.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  await request(app).post("/api/auth/logout").set("Cookie", second).expect(200);
  await request(app).get("/api/auth/session").set("Cookie", second).expect(401);
});

test("expired sessions and incorrect passwords cannot access operator routes", async () => {
  const { app, authStore, login } = await fixture();
  await request(app).post("/api/auth/login").send({ email, password: "incorrect" }).expect(401);
  await request(app).post("/api/auth/login").send({ email: "missing@example.test", password }).expect(401);
  const { cookie } = await login();
  const tokenHash = createHash("sha256").update(cookie.slice(SESSION_COOKIE.length + 1)).digest("hex");
  await authStore.saveSession({ tokenHash, userId: admin.id, expiresAt: new Date(0).toISOString() });
  await request(app).get("/api/bootstrap").set("Cookie", cookie).expect(401);
  assert.equal(await authStore.getSession(tokenHash), undefined);
});

test("operator role cannot request a telephony-mode change and administrator changes require deployment", async () => {
  const operator = await fixture({ role: "operator" });
  const session = await operator.login();
  await request(operator.app).put("/api/settings/telephony-mode").set("Cookie", session.cookie).send({ mode: "freeswitch" }).expect(403);
  const administrator = await fixture();
  const signedIn = await administrator.login();
  await request(administrator.app).put("/api/settings/telephony-mode").set("Cookie", signedIn.cookie).send({ mode: "freeswitch" }).expect(409);
});

test("call starts are rate limited per authenticated operator and security headers are present", async () => {
  const { app, login } = await fixture();
  const { cookie } = await login();
  await request(app).post("/api/calls").set("Cookie", cookie).send({}).expect(400);
  await request(app).post("/api/calls").set("Cookie", cookie).send({}).expect(400);
  await request(app).post("/api/calls").set("Cookie", cookie).send({}).expect(429);
  const response = await request(app).get("/api/health").expect(200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(response.headers["x-powered-by"], undefined);
});

test("media webhooks reject missing, malformed and incorrect bearer tokens before touching call state", async () => {
  const { app } = await fixture();
  for (const value of ["", "Bearer wrong", "Bearer test-media-token-extra", "test-media-token"]) {
    await request(app).post("/api/calls/missing/answered").set("Authorization", value).send({}).expect(401);
  }
  await request(app).post("/api/calls/missing/transcript").send({ transcript: "hello" }).expect(401);
});

test("unexpected HTTP errors log context and return generic 500s without private details", async () => {
  const { app, login, logs } = await fixture({ failBootstrap: true });
  const { cookie } = await login();
  const response = await request(app).get("/api/bootstrap").set("Cookie", cookie).expect(500);
  assert.doesNotMatch(JSON.stringify(response.body), /private-database-detail/);
  assert.equal(response.body.requestId, response.headers["x-request-id"]);
  assert.match(logs(), /private-database-detail/);
  assert.doesNotMatch(logs(), new RegExp(password));
});

test("admin seed is idempotent, never uses a default password and does not overwrite existing credentials", async () => {
  const store = new InMemoryAuthStore();
  await assert.rejects(() => seedAdmin(store, { NODE_ENV: "production" }), /required/);
  await assert.rejects(() => seedAdmin(store, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: "short" }), /16/);
  await seedAdmin(store, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password });
  const first = await store.findUserByEmail(email);
  await seedAdmin(store, { MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: `${password}changed` });
  assert.deepEqual(await store.findUserByEmail(email), first);
});
