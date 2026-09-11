import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStrongEslPassword } from "../server/gateway-security.js";

type Environment = Record<string, string | undefined>;

export type FreeSwitchRenderOptions = {
  templateDirectory?: string;
  outputDirectory?: string;
  dryRun?: boolean;
};

const defaultTemplates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../telephony/freeswitch/conf");
const safeValue = (name: string, value: string | undefined): string => {
  if (!value || /[\x00-\x1f\x7f]|\$\{|\$\$\{/.test(value)) {
    throw new Error(`${name} is required and must not contain control characters or FreeSWITCH expansions.`);
  }
  return value;
};
const ipv4 = (name: string, value: string): string => {
  if (isIP(value) !== 4) throw new Error(`${name} must be an IPv4 address.`);
  return value;
};
const xmlEscape = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[character]!);

export function freeSwitchTemplateValues(environment: Environment): Record<string, string> {
  assertStrongEslPassword(environment.MKTR_FREESWITCH_ESL_PASSWORD);
  const publicIp = ipv4("MKTR_GATEWAY_PUBLIC_IP", safeValue("MKTR_GATEWAY_PUBLIC_IP", environment.MKTR_GATEWAY_PUBLIC_IP));
  const octets = publicIp.split(".").map(Number);
  if ([0, 10, 127].includes(octets[0]) || octets[0] >= 224 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254)) {
    throw new Error("MKTR_GATEWAY_PUBLIC_IP must be the gateway public IPv4 address, not a private or loopback address.");
  }
  const host = environment.MKTR_SINGTEL_SIP_HOST || "sipsg01.b3networks.com";
  if (!/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host)) throw new Error("MKTR_SINGTEL_SIP_HOST must be a DNS hostname.");
  const username = environment.MKTR_SINGTEL_SIP_USERNAME || "sip69992409";
  if (!/^[a-z\d._-]+$/i.test(username)) throw new Error("MKTR_SINGTEL_SIP_USERNAME has invalid characters.");
  const bindIp = ipv4("MKTR_FREESWITCH_BIND_IP", environment.MKTR_FREESWITCH_BIND_IP || "172.29.80.4");
  const apiIp = ipv4("MKTR_API_TELEPHONY_IP", environment.MKTR_API_TELEPHONY_IP || "172.29.80.2");
  const workerIp = ipv4("MKTR_MEDIA_WORKER_TELEPHONY_IP", environment.MKTR_MEDIA_WORKER_TELEPHONY_IP || "172.29.80.3");
  if (new Set([bindIp, apiIp, workerIp]).size !== 3 || [bindIp, apiIp, workerIp].some((ip) => ip === "0.0.0.0" || ip.startsWith("127."))) {
    throw new Error("FreeSWITCH, API and media-worker telephony IPs must be distinct container interface addresses.");
  }
  return {
    MKTR_GATEWAY_PUBLIC_IP: publicIp,
    MKTR_FREESWITCH_BIND_IP: bindIp,
    MKTR_API_TELEPHONY_IP: apiIp,
    MKTR_MEDIA_WORKER_TELEPHONY_IP: workerIp,
    MKTR_FREESWITCH_ESL_PASSWORD: safeValue("MKTR_FREESWITCH_ESL_PASSWORD", environment.MKTR_FREESWITCH_ESL_PASSWORD),
    MKTR_SINGTEL_SIP_HOST: host,
    MKTR_SINGTEL_SIP_USERNAME: username,
    MKTR_SINGTEL_SIP_PASSWORD: safeValue("MKTR_SINGTEL_SIP_PASSWORD", environment.MKTR_SINGTEL_SIP_PASSWORD)
  };
}

async function listTemplates(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`FreeSWITCH overlay must not contain symbolic links: ${relative}.`);
    if (entry.isDirectory()) result.push(...await listTemplates(directory, relative));
    else if (entry.isFile() && entry.name.endsWith(".xml")) result.push(relative);
    else throw new Error(`Unexpected FreeSWITCH overlay entry: ${relative}.`);
  }
  return result.sort();
}

async function certificateFiles(environment: Environment): Promise<{ ca: string; agent: string }> {
  const ca = safeValue("MKTR_SINGTEL_CA_CERT_PATH", environment.MKTR_SINGTEL_CA_CERT_PATH);
  const agent = safeValue("MKTR_FREESWITCH_TLS_PEM_PATH", environment.MKTR_FREESWITCH_TLS_PEM_PATH);
  try {
    const caContent = await readFile(ca, "utf8");
    const certificates = caContent.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certificates?.length) throw new Error("No CA certificate.");
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new Error("MKTR_SINGTEL_CA_CERT_PATH must point to a readable PEM CA certificate bundle.");
  }
  try {
    const agentContent = await readFile(agent, "utf8");
    const certificate = new X509Certificate(agentContent);
    const privateKey = createPrivateKey(agentContent);
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    if (!certificate.publicKey.export({ type: "spki", format: "der" }).equals(publicKey)) throw new Error("Mismatched TLS key.");
  } catch {
    throw new Error("MKTR_FREESWITCH_TLS_PEM_PATH must contain a readable PEM TLS certificate and its matching unencrypted private key.");
  }
  return { ca, agent };
}

/** Render only; this function never connects to FreeSWITCH or the SIP trunk. */
export async function renderFreeSwitch(environment: Environment, options: FreeSwitchRenderOptions = {}): Promise<{ files: string[]; outputDirectory?: string }> {
  const values = freeSwitchTemplateValues(environment);
  const templateDirectory = options.templateDirectory || defaultTemplates;
  const templates = await listTemplates(templateDirectory);
  if (!templates.includes("freeswitch.xml")) throw new Error("The overlay has no freeswitch.xml entry point.");
  const documents: [string, string][] = [];
  for (const filename of templates) {
    const template = await readFile(path.join(templateDirectory, filename), "utf8");
    const xml = template.replace(/@@([A-Z0-9_]+)@@/g, (_placeholder, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Unknown placeholder ${key} in ${filename}.`);
      return xmlEscape(value);
    });
    if (xml.includes("@@")) throw new Error(`Unresolved placeholder in ${filename}.`);
    documents.push([filename, xml]);
  }
  if (options.dryRun) return { files: templates };
  // Validate all inputs before writing any credential-bearing output.
  const certificates = await certificateFiles(environment);
  const outputDirectory = path.resolve(options.outputDirectory || environment.MKTR_FREESWITCH_RENDER_DIR || "runtime/freeswitch/conf");
  const source = path.resolve(templateDirectory);
  if (outputDirectory === source || outputDirectory.startsWith(source + path.sep)) throw new Error("Rendered output must be outside the tracked FreeSWITCH overlay.");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  for (const [filename, xml] of documents) {
    const destination = path.join(outputDirectory, filename);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, xml, { mode: 0o600 });
    await chmod(destination, 0o600);
  }
  const tlsDirectory = path.join(outputDirectory, "tls");
  await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
  for (const [filename, sourceFile] of [["cafile.pem", certificates.ca], ["agent.pem", certificates.agent]]) {
    await copyFile(sourceFile, path.join(tlsDirectory, filename));
    await chmod(path.join(tlsDirectory, filename), 0o600);
  }
  return { files: [...templates, "tls/cafile.pem", "tls/agent.pem"], outputDirectory };
}

export async function renderFreeSwitchCli(args: string[], environment: Environment = process.env): Promise<string> {
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: npm run render:freeswitch -- [--dry-run]");
  const dryRun = args.includes("--dry-run");
  const result = await renderFreeSwitch(dryRun ? {
    MKTR_GATEWAY_PUBLIC_IP: "203.0.113.10",
    MKTR_SINGTEL_SIP_PASSWORD: "dry-render-placeholder",
    MKTR_FREESWITCH_ESL_PASSWORD: "dry-render-only-not-a-credential"
  } : environment, { dryRun, templateDirectory: environment.MKTR_FREESWITCH_TEMPLATE_DIR });
  return dryRun
    ? `Validated ${result.files.length} FreeSWITCH XML templates with dummy inputs; no files written and no network connection made.`
    : `Rendered ${result.files.length} private FreeSWITCH files to ${result.outputDirectory}; secret values were not logged.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  renderFreeSwitchCli(process.argv.slice(2)).then((message) => process.stdout.write(message + "\n")).catch((error: unknown) => {
    process.stderr.write(`FreeSWITCH rendering failed: ${error instanceof Error ? error.message : "Unexpected error."}\n`);
    process.exitCode = 1;
  });
}
