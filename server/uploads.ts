import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import multer from "multer";
import type { Clip } from "../src/lib/domain.js";
import { config } from "./config.js";
import { HttpError } from "./http-error.js";
import { logger } from "./logger.js";

const runFile = promisify(execFile);
const supportedExtensions = new Set([".wav", ".mp3"]);
const supportedMimeTypes = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "application/octet-stream"]);
const temporaryDirectory = () => path.join(config.clipStorageDir, ".uploads");

export function ensureClipStorage() {
  mkdirSync(config.clipStorageDir, { recursive: true });
  mkdirSync(temporaryDirectory(), { recursive: true, mode: 0o700 });
}

export const clipUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => { ensureClipStorage(); callback(null, temporaryDirectory()); },
    filename: (_request, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, fieldSize: 4_096, parts: 4 },
  fileFilter: (_request, file, callback) => {
    if (!supportedExtensions.has(path.extname(file.originalname).toLowerCase()) || !supportedMimeTypes.has(file.mimetype)) {
      callback(new HttpError(400, "Only WAV and MP3 audio clips are supported."));
      return;
    }
    callback(null, true);
  }
});

export function uploadedClipAssetUrl(filename: string) { return `/media/clips/${encodeURIComponent(filename)}`; }

type AudioProbe = { duration: number; codec: string; sampleRate: number; channels: number; bits: number };
async function probe(filename: string, format?: "wav" | "mp3"): Promise<AudioProbe> {
  let stdout: string;
  try {
    const result = await runFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", ...(format ? ["-f", format] : []), "-select_streams", "a:0", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels,bits_per_sample", "-of", "json", filename], { timeout: 10_000, maxBuffer: 128 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(503, "Audio processing is unavailable. The administrator must install ffmpeg and ffprobe.", { cause: error });
    throw new HttpError(400, "The file does not contain decodable WAV or MP3 audio.", { cause: error });
  }
  const decoded = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_name?: string; sample_rate?: string; channels?: number; bits_per_sample?: number }[] };
  const stream = decoded.streams?.[0];
  const duration = Number(decoded.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new HttpError(400, "The audio file has no measurable audio duration.");
  if (duration > 180.05) throw new HttpError(400, "Audio clips must be 180 seconds or shorter.");
  return { duration, codec: stream.codec_name ?? "", sampleRate: Number(stream.sample_rate), channels: stream.channels ?? 0, bits: stream.bits_per_sample ?? 0 };
}

async function assertMagic(filename: string, format: "wav" | "mp3") {
  const file = await open(filename, "r");
  const header = Buffer.alloc(12);
  try { await file.read(header, 0, 12, 0); } finally { await file.close(); }
  const isWav = header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
  const isMp3 = header.toString("ascii", 0, 3) === "ID3" || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 0x06) !== 0);
  if ((format === "wav" && !isWav) || (format === "mp3" && !isMp3)) throw new HttpError(400, "Audio content does not match its WAV or MP3 extension.");
}

export type ProcessedClip = Pick<Clip, "assetUrl" | "previewUrl" | "originalFilename" | "format" | "durationSeconds" | "telephonyAssetUrl">;
let activeConversions = 0;
export async function processUploadedClip(file: Express.Multer.File): Promise<ProcessedClip> {
  if (activeConversions >= 2) throw new HttpError(429, "Two audio uploads are already being processed. Try again shortly.");
  activeConversions += 1;
  const format = path.extname(file.originalname).toLowerCase() === ".mp3" ? "mp3" : "wav";
  const normalizedName = `${randomUUID()}.wav`;
  const normalizedTemporary = path.join(temporaryDirectory(), normalizedName);
  const originalDestination = path.join(config.clipStorageDir, file.filename);
  const normalizedDestination = path.join(config.clipStorageDir, normalizedName);
  let originalMoved = false;
  let normalizedMoved = false;
  try {
    await assertMagic(file.path, format);
    await probe(file.path, format);
    try {
      await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-f", format, "-i", file.path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-t", "181", normalizedTemporary], { timeout: 20_000, maxBuffer: 128 * 1024 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(503, "Audio processing is unavailable. The administrator must install ffmpeg and ffprobe.", { cause: error });
      throw new HttpError(400, "The audio file could not be decoded safely.", { cause: error });
    }
    const normalized = await probe(normalizedTemporary, "wav");
    if (normalized.codec !== "pcm_s16le" || normalized.sampleRate !== 8_000 || normalized.channels !== 1 || normalized.bits !== 16) throw new Error("Audio conversion did not produce the required 8 kHz mono 16-bit WAV.");
    await rename(file.path, originalDestination);
    originalMoved = true;
    await rename(normalizedTemporary, normalizedDestination);
    normalizedMoved = true;
    const originalUrl = uploadedClipAssetUrl(file.filename);
    return { assetUrl: originalUrl, previewUrl: originalUrl, telephonyAssetUrl: uploadedClipAssetUrl(normalizedName), originalFilename: file.originalname, format, durationSeconds: Math.max(1, Math.round(normalized.duration)) };
  } catch (error) {
    if (originalMoved) await rm(originalDestination, { force: true });
    if (normalizedMoved) await rm(normalizedDestination, { force: true });
    throw error;
  } finally {
    activeConversions -= 1;
    await Promise.all([rm(file.path, { force: true }), rm(normalizedTemporary, { force: true })]);
  }
}

export async function discardTemporaryUpload(file?: Express.Multer.File) {
  if (file) await rm(file.path, { force: true });
}

export async function removeClipFiles(clip: Clip) {
  const names = new Set([clip.assetUrl, clip.previewUrl, clip.telephonyAssetUrl].flatMap((url) => {
    if (!url || !url.startsWith("/media/clips/")) return [];
    const filename = url.slice("/media/clips/".length);
    if (!/^[a-f0-9-]+\.(wav|mp3)$/i.test(filename)) throw new Error("Stored clip path is invalid; media cleanup stopped.");
    return [filename];
  }));
  const results = await Promise.allSettled([...names].map((filename) => rm(path.join(config.clipStorageDir, filename), { force: true })));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    logger.error({ clipId: clip.id, errors: failed.map((result) => result.reason) }, "Clip metadata removed but media cleanup failed");
    throw new Error("Clip media cleanup failed after removing its metadata.");
  }
}
