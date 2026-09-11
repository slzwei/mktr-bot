import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(force); }
}

/** Owns a disposable native Postgres cluster and simulator processes on random loopback ports. */
export async function startRestartHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-browser-restart-"));
  const password = randomBytes(32).toString("hex");
  const environment = { ...process.env, PGPASSWORD: password };
  const apiPort = await freePort();
  const webPort = await freePort();
  const databasePort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const email = "restart-operator@example.test";
  let bin = "";
  let postgresStarted = false;
  let api: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  const run = (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
    const process = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    process.stdout.on("data", (chunk) => { output += String(chunk); });
    process.stderr.on("data", (chunk) => { output += String(chunk); });
    process.once("error", (error) => reject(new Error(`Restart verification requires installed ${path.basename(command)}.`, { cause: error })));
    process.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${path.basename(command)} failed (${code}): ${output.replaceAll(password, "[redacted]")}`)));
  });
  const ready = async (child: ChildProcess, url: string, output: () => string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test process exited before readiness: ${output().replaceAll(password, "[redacted]")}`);
      try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; }
      catch (error) { if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Test process readiness timed out: ${output().replaceAll(password, "[redacted]")}`);
  };
  const startApi = async () => {
    let output = "";
    api = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: { ...process.env, DATABASE_URL: `postgresql://mktr_test:${password}@127.0.0.1:${databasePort}/mktr_test`, MKTR_STORE: "prisma", MKTR_TELEPHONY_MODE: "simulated", MKTR_ADMIN_EMAIL: email, MKTR_ADMIN_PASSWORD: password, PORT: String(apiPort), MKTR_WEB_ORIGIN: webOrigin, MKTR_CLIP_STORAGE_DIR: path.join(directory, "clips"), MKTR_CLASSIFIER_MODE: "rules", LOG_LEVEL: "error" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    api.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-20_000); });
    api.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-20_000); });
    await ready(api, `${apiOrigin}/api/health`, () => output);
  };
  const close = async () => {
    await stop(api);
    await stop(web);
    if (postgresStarted) await run(path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-m", "fast", "-w", "stop"]);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    bin = await run("pg_config", ["--bindir"]);
    await writeFile(path.join(directory, "password"), password, { mode: 0o600 });
    await run(path.join(bin, "initdb"), ["-D", path.join(directory, "data"), "-U", "mktr_test", "--auth-local=trust", "--auth-host=scram-sha-256", "--pwfile", path.join(directory, "password")]);
    await run(path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-l", path.join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${databasePort} -k ${directory}`, "-w", "start"]);
    postgresStarted = true;
    await run(path.join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "mktr_test", "mktr_test"]);
    await startApi();
    let webOutput = "";
    web = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
      env: { ...process.env, MKTR_API_PROXY_TARGET: apiOrigin }, stdio: ["ignore", "pipe", "pipe"]
    });
    web.stdout?.on("data", (chunk) => { webOutput = (webOutput + String(chunk)).slice(-20_000); });
    web.stderr?.on("data", (chunk) => { webOutput = (webOutput + String(chunk)).slice(-20_000); });
    await ready(web, webOrigin, () => webOutput);
    return { apiOrigin, webOrigin, email, password, startApi, crashApi: () => stop(api, "SIGKILL"), close };
  } catch (error) {
    await close();
    throw error;
  }
}
