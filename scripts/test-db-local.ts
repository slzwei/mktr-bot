import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(os.tmpdir(), "mktr-postgres-test-"));
const password = randomBytes(32).toString("hex");
const environment = { ...process.env, PGPASSWORD: password };
function run(command: string, args: string[], capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => reject(new Error(`Local Postgres test requires installed ${command}.`, { cause: error })));
    child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${code}).`)));
  });
}
let started = false;
let bin = "";
try {
  bin = await run("pg_config", ["--bindir"], true);
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  await writeFile(path.join(directory, "password"), password, { mode: 0o600 });
  await run(path.join(bin, "initdb"), ["-D", path.join(directory, "data"), "-U", "mktr_test", "--auth-local=trust", "--auth-host=scram-sha-256", "--pwfile", path.join(directory, "password")], true);
  await run(path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-l", path.join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"], true);
  started = true;
  await run(path.join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", "mktr_test", "mktr_test"]);
  Object.assign(environment, { DATABASE_TEST_URL: `postgresql://mktr_test:${password}@127.0.0.1:${port}/mktr_test` });
  await run("npm", ["run", "test:db"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (started) await run(path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-m", "fast", "-w", "stop"], true);
  await rm(directory, { recursive: true, force: true });
}
