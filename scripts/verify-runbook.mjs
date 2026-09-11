import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { checkFirstCallConfiguration } from "./check-first-call-config.mjs";

const require = createRequire(import.meta.url);
const document = await readFile("docs/runbook-first-live-call.md", "utf8");
const environment = { PATH: process.env.PATH, MKTR_TELEPHONY_MODE: "simulated", NODE_ENV: "test", LANG: "C" };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment, timeout: 20_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dry verifier command failed: ${command} (${result.status})\n${result.stderr}`);
  return result.stdout;
}
const blocks = [...document.matchAll(/^```bash[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
assert.ok(blocks.length >= 10, "Runbook must contain concrete operator commands.");
for (const block of blocks) {
  // -n parses only: expansions, pipelines, and substitutions are never evaluated.
  run("bash", ["--noprofile", "--norc", "-n"], { input: block });
}
const prose = document.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]).filter((value) => /^(?:npm |node |docker |curl |fs_cli\b|scripts\/[^ ]+\.sh(?:\s|$))/.test(value));
for (const command of inline) run("bash", ["--noprofile", "--norc", "-n"], { input: command + "\n" });
run("bash", ["--noprofile", "--norc", "-n", "scripts/fs-cli-private.sh"]);
run(process.execPath, ["--check", "scripts/check-first-call-config.mjs"]);
assert.ok(document.includes("pending Shawn's designation"));
assert.ok(document.includes("pending Shawn's review"));
assert.ok(document.includes("RESERVED_CALLER_ID"));
assert.ok(!/MKTR_TELEPHONY_MODE\s*=\s*freeswitch/.test(document));
process.stdout.write(`PASS: ${blocks.length} Bash blocks and ${inline.length} inline command references parsed without execution.\n`);

const renderer = run(process.execPath, ["--import", require.resolve("tsx"), "scripts/render-freeswitch.ts", "--dry-run"]);
assert.match(renderer, /no files written and no network connection made/);
process.stdout.write(`PASS: ${renderer.trim()}\n`);

const configuration = {
  services: {
    api: { environment: { MKTR_TELEPHONY_MODE: "simulated", MKTR_MAX_CONCURRENT_CALLS: "1", MKTR_MAX_CALL_SECONDS: "60", MKTR_ORIGINATE_TIMEOUT_SECONDS: "30" }, healthcheck: { test: ["CMD", "node"] } },
    "media-worker": { environment: { MKTR_TELEPHONY_MODE: "simulated" }, healthcheck: { test: ["CMD", "node"] } },
    freeswitch: { ports: [{ target: 5061, published: "5061" }, { target: 10000, published: "10000" }] }
  }
};
assert.equal(checkFirstCallConfiguration(configuration).maxConcurrentCalls, 1);
const gateway = structuredClone(configuration);
gateway.services.api.environment.MKTR_TELEPHONY_MODE = "freeswitch";
gateway.services["media-worker"].environment.MKTR_TELEPHONY_MODE = "freeswitch";
// This is a plain object fixture, never a process environment or running adapter.
assert.equal(checkFirstCallConfiguration(gateway, "freeswitch").maxCallSeconds, 60);
for (const mutate of [
  (value) => { value.services.api.environment.MKTR_MAX_CONCURRENT_CALLS = "5"; },
  (value) => { value.services.api.environment.MKTR_MAX_CALL_SECONDS = "180"; },
  (value) => { value.services["media-worker"].environment.MKTR_TELEPHONY_MODE = "freeswitch"; },
  (value) => { value.services.freeswitch.ports.push({ target: 8021, published: "8021" }); }
]) {
  const invalid = structuredClone(configuration); mutate(invalid); assert.throws(() => checkFirstCallConfiguration(invalid));
}
const safeOutput = run(process.execPath, ["scripts/check-first-call-config.mjs", "--simulated"], { input: JSON.stringify(configuration) });
assert.deepEqual(JSON.parse(safeOutput), checkFirstCallConfiguration(configuration));
process.stdout.write("PASS: first-call config accepts the two valid stage fixtures and rejects unsafe limits, mismatched modes, and published ESL.\n");

const scratch = await mkdtemp(path.join(os.tmpdir(), "mktr-runbook-dry-"));
try {
  const log = path.join(scratch, "arguments");
  const profile = path.join(scratch, "fs_cli.conf");
  await writeFile(profile, "[default]\nhost = 172.29.80.4\nport = 8021\npassword = dry-fixture-secret-only\nno-history-file = true\n", { mode: 0o600 });
  await writeFile(path.join(scratch, "docker"), `#!/bin/sh
set -eu
if [ "$1" = compose ]; then
  for mktr_mock_arg do mktr_mock_last="$mktr_mock_arg"; done
  if [ "$mktr_mock_last" = api ] && [ "\${MKTR_FAKE_API_DOWN:-}" = 1 ]; then exit 0; fi
  printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
elif [ "$1" = run ]; then
  printf '%s\\000' "$@" > "$MKTR_FAKE_DOCKER_LOG"
  printf '%s\\n' +OK
else
  printf '%s\\n' 'Unexpected fake Docker invocation' >&2
  exit 9
fi
`, { mode: 0o700 });
  const mockEnv = { ...environment, PATH: `${scratch}:${environment.PATH}`, MKTR_DEPLOY_ENV: path.join(scratch, "operator.env"), MKTR_FSCLI_PROFILE: profile, MKTR_FAKE_DOCKER_LOG: log };
  const uuid = "11111111-2222-4333-8444-555555555555";
  const commands = [...new Set([...document.matchAll(/^scripts\/fs-cli-private\.sh -x "([^"\n]+)"$/gm)].map((match) => match[1].replaceAll("${MKTR_TEST_PROVIDER_UUID}", uuid)))];
  assert.ok(commands.length >= 8);
  for (const command of commands) {
    assert.ok(!command.includes("$"), "Unresolved variable in diagnostic fixture.");
    const dry = run("bash", ["scripts/fs-cli-private.sh", "--dry-run", "-x", command], { env: mockEnv });
    assert.match(dry, /DRY operator command only/);
    assert.match(dry, /DRY_API_CONTAINER_ID/);
    run("bash", ["scripts/fs-cli-private.sh", "-x", command], { env: mockEnv });
    const args = (await readFile(log, "utf8")).split("\0").filter(Boolean);
    assert.ok(args.includes("container:" + "a".repeat(64)));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("-Q"));
    assert.ok(args.includes(command));
    assert.ok(args.includes(`type=bind,src=${profile},dst=/etc/fs_cli.conf,readonly`));
    assert.ok(!args.includes("-p"));
    assert.ok(!args.join(" ").includes("dry-fixture-secret-only"));
  }
  run("bash", ["scripts/fs-cli-private.sh", "-x", "show channels as json"], { env: { ...mockEnv, MKTR_FAKE_API_DOWN: "1" } });
  run("bash", ["scripts/fs-cli-private.sh", "--dry-run"], { env: mockEnv });
  assert.throws(() => run("bash", ["scripts/fs-cli-private.sh", "-x", "originate forbidden"], { env: mockEnv }), /Dry verifier command failed/);
  process.stdout.write(`PASS: ${commands.length} documented fs_cli commands constructed through fake Docker; worker fallback and originate rejection passed.\n`);
} finally { await rm(scratch, { recursive: true, force: true }); }
process.stdout.write("Dry verification passed. Deployment commands, Docker functionality, real ESL, and provider/trunk checks were not executed.\n");
