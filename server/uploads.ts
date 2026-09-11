import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import { config } from "./config.js";

const supportedExtensions = new Set([".wav", ".mp3"]);
const supportedMimeTypes = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "application/octet-stream"]);

export function ensureClipStorage() {
  mkdirSync(config.clipStorageDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    ensureClipStorage();
    callback(null, config.clipStorageDir);
  },
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${randomUUID()}${extension}`);
  }
});

export const clipUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!supportedExtensions.has(extension) || !supportedMimeTypes.has(file.mimetype)) {
      callback(new Error("Only WAV and MP3 audio clips are supported."));
      return;
    }
    callback(null, true);
  }
});

export function uploadedClipAssetUrl(filename: string) {
  return `/media/clips/${encodeURIComponent(filename)}`;
}
