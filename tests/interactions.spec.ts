import { expect, test, type Locator, type Page } from "@playwright/test";
import { authenticatedHeaders } from "./api-headers";

function wavFile() {
  const rate = 8_000;
  const samples = rate * 3;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2_000), 44 + i * 2);
  return buffer;
}

async function openLibrary(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Audio clips", exact: true }).click();
}

async function dropFiles(page: Page, files: { name: string; type: string; bytes: number[] }[]) {
  const transfer = await page.evaluateHandle((items) => {
    const data = new DataTransfer();
    for (const file of items) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    return data;
  }, files);
  try {
    await page.locator(".library-upload").dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(page.locator(".library-view")).toHaveClass(/is-dragging-file/);
    await page.locator(".library-upload").dispatchEvent("dragover", { dataTransfer: transfer });
    await page.locator(".library-upload").dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.locator(".library-view")).not.toHaveClass(/is-dragging-file/);
  } finally {
    await transfer.dispose();
  }
}

async function playAudio(audio: Locator) {
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  // Use the actual native play control so playback has a user gesture.
  await audio.click({ position: { x: 18, y: 17 } });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0.05);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.error?.message ?? null)).toBeNull();
}

async function visibleNodeIds(page: Page) {
  return page.locator(".react-flow__node").evaluateAll((nodes) => nodes
    .filter((node) => getComputedStyle(node).visibility === "visible" && node.getBoundingClientRect().width > 0)
    .map((node) => node.getAttribute("data-id"))
    .sort());
}

test("all nodes and connections stay visible throughout an existing node drag", async ({ page }) => {
  await page.goto("/");
  const nodes = page.locator(".react-flow__node");
  const connections = page.locator(".react-flow__edge-path");
  await expect(nodes).toHaveCount(12);
  await expect(connections).toHaveCount(11);
  const nodeIds = await nodes.evaluateAll((elements) => elements.map((node) => node.getAttribute("data-id")).sort());
  await expect.poll(() => visibleNodeIds(page)).toEqual(nodeIds);
  const node = nodes.filter({ hasText: "Opening greeting" });
  const bounds = (await node.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 15);
  await page.mouse.down();
  try {
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(bounds.x + 30 + step * 8, bounds.y + 15 + step * 6);
      expect(await visibleNodeIds(page)).toEqual(nodeIds);
      await expect(connections).toHaveCount(11);
    }
  } finally {
    await page.mouse.up();
  }
  expect(await visibleNodeIds(page)).toEqual(nodeIds);
  expect((await node.boundingBox())!.x).toBeGreaterThan(bounds.x + 40);
  const stationary = nodes.filter({ hasText: "Listen for reply" });
  await stationary.click();
  await expect(page.locator(".inspector").getByLabel("Name", { exact: true })).toHaveValue("Listen for reply");
  expect(await visibleNodeIds(page)).toEqual(nodeIds);
});

test("palette drops land under the pointer, move, and save their position", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".version-tag")).toContainText("Published");
  await page.getByRole("button", { name: "New flow", exact: true }).click();
  const nodeCount = await page.locator(".react-flow__node").count();
  const canvas = page.locator(".react-flow__pane");
  const canvasBounds = (await canvas.boundingBox())!;
  await page.getByTitle("Add Play clip node", { exact: true }).dragTo(canvas, { targetPosition: { x: 250, y: 160 } });
  await expect(page.locator(".react-flow__node")).toHaveCount(nodeCount + 1);
  await expect.poll(async () => (await visibleNodeIds(page)).length).toBe(nodeCount + 1);
  const node = page.locator(".react-flow__node").filter({ hasText: "New clip" });
  const before = (await node.boundingBox())!;
  expect(Math.abs(before.x - (canvasBounds.x + 250))).toBeLessThan(3);
  expect(Math.abs(before.y - (canvasBounds.y + 160))).toBeLessThan(3);
  await page.mouse.move(before.x + 20, before.y + 15);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y + 85, { steps: 20 });
  await page.mouse.up();
  // React Flow starts moving after its drag threshold, consuming the first small mouse step.
  await expect.poll(async () => Math.abs((await node.boundingBox())!.x - before.x - 100)).toBeLessThan(8);
  await expect.poll(async () => Math.abs((await node.boundingBox())!.y - before.y - 70)).toBeLessThan(8);
  const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/api/flows/"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const flow = await (await saved).json();
  const persisted = flow.nodes.find((item: { data: { label: string } }) => item.data.label === "New clip");
  await page.reload();
  await page.locator(".flow-switcher select").selectOption(flow.id);
  await expect(page.locator(".react-flow__node").filter({ hasText: "New clip" })).toHaveCount(1);
  await expect.poll(async () => (await visibleNodeIds(page)).length).toBe(nodeCount + 1);
  const response = await page.request.get(`/api/flows/${flow.id}`, { headers: await authenticatedHeaders(page) });
  expect((await response.json()).nodes.find((item: { id: string }) => item.id === persisted.id).position).toEqual(persisted.position);
});

test("clicking a palette item adds a visible node after panning and zooming", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  const canvas = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(canvas.x + 250, canvas.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 380, canvas.y + 100, { steps: 10 });
  await page.mouse.up();
  await page.getByTitle("Add Play clip node", { exact: true }).click();
  const node = (await page.locator(".react-flow__node").filter({ hasText: "New clip" }).boundingBox())!;
  expect(node.x).toBeGreaterThanOrEqual(canvas.x);
  expect(node.y).toBeGreaterThanOrEqual(canvas.y);
  expect(node.x + node.width).toBeLessThanOrEqual(canvas.x + canvas.width);
  expect(node.y + node.height).toBeLessThanOrEqual(canvas.y + canvas.height);
});

test("a dropped WAV uploads and plays through the web server with range support", async ({ page }) => {
  await openLibrary(page);
  await dropFiles(page, [{ name: "Dropped greeting.wav", type: "audio/wav", bytes: [...wavFile()] }]);
  await expect(page.getByLabel("Clip name", { exact: true })).toHaveValue("Dropped greeting");
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("3");
  await page.getByRole("button", { name: "Upload clip", exact: true }).click();
  const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: "Dropped greeting", exact: true }) });
  const audio = card.locator("audio");
  await playAudio(audio);
  const source = (await audio.getAttribute("src"))!;
  const response = await page.request.get(source, { headers: await authenticatedHeaders(page, { Range: "bytes=0-31" }) });
  expect(response.status()).toBe(206);
  expect(response.headers()["content-type"]).toContain("audio/wav");
  expect(response.headers()["content-range"]).toBe(`bytes 0-31/${wavFile().length}`);
  expect((await response.body()).subarray(0, 4).toString()).toBe("RIFF");
  await expect(page.getByRole("button", { name: "Upload clip", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Clip name", { exact: true })).toHaveValue("");
});

test("file chooser accepts a WAV without a browser MIME type and can select it again", async ({ page }) => {
  await openLibrary(page);
  const file = { name: "Chooser greeting.wav", mimeType: "", buffer: wavFile() };
  await page.getByLabel("Choose audio file", { exact: true }).setInputFiles(file);
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("3");
  await page.getByRole("button", { name: "Upload clip", exact: true }).click();
  const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: "Chooser greeting", exact: true }) });
  await playAudio(card.locator("audio"));
  await page.getByLabel("Choose audio file", { exact: true }).setInputFiles(file);
  await expect(page.getByRole("button", { name: "Upload clip", exact: true })).toBeEnabled();
});

test("an MP3 selected from the file chooser uploads and plays", async ({ page }) => {
  await openLibrary(page);
  await page.getByLabel("Choose audio file", { exact: true }).setInputFiles("tests/fixtures/tone.mp3");
  await page.getByLabel("Clip name", { exact: true }).fill("MP3 voice preview");
  await expect(page.getByLabel("Duration (seconds)")).toHaveValue("3");
  await page.getByRole("button", { name: "Upload clip", exact: true }).click();
  const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: "MP3 voice preview", exact: true }) });
  await playAudio(card.locator("audio"));
  const response = await page.request.get((await card.locator("audio").getAttribute("src"))!, { headers: await authenticatedHeaders(page) });
  expect(response.headers()["content-type"]).toContain("audio/mpeg");
});

test("file drops reject unsupported and multiple files without navigating away", async ({ page }) => {
  await openLibrary(page);
  await dropFiles(page, [{ name: "notes.txt", type: "text/plain", bytes: [65] }]);
  await expect(page.getByRole("alert")).toHaveText("Only WAV and MP3 audio clips are supported.");
  await expect(page.getByRole("button", { name: "Upload clip", exact: true })).toBeDisabled();
  await dropFiles(page, ["one.wav", "two.wav"].map((name) => ({ name, type: "audio/wav", bytes: [65] })));
  await expect(page.getByRole("alert")).toHaveText("Drop one audio file at a time.");
  await expect(page.getByRole("heading", { name: "Approved voice clips" })).toBeVisible();
});

test("all built-in voice previews decode and only one plays at a time", async ({ page }) => {
  await openLibrary(page);
  const samples = page.locator(".clip-card").filter({ has: page.getByText("Sample", { exact: true }) });
  await expect(samples).toHaveCount(5);
  for (const audio of await samples.locator("audio").all()) {
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    expect(await audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(0);
  }
  await playAudio(samples.nth(0).locator("audio"));
  await playAudio(samples.nth(1).locator("audio"));
  await expect.poll(() => samples.nth(0).locator("audio").evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
});

test("a selected flow clip can be previewed without changing its published status", async ({ page }) => {
  await page.goto("/");
  await page.locator(".react-flow__node").filter({ hasText: "Opening greeting" }).click();
  await playAudio(page.locator(".inspector audio"));
  await expect(page.locator(".version-tag")).toContainText("Published");
});

test("a failed audio request shows a useful playback error", async ({ page }) => {
  await page.route("**/demo-clips/welcome.wav", (route) => route.abort());
  await openLibrary(page);
  const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: "Opening greeting", exact: true }) });
  await expect(card.getByRole("alert")).toContainText("This clip could not be played");
});
