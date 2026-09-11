import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/** Pure inspection of resolved Compose JSON. Never starts services or displays secrets. */
export function checkFirstCallConfiguration(configuration, expectedMode = "simulated") {
  if (!["simulated", "freeswitch"].includes(expectedMode)) throw new Error("Unsupported expected telephony mode.");
  const services = configuration.services ?? {};
  const api = services.api?.environment ?? {};
  const worker = services["media-worker"]?.environment ?? {};
  assert.equal(api.MKTR_TELEPHONY_MODE, expectedMode, "API telephony mode does not match this runbook stage.");
  assert.equal(worker.MKTR_TELEPHONY_MODE, expectedMode, "API and media-worker telephony modes must agree.");
  assert.equal(String(api.MKTR_MAX_CONCURRENT_CALLS), "1", "The first-call concurrency ceiling must be 1.");
  assert.equal(String(api.MKTR_MAX_CALL_SECONDS), "60", "The first-call answered-call deadline must be 60 seconds.");
  assert.equal(String(api.MKTR_ORIGINATE_TIMEOUT_SECONDS), "30", "The originate deadline must be 30 seconds for this test.");
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      assert.ok(!(String(port.target) === "8021" && port.published), `Service ${name} must not publish ESL port 8021.`);
    }
  }
  assert.ok(services.freeswitch, "The resolved live-profile configuration must include the gateway.");
  assert.ok(services["media-worker"]?.healthcheck, "The media worker needs a healthcheck.");
  assert.ok(services.api?.healthcheck, "The API needs a healthcheck before the operator test.");
  return { mode: expectedMode, maxConcurrentCalls: 1, maxCallSeconds: 60, originateTimeoutSeconds: 30, eslPublished: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = process.argv[2] ?? "--simulated";
  if (!["--simulated", "--gateway"].includes(option) || process.argv.length > 3) throw new Error("Usage: node scripts/check-first-call-config.mjs [--simulated|--gateway] < resolved-compose.json");
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 2_000_000) throw new Error("Resolved Compose configuration is unexpectedly large.");
    }
    process.stdout.write(JSON.stringify(checkFirstCallConfiguration(JSON.parse(input), option === "--gateway" ? "freeswitch" : "simulated")) + "\n");
  } catch (error) {
    process.stderr.write(`First-call preflight failed: ${error instanceof Error ? error.message : "Invalid configuration"}\n`);
    process.exitCode = 1;
  }
}
