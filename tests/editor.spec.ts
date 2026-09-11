import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CALLER_IDS, type BootstrapData, type CallSession, type Clip, type FlowDefinition } from "../src/lib/domain";
import { authenticatedHeaders } from "./api-headers";

test("new flow starts with Start to End and deletion retains its published version", async ({ page }) => {
  await page.goto("/");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/flows"));
  await page.getByRole("button", { name: "New flow", exact: true }).click();
  const flow = await (await created).json() as FlowDefinition;
  await expect(page.getByLabel("Current flow")).toHaveValue(flow.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge-path")).toHaveCount(1);
  expect(flow.nodes.map((node) => node.type)).toEqual(["start", "end"]);
  expect(flow.nodes.every((node) => node.data.clipId === undefined)).toBe(true);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".version-tag")).toContainText("Published v1");
  const removed = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/api/flows/${flow.id}`));
  await page.getByRole("button", { name: "Delete flow", exact: true }).click();
  expect((await removed).status()).toBe(200);
  await expect(page.getByLabel("Current flow")).not.toHaveValue(flow.id);
  const headers = await authenticatedHeaders(page);
  expect((await page.request.get(`/api/flows/${flow.id}`, { headers })).status()).toBe(404);
  expect((await page.request.get(`/api/flows/${flow.id}/versions/1`, { headers })).status()).toBe(200);
});

test("retry inspector saves its attempt counter and restores it after reload", async ({ page }) => {
  await page.goto("/");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/flows"));
  await page.getByRole("button", { name: "New flow", exact: true }).click();
  const flow = await (await created).json() as FlowDefinition;
  try {
    await expect(page.getByLabel("Current flow")).toHaveValue(flow.id);
    await page.getByTitle("Add Retry node", { exact: true }).click();
    const counter = page.getByRole("spinbutton", { name: "Maximum attempts", exact: false });
    await expect(counter).toHaveValue("1");
    await counter.fill("3");
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/api/flows/${flow.id}`));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const snapshot = await (await saved).json() as FlowDefinition;
    expect(snapshot.nodes.find((node) => node.type === "retry")?.data.maxAttempts).toBe(3);
    await page.reload();
    await page.getByLabel("Current flow").selectOption(flow.id);
    await page.locator(".react-flow__node").filter({ hasText: "Clarify once" }).click();
    await expect(counter).toHaveValue("3");
  } finally { await page.request.delete(`/api/flows/${flow.id}`, { headers: await authenticatedHeaders(page) }); }
});

test("Event logs, read-only Settings and authenticated runbook Help render", async ({ page }, testInfo) => {
  const headers = await authenticatedHeaders(page);
  const created = await page.request.post("/api/flows", { headers, data: { name: "Event log fixture" } });
  const flow = await created.json() as FlowDefinition;
  try {
    expect((await page.request.post(`/api/flows/${flow.id}/publish`, { headers })).status()).toBe(200);
    expect((await page.request.post("/api/compliance/consent", { headers, data: { phone: "+6591234567", source: "Isolated simulator event-log fixture", consentedAt: new Date(Date.now() - 1000).toISOString(), purpose: "voice_marketing" } })).status()).toBe(201);
    const started = await page.request.post("/api/calls", { headers, data: { flowId: flow.id, destination: "+6591234567", callerId: CALLER_IDS[0] } });
    expect(started.status()).toBe(201);
    const call = await started.json() as CallSession;
    expect((await page.request.post(`/api/calls/${call.id}/end`, { headers })).status()).toBe(200);
    await page.goto("/");
    await page.getByRole("button", { name: "Event logs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Event logs", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Call", exact: true }).selectOption(call.id);
    const log = page.getByRole("region", { name: "Call event log", exact: true });
    await expect(log.getByText("Call queued", { exact: true })).toBeVisible();
    await expect(log.getByText("Call ended", { exact: true })).toBeVisible();
    await expect(log.getByText(call.id, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("event-logs.png"), fullPage: true });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator(".settings-values").getByText("Simulator", { exact: true })).toBeVisible();
    await expect(page.locator(".settings-values").getByText("Rules", { exact: true })).toBeVisible();
    await expect(page.locator(".system-view input, .system-view select, .system-view textarea")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("settings.png"), fullPage: true });

    await page.getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Help", exact: true })).toBeVisible();
    const runbookLink = page.getByRole("link", { name: "Open first-call runbook" });
    await expect(runbookLink).toHaveAttribute("href", "/api/help/runbook");
    const runbook = await page.request.get((await runbookLink.getAttribute("href"))!, { headers });
    expect(runbook.status()).toBe(200);
    expect(runbook.headers()["content-type"]).toContain("text/plain");
    expect(await runbook.text()).toContain("Shawn");
  } finally { await page.request.delete(`/api/flows/${flow.id}`, { headers }); }
});

test("clip removal deletes unused media and archives media retained by a published flow", async ({ page }) => {
  const headers = await authenticatedHeaders(page);
  const upload = async (name: string) => {
    const response = await page.request.post("/api/clips/upload", { headers, multipart: { name, durationSeconds: "3", file: { name: "greeting.wav", mimeType: "audio/wav", buffer: readFileSync("public/demo-clips/welcome.wav") } } });
    expect(response.status()).toBe(201);
    return await response.json() as Clip;
  };
  const unused = await upload("Unused editor clip");
  const archived = await upload("Historical editor clip");
  const created = await page.request.post("/api/flows", { headers, data: { name: "Archive media fixture" } });
  const flow = await created.json() as FlowDefinition;
  flow.nodes.push({ id: "greeting", type: "playClip", position: { x: 240, y: 160 }, data: { label: "Greeting", clipId: archived.id } });
  flow.edges = [{ id: "intro", source: "start", target: "greeting" }, { id: "finish", source: "greeting", target: "end" }];
  try {
    expect((await page.request.put(`/api/flows/${flow.id}`, { headers, data: flow })).status()).toBe(200);
    expect((await page.request.post(`/api/flows/${flow.id}/publish`, { headers })).status()).toBe(200);
    await page.goto("/");
    await page.getByRole("button", { name: "Audio clips", exact: true }).click();
    await page.getByRole("button", { name: `Remove ${unused.name}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: unused.name, exact: true })).toHaveCount(0);
    expect((await page.request.get(unused.telephonyAssetUrl!, { headers })).status()).toBe(404);
    await page.getByRole("button", { name: `Remove ${archived.name}`, exact: true }).click();
    const card = page.locator(".clip-card").filter({ has: page.getByRole("heading", { name: archived.name, exact: true }) });
    await expect(card.getByText("Archived", { exact: true })).toBeVisible();
    expect((await page.request.get(archived.telephonyAssetUrl!, { headers })).status()).toBe(200);
  } finally { await page.request.delete(`/api/flows/${flow.id}`, { headers }); }
});

test("an empty flow workspace still allows navigation and creation", async ({ page }) => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const data = await response.json() as BootstrapData;
    await route.fulfill({ response, json: { ...data, flows: [] } });
  });
  await page.goto("/");
  await expect(page.getByText("No flows yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/flows"));
  await page.getByRole("button", { name: "New flow", exact: true }).click();
  const flow = await (await created).json() as FlowDefinition;
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.request.delete(`/api/flows/${flow.id}`, { headers: await authenticatedHeaders(page) });
});
