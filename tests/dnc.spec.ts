import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { expect, test as base } from "@playwright/test";
import { createApp } from "../server/app";
import { hashPassword, InMemoryAuthStore } from "../server/auth";
import { RuleClassifier } from "../server/classifier";
import { CallOrchestrator } from "../server/orchestrator";
import { InMemoryStore } from "../server/store";
import { SimulatedTelephonyAdapter } from "../server/telephony";
import { FakeDncGateway, successfulDncReply } from "../server/test-support/fake-dnc";

// Exercise the built UI and real HTTP routes on an isolated simulator, with only a fake gateway.
const test = base.extend<{ registry: { gateway: FakeDncGateway; store: InMemoryStore } }>({
  registry: async ({ page }, use) => {
    const gateway = await new FakeDncGateway().start();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = new InMemoryStore(), authStore = new InMemoryAuthStore();
    const password = randomBytes(32).toString("hex");
    await authStore.saveUser({ id: randomUUID(), email: "registry-browser@example.test", passwordHash: await hashPassword(password), role: "operator" });
    const adapter = new SimulatedTelephonyAdapter(), classifier = new RuleClassifier();
    const calls = new CallOrchestrator(store, adapter, classifier);
    const { app, closeSseStreams } = createApp({ store, authStore, adapter, classifier, calls, dnc: gateway.config(), webOrigin: origin, logger: pino({ level: "silent" }) });
    server.on("request", app);
    try {
      await page.context().clearCookies();
      await page.goto(origin);
      await page.getByLabel("Email", { exact: true }).fill("registry-browser@example.test");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Campaigns", exact: true }).click();
      await use({ gateway, store });
    } finally {
      closeSseStreams(); await calls.shutdown(); await gateway.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("CSV preview shows credits before any spending, then reports results and a selectable register state", async ({ page, registry }, testInfo) => {
  registry.gateway.respond = (body, response) => {
    const reply = successfulDncReply(body.numbers);
    reply.data.results.find((entry) => entry.number === "91234902")!.noVoiceCall = true;
    response.end(JSON.stringify(reply));
  };
  const individualPermissionReads: string[] = [];
  page.on("request", (request) => { if (/\/api\/compliance\/%2B/i.test(request.url())) individualPermissionReads.push(request.url()); });
  await page.getByLabel("CSV contacts").fill("name,phone\nVoice clear,91234901\nRegistered fixture,91234902\nDuplicate,+65 9123 4901\nConsent needed,+64212345678");
  await expect(page.getByTestId("import-preview")).toContainText("3 contacts will be imported; 1 duplicate ignored");
  await expect(page.getByTestId("import-preview")).toContainText("This will spend 2 credits.");
  const button = page.getByRole("button", { name: "Import 3 contacts and check Registry · 2 credits", exact: true });
  await expect(button).toBeEnabled();
  expect(registry.gateway.requests).toHaveLength(0); expect(registry.store.listContacts()).toHaveLength(0);
  await page.locator(".campaign-setup > section").first().screenshot({ path: testInfo.outputPath("credit-preview.png") });
  await button.click();
  await expect(page.getByRole("status")).toContainText("Imported 3 contacts; 1 duplicate ignored. 2 numbers checked; 1 clear; 1 on the No Voice Call Register; 0 already covered; 1 non-Singapore number skipped.");
  expect(registry.gateway.requests).toHaveLength(1); expect(registry.gateway.requests[0].signatureValid).toBe(true);
  const registered = page.getByTestId("contact-permission-row").filter({ hasText: "Registered fixture" });
  await expect(registered).toContainText("On the No Voice Call Register");
  await expect(registered).toHaveClass(/contact-permission--blocked/);
  await registered.getByRole("checkbox").uncheck(); await registered.getByRole("checkbox").check();
  await expect(registered.getByRole("checkbox")).toBeChecked();
  await expect(page.getByTestId("contact-permission-row").filter({ hasText: "Voice clear" })).toContainText("Dialable");
  await expect(page.getByTestId("contact-permission-row").filter({ hasText: "Consent needed" })).toContainText("No permission");
  await page.locator(".campaign-contacts").screenshot({ path: testInfo.outputPath("contact-permissions.png") });
  expect(individualPermissionReads).toHaveLength(0);
  await page.getByLabel("Campaign name", { exact: true }).fill("Registry permission review");
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page.getByTestId("campaign-compliance")).toContainText("3 total contacts; 1 dialable; 2 blocked");
  await expect(page.getByTestId("campaign-compliance")).toContainText("Number is listed on the No Voice Call Register.");
});

test("file selection previews for free, editing invalidates the price, and gateway failure retains blocked contacts", async ({ page, registry }) => {
  await page.getByLabel("CSV file", { exact: true }).setInputFiles({ name: "contacts.csv", mimeType: "text/csv", buffer: Buffer.from("phone\n91234903") });
  await expect(page.getByTestId("import-preview")).toContainText("This will spend 1 credit.");
  expect(registry.gateway.requests).toHaveLength(0);
  await page.getByLabel("CSV contacts").fill("phone\n91234903\n91234904");
  await expect(page.getByRole("button", { name: "Import 2 contacts and check Registry · 2 credits", exact: true })).toBeEnabled();
  await expect(page.getByTestId("import-preview")).toContainText("This will spend 2 credits.");
  expect(registry.gateway.requests).toHaveLength(0);
  await registry.gateway.close();
  await page.getByRole("button", { name: "Import 2 contacts and check Registry · 2 credits", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Imported 2 contacts");
  await expect(page.getByRole("status")).toContainText("gateway_unreachable");
  await expect(page.getByRole("status")).toContainText("Numbers not checked cannot be dialled until a successful check or valid recorded consent permits them.");
  await expect(page.getByTestId("contact-permission-row")).toHaveCount(2);
  for (const row of await page.getByTestId("contact-permission-row").all()) await expect(row).toContainText("No permission");
  expect(registry.store.getDncClearance("+6591234903")).toBeUndefined();
});

test("the single-number action states one credit, records the result, skips fresh evidence, and preserves manual paths", async ({ page, registry }) => {
  await page.getByLabel("Permission phone number").fill("+6591234905");
  const button = page.getByRole("button", { name: "Check Registry · 1 credit", exact: true });
  await expect(button).toBeEnabled();
  expect(registry.gateway.requests).toHaveLength(0);
  await button.click();
  await expect(page.getByText("Permission basis: current DNC Registry clearance.", { exact: true })).toBeVisible();
  expect(registry.gateway.requests).toHaveLength(1);
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "0 numbers checked" })).toContainText("1 already covered");
  expect(registry.gateway.requests).toHaveLength(1);
  await page.getByLabel("Evidence type").selectOption("dnc");
  await expect(page.getByRole("button", { name: "Save DNC result", exact: true })).toBeVisible();
  await expect(page.getByLabel("Evidence reference", { exact: true })).toBeVisible();
  await page.getByLabel("Evidence type").selectOption("opt-out");
  await page.getByLabel("Evidence source", { exact: true }).fill("Browser fixture withdrawal");
  await page.getByLabel("Evidence reference", { exact: true }).fill("Fake request reference");
  await page.getByRole("button", { name: "Record opt-out", exact: true }).click();
  await expect(page.getByText("Skip reason: Contact opted out of marketing voice calls.", { exact: true })).toBeVisible();
  expect(registry.gateway.requests).toHaveLength(1);
});

test("a clearance expiring within three days shows its Singapore date before campaign selection", async ({ page, registry }) => {
  const phone = "+6591234906", checkedAt = new Date(Date.now() - 19 * 86400000).toISOString();
  registry.store.saveDncClearance({ id: randomUUID(), phone, checkedAt, recordedAt: new Date().toISOString(), cleared: true, source: "Singapore DNC Registry", reference: "Isolated expiry fixture" });
  await page.getByLabel("CSV contacts").fill(`name,phone\nExpiring fixture,${phone}`);
  await expect(page.getByTestId("import-preview")).toContainText("1 already covered");
  await page.getByRole("button", { name: "Import 1 contact and check Registry · 0 credits", exact: true }).click();
  const row = page.getByTestId("contact-permission-row").filter({ hasText: "Expiring fixture" });
  await expect(row).toHaveClass(/contact-permission--expiring/);
  await expect(row).toContainText("Dialable · clearance expiring");
  await expect(row).toContainText(new Date(Date.parse(checkedAt) + 21 * 86400000).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }));
  expect(registry.gateway.requests).toHaveLength(0);
});
