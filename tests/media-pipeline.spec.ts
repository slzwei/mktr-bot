import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { authenticatedHeaders } from "./api-headers";

let scratch: string;
let source: string;
function probe(file: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels,bits_per_sample", "-of", "json", file], { encoding: "utf8" }));
}
test.beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "mktr-browser-audio-"));
  source = path.join(scratch, "stereo-44k.mp3");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", source]);
});
test.afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("44.1 kHz stereo MP3 upload keeps its preview and produces probed 8 kHz mono 16-bit WAV", async ({ page }) => {
  const originalProbe = probe(source);
  expect(originalProbe.streams[0].sample_rate).toBe("44100");
  expect(originalProbe.streams[0].channels).toBe(2);
  await page.goto("/");
  await page.getByRole("button", { name: "Audio clips", exact: true }).click();
  await page.getByLabel("Choose audio file", { exact: true }).setInputFiles(source);
  await page.getByLabel("Clip name", { exact: true }).fill("Normalized pipeline greeting");
  await expect.poll(async () => page.getByLabel("Duration (seconds)").inputValue()).not.toBe("8");
  await page.getByLabel("Duration (seconds)").fill("123");
  const pending = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/clips/upload"));
  await page.getByRole("button", { name: "Upload clip", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const clip = await response.json();
  expect(Math.abs(clip.durationSeconds - Number(originalProbe.format.duration))).toBeLessThan(1);
  expect(clip.telephonyAssetUrl).not.toBe(clip.previewUrl);
  const headers = await authenticatedHeaders(page);
  const normalized = await page.request.get(clip.telephonyAssetUrl, { headers });
  expect(normalized.status()).toBe(200);
  const normalizedFile = path.join(scratch, "normalized.wav");
  writeFileSync(normalizedFile, await normalized.body());
  const actual = probe(normalizedFile);
  expect(actual.streams[0]).toMatchObject({ codec_name: "pcm_s16le", sample_rate: "8000", channels: 1, bits_per_sample: 16 });
  expect(Math.abs(Number(actual.format.duration) - Number(originalProbe.format.duration))).toBeLessThan(1);
  const original = await page.request.get(clip.previewUrl, { headers });
  expect(original.headers()["content-type"]).toContain("audio/mpeg");
  expect(await original.body()).toEqual(readFileSync(source));
  const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: "Normalized pipeline greeting", exact: true }) });
  await expect(card.locator("audio")).toHaveAttribute("src", clip.previewUrl);
});

test("text bytes named WAV are rejected with 400", async ({ page }) => {
  const response = await page.request.post("/api/clips/upload", { headers: await authenticatedHeaders(page), multipart: { name: "Not audio", durationSeconds: "3", file: { name: "pretend.wav", mimeType: "audio/wav", buffer: Buffer.from("Text pretending to be a WAV") } } });
  expect(response.status()).toBe(400);
});

test("malformed flow PUT returns 400 and preserves the saved graph", async ({ page }) => {
  const headers = await authenticatedHeaders(page);
  const saved = await page.request.get("/api/flows/flow-prospect-intake", { headers });
  const flow = await saved.json();
  const response = await page.request.put(`/api/flows/${flow.id}`, { headers, data: { ...flow, nodes: [{ id: 123, type: "unknown", position: null, data: {} }] } });
  expect(response.status()).toBe(400);
  expect(await (await page.request.get(`/api/flows/${flow.id}`, { headers })).json()).toEqual(flow);
});
