import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [apiImage = "mktr-voice-control:ci", workerImage = "mktr-media-worker:ci"] = process.argv.slice(2);
const prefix = `mktr-container-test-${randomUUID()}`;
const names = { network: `${prefix}-net`, database: `${prefix}-db`, api: `${prefix}-api`, worker: `${prefix}-worker` };
const password = randomBytes(24).toString("hex");
const environment = {
  ...process.env,
  NODE_ENV: "production",
  MKTR_TELEPHONY_MODE: "simulated",
  MKTR_CLASSIFIER_MODE: "rules",
  POSTGRES_DB: "mktr_test_runtime",
  POSTGRES_USER: "mktr_test",
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgresql://mktr_test:${password}@postgres:5432/mktr_test_runtime`,
  MKTR_ADMIN_EMAIL: "container-test@example.invalid",
  MKTR_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
  MKTR_WEB_ORIGIN: "http://localhost:5173"
};
const containers = [];
let networkCreated = false;

async function docker(args) {
  try {
    return (await execute("docker", args, { env: environment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Docker not installed on host; run container verification on the GitHub Linux runner or a Docker host.");
    throw error;
  }
}

async function waitFor(name, probe, timeout = 90_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try { if (await probe()) return; } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${name} did not become ready within ${timeout} ms.`, { cause: lastError });
}

async function publishedUrl(container, port) {
  const address = await docker(["port", container, `${port}/tcp`]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  return `http://${address}`;
}

async function stopCleanly(container) {
  const started = performance.now();
  await docker(["stop", "--time", "10", container]);
  const elapsed = performance.now() - started;
  const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", container]));
  assert.equal(state.Running, false);
  assert.equal(state.ExitCode, 0);
  assert.ok(elapsed < 10_000, "Container must exit before Docker's forced termination deadline.");
  console.log(`PASS: ${container.endsWith("-api") ? "API" : "media worker"} stopped cleanly in ${Math.round(elapsed)} ms.`);
}

try {
  await docker(["compose", "version"]);
  const compose = JSON.parse(await docker(["compose", "--profile", "live", "config", "--format", "json"]));
  for (const service of ["api", "media-worker"]) {
    assert.ok(compose.services[service].healthcheck.test.length > 0);
    assert.equal(compose.services[service].environment.MKTR_TELEPHONY_MODE, "simulated");
  }
  assert.ok((compose.services.freeswitch.ports ?? []).every(port => Number(port.target) !== 8021));
  assert.ok(compose.services.api.ports.every(port => port.host_ip === "127.0.0.1"));
  console.log("PASS: resolved Compose has API/worker healthchecks, simulator defaults, loopback API access and no published ESL.");

  await docker(["network", "create", "--internal", names.network]);
  networkCreated = true;
  containers.push(names.database);
  await docker(["run", "--detach", "--name", names.database, "--network", names.network, "--network-alias", "postgres",
    "-e", "POSTGRES_DB", "-e", "POSTGRES_USER", "-e", "POSTGRES_PASSWORD", "postgres:16-alpine"]);
  await waitFor("Postgres", async () => { await docker(["exec", names.database, "pg_isready", "-h", "127.0.0.1", "-U", "mktr_test", "-d", "mktr_test_runtime"]); return true; });

  containers.push(names.api);
  await docker(["run", "--detach", "--name", names.api, "--network", names.network, "--network-alias", "api",
    "--publish", "127.0.0.1::8787", "--health-interval", "1s", "--health-start-period", "0s",
    "-e", "NODE_ENV", "-e", "MKTR_TELEPHONY_MODE", "-e", "MKTR_CLASSIFIER_MODE", "-e", "DATABASE_URL",
    "-e", "MKTR_ADMIN_EMAIL", "-e", "MKTR_ADMIN_PASSWORD", "-e", "MKTR_WEB_ORIGIN", apiImage]);
  containers.push(names.worker);
  await docker(["run", "--detach", "--name", names.worker, "--network", names.network,
    "--publish", "127.0.0.1::8090", "--health-interval", "1s", "-e", "NODE_ENV", "-e", "MKTR_TELEPHONY_MODE", workerImage]);
  for (const container of [names.api, names.worker]) {
    await waitFor(container, async () => await docker(["inspect", "--format", "{{.State.Health.Status}}", container]) === "healthy");
    assert.notEqual(await docker(["exec", container, "id", "-u"]), "0");
    const pidOneExecutable = await docker(["exec", container, "readlink", "/proc/1/exe"]);
    const nodeExecutable = await docker(["exec", container, "node", "-p", "process.execPath"]);
    assert.equal(pidOneExecutable, nodeExecutable);
  }
  const api = await publishedUrl(names.api, 8787);
  const worker = await publishedUrl(names.worker, 8090);
  const health = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).mode, "simulated");
  const workerHealth = await fetch(`${worker}/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(workerHealth.status, 200);
  assert.equal((await workerHealth.json()).enabled, false);
  assert.equal((await fetch(`${api}/api/calls`, { method: "POST", signal: AbortSignal.timeout(3000) })).status, 401);
  const login = await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: environment.MKTR_WEB_ORIGIN },
    body: JSON.stringify({ email: environment.MKTR_ADMIN_EMAIL, password: environment.MKTR_ADMIN_PASSWORD }), signal: AbortSignal.timeout(5000) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const bootstrap = await fetch(`${api}/api/bootstrap`, { headers: { Cookie: cookie.split(";")[0] }, signal: AbortSignal.timeout(3000) });
  assert.equal(bootstrap.status, 200);
  console.log("PASS: built production images run as non-root Node PID 1; migrations, healthchecks, seeded login and authenticated bootstrap work in an isolated simulator network.");
  await stopCleanly(names.api);
  await stopCleanly(names.worker);
} catch (error) {
  for (const container of containers) {
    try { console.error(await docker(["logs", "--tail", "40", container])); }
    catch (diagnosticError) { console.error(`Could not read fixture logs for ${container}: ${diagnosticError.message}`); }
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const container of containers.toReversed()) {
    try { await docker(["rm", "--force", "--volumes", container]); }
    catch (error) { console.error(`Fixture container cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  if (networkCreated) {
    try { await docker(["network", "rm", names.network]); }
    catch (error) { console.error(`Fixture network cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
