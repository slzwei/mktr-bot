import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { renderFreeSwitch, renderFreeSwitchCli } from "../scripts/render-freeswitch.js";

const fixture = () => ({
  MKTR_GATEWAY_PUBLIC_IP: "203.0.113.10",
  MKTR_SINGTEL_SIP_PASSWORD: "dummy-render-only<&>\"'secret"
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
    const environment = { ...fixture(), MKTR_SINGTEL_CA_CERT_PATH: cert, MKTR_FREESWITCH_TLS_PEM_PATH: agent };
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
});
