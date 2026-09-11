import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { migrateDatabase } from "../server/runtime-store.js";

const require = createRequire(import.meta.url);
const environment = { ...process.env, MKTR_TELEPHONY_MODE: "simulated", MKTR_DB_TEST_PASSWORD: randomBytes(32).toString("hex") };
const project = `mktr-db-test-${process.pid}-${randomBytes(4).toString("hex")}`;
const composeArgs = ["compose", "-p", project, "-f", "docker-compose.db-test.yml"];
function run(executable: string, args: string[], capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error: NodeJS.ErrnoException) => reject(new Error(executable === "docker" && error.code === "ENOENT" ? "Docker not installed on host; set DATABASE_TEST_URL to a disposable local Postgres to run the same suite." : `Could not start ${executable}.`, { cause: error })));
    child.on("exit", (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} ${args[0]} failed (${signal ?? code}).`)));
  });
}
let started = false;
try {
  let databaseUrl = process.env.DATABASE_TEST_URL;
  if (!databaseUrl) {
    await run("docker", ["compose", "version"]);
    started = true;
    await run("docker", [...composeArgs, "up", "--wait", "--detach", "postgres"]);
    const address = await run("docker", [...composeArgs, "port", "postgres", "5432"], true);
    const port = address.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Compose did not report the disposable Postgres port.");
    databaseUrl = `postgresql://mktr_test:${environment.MKTR_DB_TEST_PASSWORD}@127.0.0.1:${port}/mktr_test`;
  }
  const parsed = new URL(databaseUrl);
  // Only accept explicitly named test databases; never migrate an operator's application DB.
  if (!/^\/mktr_test(?:_[a-zA-Z0-9_]+)?$/.test(parsed.pathname)) throw new Error("DATABASE_TEST_URL must name a disposable mktr_test or mktr_test_* database.");
  await migrateDatabase(databaseUrl);
  Object.assign(environment, { DATABASE_TEST_URL: databaseUrl });
  await run(process.execPath, ["--import", require.resolve("tsx"), "--test", "server/test-support/prisma-store.integration.ts"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (started) await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
}
