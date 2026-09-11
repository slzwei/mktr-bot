import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";
import type { ClipAsset, Store } from "./store.js";

export type ClipReconciliation = { quarantinedFiles: string[]; archivedClipIds: string[]; missingFiles: string[] };

/** Run before requests are accepted. Keep recoverable bytes in quarantine and
 * archive missing media records; published graph history is never rewritten. */
export async function reconcileClipStorage(store: Store, directory: string): Promise<ClipReconciliation> {
  await store.flush();
  await mkdir(directory, { recursive: true });
  const referenced = new Set<string>();
  const result: ClipReconciliation = { quarantinedFiles: [], archivedClipIds: [], missingFiles: [] };
  for (const clip of store.listClips()) {
    let missing = false;
    for (const url of new Set([clip.assetUrl, clip.previewUrl, (clip as ClipAsset).telephonyAssetUrl])) {
      if (!url?.startsWith("/media/clips/")) continue;
      const filename = decodeURIComponent(url.slice("/media/clips/".length));
      if (!filename || path.basename(filename) !== filename || filename === "." || filename === "..") throw new Error(`Clip ${clip.id} has an unsafe stored media path.`);
      referenced.add(filename);
      try { await access(path.join(directory, filename)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        result.missingFiles.push(filename);
        missing = true;
      }
    }
    if (missing && clip.status !== "archived") {
      store.saveClip({ ...clip, status: "archived" });
      result.archivedClipIds.push(clip.id);
    }
  }
  await store.flush();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || referenced.has(entry.name)) continue;
    // Preserve all unclaimed bytes, including incomplete/failed uploads, for operator recovery.
    const quarantine = path.join(directory, "orphaned");
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    const filename = `${Date.now()}-${randomUUID()}-${entry.name}`;
    await rename(path.join(directory, entry.name), path.join(quarantine, filename));
    result.quarantinedFiles.push(filename);
  }
  if (result.archivedClipIds.length || result.quarantinedFiles.length || result.missingFiles.length) logger.warn(result, "Clip records/files reconciled; inspect orphaned media before deleting it");
  return result;
}
