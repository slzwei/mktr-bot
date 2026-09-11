import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { authenticatedHeaders } from "./api-headers";

test("campaign CSV download contains exactly one row for each simulated call and excludes other campaigns", async ({ page }) => {
  await page.goto("/");
  const headers = await authenticatedHeaders(page);
  const imported = await page.request.post("/api/contacts/import", { headers, data: { csv: "name,phone\nExport Alex,91234201\nExport Bea,81234202" } });
  expect(imported.status()).toBe(201);
  const contacts = (await imported.json()).contacts;
  for (const contact of contacts) {
    expect((await page.request.post("/api/compliance/consent", { headers, data: { phone: contact.phone, source: "Isolated simulator CSV fixture", purpose: "voice_marketing", consentedAt: new Date(Date.now() - 1000).toISOString() } })).status()).toBe(201);
  }
  const draftResponse = await page.request.post("/api/flows", { headers, data: { name: "Export fixture flow" } });
  const draft = await draftResponse.json();
  const flow = { ...draft, nodes: [{ id: "start", type: "start", data: { label: "Start" }, position: { x: 0, y: 0 } }, { id: "end", type: "end", data: { label: "End" }, position: { x: 200, y: 0 } }], edges: [{ id: "start-end", source: "start", target: "end" }], startNodeId: "start" };
  expect((await page.request.put(`/api/flows/${draft.id}`, { headers, data: flow })).ok()).toBe(true);
  expect((await page.request.post(`/api/flows/${draft.id}/publish`, { headers, data: {} })).ok()).toBe(true);
  const created = await page.request.post("/api/campaigns", { headers, data: { name: "CSV export fixture", flowId: draft.id, callerId: "+6562773211", contactIds: contacts.map((contact: { id: string }) => contact.id), callingHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00", timeZone: "Asia/Singapore" } } });
  expect(created.status()).toBe(201);
  const campaign = await created.json();
  expect((await page.request.post(`/api/campaigns/${campaign.id}/start`, { headers, data: {} })).ok()).toBe(true);
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption(campaign.id);
  await expect(page.getByTestId("campaign-status")).toHaveText("completed", { timeout: 15_000 });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export campaign CSV", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`campaign-${campaign.id}.csv`);
  const csv = await readFile((await download.path())!, "utf8");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines).toHaveLength(3);
  const detail = await (await page.request.get(`/api/campaigns/${campaign.id}`, { headers })).json();
  const expectedIds = detail.contacts.map((entry: { lastCallId: string }) => entry.lastCallId).sort();
  const exportedIds = lines.slice(1).map((line) => line.split(",")[0].replaceAll('"', "")).sort();
  expect(exportedIds).toEqual(expectedIds);
  for (const line of lines.slice(1)) { expect(line).toContain(`"${campaign.id}"`); expect(line).toContain('"completed"'); }
  await page.getByRole("button", { name: "Call history", exact: true }).click();
  for (const contact of contacts) await expect(page.locator(".history-row").filter({ hasText: contact.phone })).toBeVisible();
});
