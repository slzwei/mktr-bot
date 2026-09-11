import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { renderFreeSwitch, renderFreeSwitchCli } from "../scripts/render-freeswitch.js";
import { assertGatewayStartupConfiguration } from "./gateway-security.js";
import { CALLER_IDS, RESERVED_CALLER_ID } from "../src/lib/domain.js";

const fixture = () => ({
  MKTR_GATEWAY_PUBLIC_IP: "203.0.113.10",
  MKTR_SINGTEL_SIP_PASSWORD: "dummy-render-only<&>\"'secret",
  MKTR_FREESWITCH_ESL_PASSWORD: "dummy-esl-render-only<&>\"'secret"
});

function parseXml(xml: string) {
  return new DOMParser({ onError: (level, message) => {
    if (level !== "warning") throw new Error(message);
  } }).parseFromString(xml, "application/xml");
}

test("FreeSWITCH dry render requires no credentials, writes nothing and does not report secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-fs-dry-"));
  try {
    const output = path.join(directory, "conf");
    const rendered = await renderFreeSwitch(fixture(), { dryRun: true, outputDirectory: output });
    assert.ok(rendered.files.includes("sip_profiles/external/singtel.xml"));
    await assert.rejects(stat(output), { code: "ENOENT" });
    const message = await renderFreeSwitchCli(["--dry-run"], { MKTR_SINGTEL_SIP_PASSWORD: "must-not-log-this" });
    assert.match(message, /no files written and no network connection made/);
    assert.ok(!message.includes("must-not-log-this"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FreeSWITCH render produces parseable TLS config, escapes credentials and privately installs both TLS files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-fs-render-"));
  try {
    const cert = path.join(directory, "test-ca.pem");
    const key = path.join(directory, "test-key.pem");
    const agent = path.join(directory, "test-agent.pem");
    // Fresh local fixture only: neither private key nor CA bytes enter the repo.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=mktr-config-test.invalid", "-days", "1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    await writeFile(agent, await readFile(key, "utf8") + await readFile(cert, "utf8"), { mode: 0o600 });
    const outputDirectory = path.join(directory, "conf");
    const environment = { ...fixture(), MKTR_SINGTEL_CA_CERT_PATH: cert, MKTR_FREESWITCH_TLS_PEM_PATH: agent, MKTR_INBOUND_CALLBACK_ENABLED: "true", MKTR_INBOUND_CLIP_FILE: "11111111-1111-1111-1111-111111111111.wav", MKTR_INBOUND_RECORD_MESSAGE: "true", MKTR_MAX_CONCURRENT_CALLS: "1" };
    const rendered = await renderFreeSwitch(environment, { outputDirectory });
    assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
    for (const file of rendered.files) {
      const filename = path.join(outputDirectory, file);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      if (file.endsWith(".xml")) parseXml(await readFile(filename, "utf8"));
    }
    const gateway = parseXml(await readFile(path.join(outputDirectory, "sip_profiles/external/singtel.xml"), "utf8"));
    const params = Array.from(gateway.getElementsByTagName("param"));
    assert.equal(params.find((param) => param.getAttribute("name") === "password")?.getAttribute("value"), environment.MKTR_SINGTEL_SIP_PASSWORD);
    const profile = parseXml(await readFile(path.join(outputDirectory, "sip_profiles/external.xml"), "utf8"));
    const settings = Object.fromEntries(Array.from(profile.getElementsByTagName("param")).map((param) => [param.getAttribute("name"), param.getAttribute("value")]));
    assert.equal(settings["tls-only"], "true");
    assert.equal(settings["tls-sip-port"], "5061");
    assert.equal(settings["tls-verify-policy"], "out|subjects_out");
    assert.equal(settings["tls-cert-dir"], "/etc/freeswitch/tls");
    assert.equal(settings["apply-inbound-acl"], "mktr-singtel-inbound");
    assert.equal(settings["auth-calls-acl-only"], "true");
    const callback = parseXml(await readFile(path.join(outputDirectory, "dialplan/public.xml"), "utf8"));
    const extension = Array.from(callback.getElementsByTagName("extension")).find((entry) => entry.getAttribute("name") === "mktr-inbound-callback")!;
    const destination = Array.from(extension.getElementsByTagName("condition")).find((entry) => entry.getAttribute("field") === "destination_number")!;
    const matcher = new RegExp(destination.getAttribute("expression")!);
    assert.ok(CALLER_IDS.every((id) => matcher.test(id) && matcher.test(id.slice(1))));
    assert.equal(matcher.test(RESERVED_CALLER_ID), false);
    assert.equal(matcher.test("+6590000000"), false);
    const applications = Array.from(extension.getElementsByTagName("action"));
    assert.ok(applications.find((item) => item.getAttribute("application") === "answer"));
    assert.equal(applications.find((item) => item.getAttribute("application") === "playback")?.getAttribute("data"), "/var/lib/freeswitch/recordings/mktr/11111111-1111-1111-1111-111111111111.wav");
    assert.ok(applications.find((item) => item.getAttribute("data") === "execute_on_answer=sched_hangup +180 ALLOTTED_TIMEOUT"));
    const record = Array.from(callback.getElementsByTagName("action")).find((item) => item.getAttribute("application") === "record");
    assert.equal(record?.getAttribute("data"), "/var/lib/freeswitch/recordings/sessions/${uuid}.wav 60 200 5");
    const limits = parseXml(await readFile(path.join(outputDirectory, "autoload_configs/switch.conf.xml"), "utf8"));
    assert.equal(Array.from(limits.getElementsByTagName("param")).find((item) => item.getAttribute("name") === "max-sessions")?.getAttribute("value"), "1");
    const avmd = parseXml(await readFile(path.join(outputDirectory, "autoload_configs/avmd.conf.xml"), "utf8"));
    const avmdSettings = Object.fromEntries(Array.from(avmd.getElementsByTagName("param")).map((item) => [item.getAttribute("name"), item.getAttribute("value")]));
    assert.equal(avmdSettings.outbound_channel, "1");
    assert.equal(avmdSettings.inbound_channel, "0");
    assert.equal(avmdSettings.detection_mode, "2");
    const socket = parseXml(await readFile(path.join(outputDirectory, "autoload_configs/event_socket.conf.xml"), "utf8"));
    const socketSettings = Object.fromEntries(Array.from(socket.getElementsByTagName("param")).map((param) => [param.getAttribute("name"), param.getAttribute("value")]));
    assert.equal(socketSettings["password"], environment.MKTR_FREESWITCH_ESL_PASSWORD);
    assert.equal(socketSettings["listen-ip"], "172.29.80.4");
    assert.equal(socketSettings["apply-inbound-acl"], "mktr-esl");
    const acl = parseXml(await readFile(path.join(outputDirectory, "autoload_configs/acl.conf.xml"), "utf8"));
    const list = Array.from(acl.getElementsByTagName("list")).find((entry) => entry.getAttribute("name") === "mktr-esl");
    assert.equal(list?.getAttribute("default"), "deny");
    assert.deepEqual(Array.from(list!.getElementsByTagName("node")).map((entry) => [entry.getAttribute("type"), entry.getAttribute("cidr")]), [
      ["allow", "172.29.80.2/32"], ["allow", "172.29.80.3/32"]
    ]);
    const vars = await readFile(path.join(outputDirectory, "vars.xml"), "utf8");
    assert.match(vars, /external_sip_ip=203\.0\.113\.10/);
    assert.match(vars, /external_rtp_ip=203\.0\.113\.10/);
    assert.deepEqual(await readFile(path.join(outputDirectory, "tls/cafile.pem")), await readFile(cert));
    assert.deepEqual(await readFile(path.join(outputDirectory, "tls/agent.pem")), await readFile(agent));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FreeSWITCH render fails before creating output when secrets or public IP are unsafe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-fs-invalid-"));
  try {
    const outputDirectory = path.join(directory, "conf");
    await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_SINGTEL_SIP_PASSWORD: undefined }, { outputDirectory }), /MKTR_SINGTEL_SIP_PASSWORD/);
    await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_GATEWAY_PUBLIC_IP: "172.29.80.4" }, { outputDirectory }), /public IPv4/);
    await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_SINGTEL_SIP_PASSWORD: "bad\npassword" }, { outputDirectory }), /control characters/);
    await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_SINGTEL_SIP_PASSWORD: "${execute(something)}" }, { outputDirectory }), /FreeSWITCH expansions/);
    await assert.rejects(renderFreeSwitch(fixture(), { outputDirectory }), /MKTR_SINGTEL_CA_CERT_PATH/);
    await assert.rejects(stat(outputDirectory), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FreeSWITCH compose publishes exactly the configured local RTP range and no plain SIP listener", async () => {
  const configuration = parseXml(await readFile("telephony/freeswitch/conf/autoload_configs/switch.conf.xml", "utf8"));
  const settings = Object.fromEntries(Array.from(configuration.getElementsByTagName("param")).map((param) => [param.getAttribute("name"), param.getAttribute("value")]));
  const range = `${settings["rtp-start-port"]}-${settings["rtp-end-port"]}`;
  const compose = await readFile("docker-compose.yml", "utf8");
  const gatewayService = compose.split("\n  freeswitch:\n")[1]?.split("\nnetworks:")[0];
  assert.ok(gatewayService);
  assert.ok(gatewayService.includes(`"${range}:${range}/udp"`));
  assert.match(gatewayService, /5061:5061\/tcp/);
  assert.doesNotMatch(gatewayService, /5060:5060|5080:5080/);
  assert.doesNotMatch(gatewayService, /8021:8021/);
});

test("FreeSWITCH startup rejects default, short and framed ESL passwords through the pure config guard", () => {
  for (const password of ["", "ClueCon", "cluecon", "123456789012345", "long-enough-but\ninjected"]) {
    assert.throws(() => assertGatewayStartupConfiguration({ telephonyMode: "freeswitch", freeswitch: { password } }), /MKTR_FREESWITCH_ESL_PASSWORD/);
  }
  assert.doesNotThrow(() => assertGatewayStartupConfiguration({ telephonyMode: "freeswitch", freeswitch: { password: "strong-test-fixture-only" } }));
  assert.doesNotThrow(() => assertGatewayStartupConfiguration({ telephonyMode: "simulated", freeswitch: { password: "" } }));
});

test("FreeSWITCH renderer rejects a weak ESL password and wildcard ACL addresses before creating files", async () => {
  await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_FREESWITCH_ESL_PASSWORD: "ClueCon" }, { dryRun: true }), /MKTR_FREESWITCH_ESL_PASSWORD/);
  await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_API_TELEPHONY_IP: "0.0.0.0" }, { dryRun: true }), /distinct container interface addresses/);
  await assert.rejects(renderFreeSwitch({ ...fixture(), MKTR_API_TELEPHONY_IP: "172.29.80.4" }, { dryRun: true }), /distinct container interface addresses/);
});
