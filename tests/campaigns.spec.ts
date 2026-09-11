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
