import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CallSession } from "../src/lib/domain.js";
import type { OutcomeCall } from "./outcomes.js";
import { logger } from "./logger.js";

export interface RecordingStore { listCalls(): CallSession[]; saveCall(call: CallSession): CallSession; flush(): Promise<void>; }
export const recordingFilename = (value: string): string => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.wav$/i.test(value)) throw new Error("Invalid recording filename.");
  return value;
};

export async function purgeRecordings(store: RecordingStore, directory: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error("Recording retention must be from 1 to 365 days.");
  await store.flush();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const calls = store.listCalls() as OutcomeCall[];
  const activeFiles = new Set(calls.filter((call) => !["ended", "failed"].includes(call.status)).map((call) => call.recordingFile));
  let purged = 0;
  for (const call of calls) {
    const deadline = Math.min(Date.parse(call.recordingExpiresAt ?? "1970-01-01"), Date.parse(call.createdAt) + retentionDays * 86_400_000);
    if (!call.recordingFile || activeFiles.has(call.recordingFile) || deadline > now) continue;
    await rm(path.join(directory, recordingFilename(call.recordingFile)), { force: true });
    call.recordingFile = undefined;
    call.recordingExpiresAt = undefined;
    store.saveCall(call);
    await store.flush();
    purged++;
  }
  // An API crash may precede the record metadata write; stale orphan bytes still expire.
  const known = new Set(calls.flatMap((call) => call.recordingFile ? [call.recordingFile] : []));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.wav$/i.test(entry.name) || known.has(entry.name)) continue;
    const info = await stat(path.join(directory, entry.name));
    if (now - info.mtimeMs >= retentionDays * 86_400_000) { await rm(path.join(directory, entry.name)); purged++; }
  }
  if (purged) logger.info({ purged }, "Expired session recordings purged");
  return purged;
}

/** One coalesced local job; completion is awaited before the store is closed. */
export async function startRecordingPurger(store: RecordingStore, options: { directory: string; retentionDays: number }) {
  let pending: Promise<unknown> = Promise.resolve();
  const tick = () => { pending = pending.then(() => purgeRecordings(store, options.directory, options.retentionDays)); return pending; };
  await tick();
  const timer = setInterval(() => { void tick().catch((error) => { logger.error({ err: error }, "Recording purge failed; retrying next interval"); pending = Promise.resolve(); }); }, 60 * 60 * 1000);
  timer.unref();
  return { async close() { clearInterval(timer); await pending; } };
}
