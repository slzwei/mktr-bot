import { expect, test as base, type Page } from "@playwright/test";
import { operatorFixture, seedHistory, seedPermissions } from "./support/operator-fixture";

// Happy paths use the real API, summary policy and history projection. Routes below
// interrupt reads only, to exercise UI loading, failure and stale-response recovery.
const test = base.extend<{ operator: Awaited<ReturnType<typeof operatorFixture>> }>({
  operator: async ({ page }, use) => {
    const fixture = await operatorFixture();
    try {
      await page.context().clearCookies();
      await page.goto(fixture.origin);
      await page.getByLabel("Email", { exact: true }).fill(fixture.email);
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      await use(fixture);
    } finally { await fixture.close(); }
  }
});
test.use({ timezoneId: "America/Los_Angeles" });
const go = async (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
const noOverflow = async (page: Page) => expect(await page.evaluate(() => ({ page: document.documentElement.scrollWidth <= window.innerWidth, content: document.querySelector(".main-view")!.scrollWidth <= document.querySelector(".main-view")!.clientWidth }))).toEqual({ page: true, content: true });

test("500 permissions distinguish voice from text and fax, show evidence dates, and never turn missing verdicts into clearance", async ({ page, operator }, testInfo) => {
  const contacts = seedPermissions(operator.store);
  await go(page, "Contact permissions");
  const row = (name: string) => page.getByTestId("contact-permission-row").filter({ hasText: name });
  await expect(page.getByTestId("contact-permission-row")).toHaveCount(50);
  await expect(row("Aisha Tan")).toContainText("Dialable");
  await expect(row("Aisha Tan").getByTestId("voice-register")).toHaveText("Not registered");
  await expect(row("Aisha Tan").getByTestId("text-register")).toHaveText("TextRegistered");
  await expect(row("Aisha Tan").getByTestId("fax-register")).toHaveText("FaxRegistered");
  await expect(row("Benjamin Teo")).toContainText("Blocked · voice register");
  await expect(row("Benjamin Teo").getByTestId("voice-register")).toHaveText("Registered");
  await expect(row("Benjamin Teo")).not.toContainText("Dialable");
  for (const name of ["Chloe Ong", "Daniel Lim", "Evelyn Lee"]) {
    await expect(row(name).getByTestId("voice-register")).toHaveText("Unknown · no verdict");
    await expect(row(name).getByTestId("text-register")).toHaveText("TextUnknown");
    await expect(row(name).getByTestId("fax-register")).toHaveText("FaxUnknown");
  }
  await expect(row("Chloe Ong")).toContainText("Dialable");
  await expect(row("Chloe Ong")).toContainText("Recorded voice marketing consent");
  await expect(row("Daniel Lim")).toContainText("No permission");
  await expect(row("Evelyn Lee")).toContainText("Permission unverified");
  await expect(row("Evelyn Lee")).not.toContainText("Dialable");
  await expect(row("Farah Ahmad")).toContainText("Dialable · expiring");
  await expect(row("Grace Chen")).toContainText("DNC clearance expired");
  const checkedAt = operator.store.getDncClearance(contacts[0].phone)!.checkedAt;
  await expect(row("Aisha Tan")).toContainText(new Date(checkedAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }));
  await expect(row("Aisha Tan")).toContainText("PDPC-SEP-00001");
  await page.screenshot({ path: testInfo.outputPath("permissions-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("51–100 of 500 contacts");
  await page.getByLabel("Search contact permissions", { exact: true }).fill("PDPC-SEP-00006");
  await expect(page.getByTestId("contact-permission-row")).toHaveCount(1);
  await expect(row("Farah Ahmad")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("1–1 of 1 contacts");
  await page.getByRole("button", { name: "Clear search contact permissions" }).click();
  await page.getByRole("combobox", { name: "Permission", exact: true }).selectOption("unknown");
  await expect(page.getByTestId("contact-permission-row")).toHaveCount(1);
  await expect(row("Evelyn Lee")).toBeVisible();
  await page.getByRole("combobox", { name: "Permission", exact: true }).selectOption("all");
  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`permissions-${width}.png`), fullPage: true });
  }
});

test("call history pages beyond bootstrap, stops at a null cursor, and resets paging for every filter", async ({ page, operator }, testInfo) => {
  const { contacts, campaignId } = seedHistory(operator.store);
  const queries: URLSearchParams[] = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname === "/api/calls") queries.push(url.searchParams); });
  await go(page, "Call history");
  await expect(page.getByRole("heading", { name: "57 calls", exact: true })).toBeVisible();
  await expect(page.getByTestId("call-history-row")).toHaveCount(25);
  await page.screenshot({ path: testInfo.outputPath("history-desktop.png"), fullPage: true });
  const seen = await page.locator(".history-open").allTextContents();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("status")).toHaveText("26–50 of 57 calls");
  seen.push(...await page.locator(".history-open").allTextContents());
  expect(queries.at(-1)?.get("cursor")).toBeTruthy();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("call-history-row")).toHaveCount(7);
  seen.push(...await page.locator(".history-open").allTextContents());
  expect(new Set(seen).size).toBe(57);
  await expect(page.getByRole("status")).toHaveText("51–57 of 57 calls");
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByRole("status")).toHaveText("26–50 of 57 calls");
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption(campaignId);
  await expect(page.getByRole("status")).toHaveText("1–25 of 29 calls");
  expect(queries.at(-1)?.get("campaignId")).toBe(campaignId);
  expect(queries.at(-1)?.has("cursor")).toBe(false);
  await page.getByRole("combobox", { name: "Contact", exact: true }).selectOption(contacts[0].id);
  await expect(page.getByRole("status")).toHaveText("1–1 of 1 calls");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("ended");
  await page.getByRole("combobox", { name: "Outcome", exact: true }).selectOption("interested");
  await expect(page.getByTestId("call-history-row")).toHaveCount(1);
  await expect.poll(() => queries.at(-1)?.get("outcome")).toBe("interested");
  expect(queries.at(-1)?.get("status")).toBe("ended");
  expect(queries.at(-1)?.get("contactId")).toBe(contacts[0].id);
  await go(page, "Clear filters");
  await page.getByLabel("Search call history", { exact: true }).fill("aisha");
  await expect(page.getByTestId("call-history-row")).toHaveCount(1);
  await expect(page.getByTestId("call-history-row")).toContainText("Aisha Tan");
  await page.getByLabel("Search call history", { exact: true }).fill("no such contact");
  await expect(page.getByRole("heading", { name: "No matching calls" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  await expect(page.getByTestId("call-history-row")).toHaveCount(25);
  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`history-${width}.png`), fullPage: true });
  }
});

test("a past call opens a readable agent/caller transcript, retained recording and collapsed technical events", async ({ page, operator }, testInfo) => {
  const { records } = seedHistory(operator.store, 8);
  await go(page, "Call history");
  const open = page.getByRole("button", { name: "Open call to Aisha Tan", exact: true });
  await open.focus(); await page.keyboard.press("Enter");
  const detail = page.getByRole("complementary", { name: "Call details", exact: true });
  await expect(detail.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
  await expect(detail.getByTestId("transcript-agent")).toHaveCount(2);
  await expect(detail.getByTestId("transcript-caller")).toHaveCount(2);
  await expect(detail.locator(".transcript-turn-meta strong")).toHaveText(["Agent", "Caller", "Agent", "Caller"]);
  await expect(detail.getByTestId("transcript-agent").first()).toContainText("Hello, this is MKTR");
  await expect(detail.getByTestId("transcript-caller").last()).toContainText("after two");
  await expect(detail.getByTestId("transcript-caller").first()).toContainText("420 ms");
  await expect(detail.getByTestId("transcript-caller").last()).toContainText("0 ms");
  await expect(detail).toContainText("1:30");
  await expect(detail).toContainText("Recorded consent");
  await expect(detail).toContainText(`v${records[0].flowVersion}`);
  await expect(detail).toContainText("Interested");
  await expect(detail).toContainText("Flow completed");
  await expect(detail).toContainText(new Date(records[0].createdAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }));
  await expect(detail.getByRole("link", { name: "Download recording" })).toHaveAttribute("href", `/api/calls/${records[0].id}/recording`);
  await expect(detail.getByText("Live event timeline")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Start test call" })).toHaveCount(0);
  await expect(detail.locator(".event-log")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("conversation-desktop.png"), fullPage: true });
  await detail.locator("summary").click();
  await expect(detail.locator(".event-log")).toBeVisible();
  await expect(detail.locator(".event-log")).toContainText("Intent classified");
  await detail.locator("summary").click();
  await page.getByRole("button", { name: "Close call console" }).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(detail.getByTestId("transcript-agent")).toHaveCount(2);
  for (const width of [1024, 640, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await noOverflow(page);
    expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`conversation-${width}.png`) });
  }
});

test("unanswered and active calls have deliberate states, and the live console still ends a simulated session", async ({ page, operator }, testInfo) => {
  const { records } = seedHistory(operator.store, 8);
  const live = { ...records[2], status: "listening" as const, endedAt: undefined, outcome: undefined, endReason: undefined };
  operator.store.saveCall(live);
  await go(page, "Call history");
  await expect(page.getByTestId("call-history-row").filter({ hasText: "Chloe Ong" })).toContainText("In progress");
  await go(page, "Open call to Benjamin Teo");
  const past = page.getByRole("complementary", { name: "Call details", exact: true });
  await expect(past.getByRole("heading", { name: "No conversation" })).toBeVisible();
  await expect(past.getByRole("alert")).toHaveCount(0);
  await expect(past).toContainText("No recording available");
  await page.screenshot({ path: testInfo.outputPath("no-conversation.png"), fullPage: true });
  await go(page, "Close call console");
  await go(page, "Open call to Chloe Ong");
  const console = page.getByRole("complementary", { name: "Test call console" });
  await expect(console.getByRole("heading", { name: "Call in progress" })).toBeVisible();
  await expect(console.getByText("Live event timeline")).toBeVisible();
  await expect(console.getByRole("button", { name: "End", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("live-call.png"), fullPage: true });
  await console.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Call details" }).getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
  await expect(page.getByTestId("transcript-caller")).toHaveCount(2);
});

test("permissions and history provide recoverable errors, loading geometry and useful empty states", async ({ page, operator }, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/compliance/summary", async (route) => { await gate; await route.fulfill({ status: 503, json: { error: "Permission service is temporarily unavailable." } }); });
  await go(page, "Contact permissions");
  await expect(page.getByRole("status")).toHaveText("Loading contacts…");
  await expect(page.locator(".skeleton-row")).toHaveCount(7);
  await page.screenshot({ path: testInfo.outputPath("permissions-loading.png"), fullPage: true });
  release();
  await expect(page.getByRole("alert")).toContainText("Could not load contact permissions");
  await page.screenshot({ path: testInfo.outputPath("permissions-error.png"), fullPage: true });
  await page.unroute("**/api/compliance/summary"); await go(page, "Try again");
  await expect(page.getByRole("heading", { name: "No contacts yet" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("permissions-empty.png"), fullPage: true });
  await page.route(/\/api\/calls\?/, (route) => route.fulfill({ status: 503, json: { error: "History service is temporarily unavailable." } }));
  await go(page, "Call history");
  await expect(page.getByRole("alert")).toContainText("Could not load call history");
  await page.screenshot({ path: testInfo.outputPath("history-error.png"), fullPage: true });
  await page.unroute(/\/api\/calls\?/); await go(page, "Try again");
  await expect(page.getByRole("heading", { name: "No calls yet" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("history-empty.png"), fullPage: true });
  seedHistory(operator.store, 8);
  await go(page, "Refresh call history");
  await expect(page.getByTestId("call-history-row")).toHaveCount(8);
});

test("detail retries recover and a slow earlier selection cannot overwrite the current conversation", async ({ page, operator }, testInfo) => {
  const { records } = seedHistory(operator.store, 8);
  await go(page, "Call history");
  await page.route(`**/api/calls/${records[0].id}`, (route) => route.fulfill({ status: 503, json: { error: "The call could not be read." } }));
  await go(page, "Open call to Aisha Tan");
  await expect(page.getByRole("alert")).toContainText("Could not load this call");
  await page.screenshot({ path: testInfo.outputPath("detail-error.png"), fullPage: true });
  await page.unroute(`**/api/calls/${records[0].id}`); await go(page, "Try again");
  await expect(page.getByTestId("transcript-agent")).toHaveCount(2);
  await go(page, "Close call console");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/calls/${records[0].id}`, async (route) => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await go(page, "Open call to Aisha Tan");
  await expect(page.getByRole("status", { name: "Loading call details" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("detail-loading.png"), fullPage: true });
  await go(page, "Open call to Benjamin Teo");
  await expect(page.getByRole("heading", { name: "No conversation" })).toBeVisible();
  release();
  await expect(page.getByRole("complementary", { name: "Call details" })).toContainText("Benjamin Teo");
  await expect(page.getByTestId("transcript-agent")).toHaveCount(0);
});
