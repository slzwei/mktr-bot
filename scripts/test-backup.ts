import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const scratch = await mkdtemp(path.join(os.tmpdir(), "mktr-backup-drill-"));
const databaseDirectory = path.join(scratch, "pgdata");
const socketDirectory = path.join(scratch, "socket");
let started = false;
function command(binary: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const connectionArgs = binary === "psql" && env.PGDATABASE ? ["--dbname", env.PGDATABASE] : [];
  const result = spawnSync(binary, [...connectionArgs, ...args], { env, encoding: "utf8" });
  if (result.error) throw new Error(`${binary} is required for the backup restore drill: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
try {
  await mkdir(socketDirectory);
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  command("initdb", ["-D", databaseDirectory, "-U", "mktr", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  command("pg_ctl", ["-D", databaseDirectory, "-l", path.join(scratch, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, "-w", "start"]);
  started = true;
  const rootUrl = `postgresql://mktr@127.0.0.1:${port}/postgres`;
  const sourceUrl = `postgresql://mktr@127.0.0.1:${port}/mktr_drill_source`;
  const targetUrl = `postgresql://mktr@127.0.0.1:${port}/mktr_drill_restore`;
  command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE mktr_drill_source", "-c", "CREATE DATABASE mktr_drill_restore"], { ...process.env, PGDATABASE: rootUrl });
  // Real relational data exercises the dump/restore chain; no application or telephony process runs.
  command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", 'CREATE TABLE "Flow" (id text PRIMARY KEY, name text NOT NULL); CREATE TABLE "Call" (id text PRIMARY KEY, "flowId" text REFERENCES "Flow"(id)); INSERT INTO "Flow" VALUES (\'backup-flow\', \'Saved flow\'); INSERT INTO "Call" VALUES (\'backup-call\', \'backup-flow\');'], { ...process.env, PGDATABASE: sourceUrl });
  const clips = path.join(scratch, "clips");
  const restoredClips = path.join(scratch, "restored-clips");
  const backup = path.join(scratch, "backup");
  await mkdir(clips);
  await mkdir(restoredClips);
  const clipBytes = Buffer.from("RIFF backup drill clip bytes\n");
  await writeFile(path.join(clips, "sample.wav"), clipBytes);
  command("bash", ["scripts/backup.sh", backup], { ...process.env, MKTR_BACKUP_DATABASE_URL: sourceUrl, MKTR_BACKUP_CLIP_DIR: clips });
  command("bash", ["scripts/restore.sh", backup], { ...process.env, MKTR_RESTORE_DATABASE_URL: targetUrl, MKTR_RESTORE_CLIP_DIR: restoredClips });
  assert.equal(command("psql", ["-X", "-Atc", 'SELECT "Call".id || \':\' || "Flow".name FROM "Call" JOIN "Flow" ON "Call"."flowId" = "Flow".id'], { ...process.env, PGDATABASE: targetUrl }), "backup-call:Saved flow");
  assert.deepEqual(await readFile(path.join(restoredClips, "sample.wav")), clipBytes);
  const refused = spawnSync("bash", ["scripts/restore.sh", backup], { env: { ...process.env, MKTR_RESTORE_DATABASE_URL: targetUrl, MKTR_RESTORE_CLIP_DIR: restoredClips }, encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /nonempty/);
  const emptyClips = path.join(scratch, "empty-clips");
  await mkdir(emptyClips);
  const refusedDatabase = spawnSync("bash", ["scripts/restore.sh", backup], { env: { ...process.env, MKTR_RESTORE_DATABASE_URL: targetUrl, MKTR_RESTORE_CLIP_DIR: emptyClips }, encoding: "utf8" });
  assert.equal(refusedDatabase.status, 2);
  assert.match(refusedDatabase.stderr, /nonempty database/);
  command("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE mktr_drill_corrupt"], { ...process.env, PGDATABASE: rootUrl });
  await writeFile(path.join(backup, "clips.tar.gz"), "corrupted archive");
  const refusedChecksum = spawnSync("bash", ["scripts/restore.sh", backup], { env: { ...process.env, MKTR_RESTORE_DATABASE_URL: `postgresql://mktr@127.0.0.1:${port}/mktr_drill_corrupt`, MKTR_RESTORE_CLIP_DIR: emptyClips }, encoding: "utf8" });
  assert.notEqual(refusedChecksum.status, 0);
  assert.match(refusedChecksum.stdout + refusedChecksum.stderr, /FAILED|did NOT match/);
  console.log("Backup restore drill passed: PostgreSQL relational rows and clip bytes restored; nonempty database/directory and checksum mismatch rejected.");
} finally {
  if (started) command("pg_ctl", ["-D", databaseDirectory, "-m", "fast", "-w", "stop"]);
  await rm(scratch, { recursive: true, force: true });
}
