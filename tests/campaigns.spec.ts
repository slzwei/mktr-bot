import { expect, test } from "@playwright/test";
import { authenticatedHeaders } from "./api-headers";

test("three simulated contacts complete a campaign with recorded outcomes and durable membership", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByLabel("CSV contacts").fill('name,phone\n"Campaign Alex",91234010\nCampaign Bea,+65 8123 4011\nCampaign Chen,6591234012');
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Imported 3 contacts");
  await page.getByLabel("Campaign name", { exact: true }).fill("Three simulated contacts");
  await expect(page.getByLabel("Start time", { exact: true })).toHaveValue("09:00");
  await expect(page.getByLabel("End time", { exact: true })).toHaveValue("20:00");
  await expect(page.getByLabel("Sun", { exact: true })).not.toBeChecked();
  // This isolated simulator fixture deliberately spans every hour/day so CI never dials outside its configured window.
  await page.getByLabel("Sun", { exact: true }).check();
  await page.getByLabel("Start time", { exact: true }).fill("00:00");
  await page.getByLabel("End time", { exact: true }).fill("24:00");
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("draft");
  await expect(page.getByTestId("campaign-contact-row")).toHaveCount(3);
  for (const phone of ["+6591234010", "+6581234011", "+6591234012"]) {
    const evidence = await page.request.post("/api/compliance/consent", { headers: await authenticatedHeaders(page), data: { phone, source: "Isolated simulator browser fixture", consentedAt: new Date(Date.now() - 1000).toISOString(), purpose: "voice_marketing" } });
    expect(evidence.status()).toBe(201);
  }
  await page.getByRole("button", { name: "Start campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("running");
  await page.getByRole("button", { name: "Pause campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("paused");
  await page.getByRole("button", { name: "Start campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("completed", { timeout: 20_000 });
  await expect(page.getByTestId("campaign-progress")).toContainText("3 completed");
  await expect(page.getByTestId("campaign-progress")).toContainText("0 skipped");
  for (const row of await page.getByTestId("campaign-contact-row").all()) {
    await expect(row).toContainText("completed"); await expect(row).toContainText("interested");
  }
  const headers = await authenticatedHeaders(page);
  const campaigns = await (await page.request.get("/api/campaigns", { headers })).json();
  const campaign = campaigns.find((item: { name: string }) => item.name === "Three simulated contacts");
  expect(campaign.flowVersion).toBe(3);
  expect(campaign.contacts.map((entry: { contact: { phone: string } }) => entry.contact.phone)).toEqual(["+6591234010", "+6581234011", "+6591234012"]);
  for (const entry of campaign.contacts) {
    expect(entry.attempts).toBe(1);
    const call = await (await page.request.get(`/api/calls/${entry.lastCallId}`, { headers })).json();
    expect(call.status).toBe("ended"); expect(call.flowVersion).toBe(campaign.flowVersion);
  }
  await page.reload();
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("completed");
  await expect(page.getByRole("button", { name: "Start campaign", exact: true })).toBeDisabled();
});

test("campaign stop prevents pending contacts from being dialed and exposes their reason", async ({ page }) => {
  await page.goto("/");
  const headers = await authenticatedHeaders(page);
  const imported = await page.request.post("/api/contacts/import", { headers, data: { csv: "name,phone\nStopped contact,91234019" } });
  expect(imported.status()).toBe(201);
  const contact = (await imported.json()).contacts[0];
  const created = await page.request.post("/api/campaigns", { headers, data: { name: "Stopped before dialing", flowId: "flow-prospect-intake", callerId: "+6562773211", contactIds: [contact.id] } });
  expect(created.status()).toBe(201);
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption((await created.json()).id);
  await page.getByRole("button", { name: "Stop campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("stopped");
  await expect(page.getByTestId("campaign-contact-row")).toContainText("Campaign stopped by operator");
  await expect(page.getByTestId("campaign-progress")).toContainText("1 skipped");
});

test("simulator skips a contact without consent and shows why", async ({ page }) => {
  await page.goto("/");
  const headers = await authenticatedHeaders(page);
  const imported = await page.request.post("/api/contacts/import", { headers, data: { csv: "name,phone\nNo consent fixture,91234028" } });
  expect(imported.status()).toBe(201);
  const contact = (await imported.json()).contacts[0];
  const created = await page.request.post("/api/campaigns", { headers, data: { name: "Consent blocked simulator", flowId: "flow-prospect-intake", callerId: "+6562773211", contactIds: [contact.id], callingHours: { days: [0,1,2,3,4,5,6], start: "00:00", end: "24:00", timeZone: "Asia/Singapore" } } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id;
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption(id);
  await page.getByRole("button", { name: "Start campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-status")).toHaveText("completed");
  const row = page.getByTestId("campaign-contact-row");
  await expect(row).toContainText("skipped");
  await expect(row).toContainText("No recorded voice consent or fresh DNC clearance.");
  const detail = await (await page.request.get(`/api/campaigns/${id}`, { headers })).json();
  expect(detail.contacts[0].attempts).toBe(0);
  expect(detail.contacts[0].lastCallId).toBeUndefined();
});

test("operator records explicit voice evidence and withdrawal in the permission panel", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page.getByLabel("Permission phone number").fill("+6591234038");
  await page.getByRole("button", { name: "Check permission", exact: true }).click();
  await expect(page.getByText("Skip reason: No recorded voice consent or fresh DNC clearance.", { exact: true })).toBeVisible();
  await page.getByLabel("Evidence source", { exact: true }).fill("Simulator-only written consent fixture");
  await page.getByLabel("Evidence reference", { exact: true }).fill("test-fixture-consent-038");
  await page.getByLabel("Consent date and time (Singapore)").fill("2026-09-01T09:00");
  await page.getByRole("button", { name: "Save voice consent", exact: true }).click();
  await expect(page.getByText("Permission basis: recorded voice marketing consent.", { exact: true })).toBeVisible();
  await page.getByLabel("Evidence type").selectOption("opt-out");
  await page.getByLabel("Evidence source", { exact: true }).fill("Simulator-only withdrawal fixture");
  await page.getByLabel("Evidence reference", { exact: true }).fill("test-fixture-optout-038");
  await page.getByRole("button", { name: "Record opt-out", exact: true }).click();
  await expect(page.getByText("Skip reason: Contact opted out of marketing voice calls.", { exact: true })).toBeVisible();
});
