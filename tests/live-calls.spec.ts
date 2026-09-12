import { expect, test as base, type Page } from "@playwright/test";
import { CALLER_IDS, SCENARIOS, type CallSession, type FlowDefinition, type TestCallInput } from "../src/lib/domain";
import { authenticatedHeaders } from "./api-headers";
import { operatorFixture, seedHistory } from "./support/operator-fixture";

const test = base.extend<{ operator: Awaited<ReturnType<typeof operatorFixture>> }>({
  operator: async ({ page }, use) => {
    const fixture = await operatorFixture();
    try {
      await page.context().clearCookies();
      await page.addInitScript(() => {
        const streams: EventSource[] = [];
        const Native = window.EventSource;
        window.EventSource = class extends Native {
          constructor(url: string | URL, options?: EventSourceInit) { super(url, options); streams.push(this); }
        };
        Object.assign(window, { callStreams: streams });
      });
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

const go = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
const card = (page: Page, call: CallSession) => page.locator(`[data-call-id="${call.id}"]`);
const focusRefresh = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const connections = (page: Page) => page.evaluate(() => (window as unknown as { callStreams: EventSource[] }).callStreams.filter((stream) => stream.readyState !== EventSource.CLOSED).map((stream) => new URL(stream.url).pathname));
async function api<T>(page: Page, origin: string, route: string, method = "GET", data?: unknown): Promise<T> {
  const response = await page.request.fetch(origin + route, { method, headers: await authenticatedHeaders(page), data });
  expect(response.ok(), `${method} ${route}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
async function prepare(page: Page, origin: string, held = true) {
  const flow = await api<FlowDefinition>(page, origin, "/api/flows", "POST", { name: "Live observation" });
  await api(page, origin, `/api/flows/${flow.id}`, "PUT", {
    ...flow, startNodeId: "start",
    nodes: [
      { id: "start", type: "start", data: { label: "Start" }, position: { x: 0, y: 0 } },
      { id: "reply", type: "listen", data: { label: "First reply", noSpeechTimeoutMs: 60_000 }, position: { x: 200, y: 0 } },
      ...(held ? [{ id: "follow-up", type: "listen", data: { label: "Awaiting follow-up", noSpeechTimeoutMs: 60_000 }, position: { x: 400, y: 0 } }] : []),
      { id: "end", type: "end", data: { label: "End" }, position: { x: 600, y: 0 } }
    ],
    edges: [
      { id: "start-reply", source: "start", target: "reply" },
      { id: "reply-next", source: "reply", target: held ? "follow-up" : "end", condition: { fallback: true } },
      ...(held ? [{ id: "follow-up-end", source: "follow-up", target: "end", condition: { fallback: true } }] : [])
    ]
  });
  const { flow: published } = await api<{ flow: FlowDefinition }>(page, origin, `/api/flows/${flow.id}/publish`, "POST", {});
  // The app loads flow definitions at entry, preserving unsaved editor state on polls.
  await page.reload();
  await go(page, "Live calls");
  return published;
}
async function start(page: Page, origin: string, flowId: string, index: number, scenario: TestCallInput["scenario"] = "interested") {
  const destination = `+65912000${String(index).padStart(2, "0")}`;
  await api(page, origin, "/api/compliance/consent", "POST", { phone: destination, source: "Isolated live-view simulator fixture", consentedAt: new Date(Date.now() - 1000).toISOString(), purpose: "voice_marketing" });
  return api<CallSession>(page, origin, "/api/calls", "POST", { destination, callerId: CALLER_IDS[index % CALLER_IDS.length], flowId, scenario });
}

test("three simulator calls stream independently with roster and detail reads frozen, then finish in place", async ({ page, operator }, testInfo) => {
  const flow = await prepare(page, operator.origin);
  await expect(page.getByRole("heading", { name: "No calls running", exact: true })).toBeVisible();
  const scenarios = ["interested", "callback", "not_interested"] as const;
  const calls = await Promise.all(scenarios.map((scenario, index) => start(page, operator.origin, flow.id, index, scenario)));
  await focusRefresh(page);
  await expect(page.getByTestId("live-call-card")).toHaveCount(3);
  await expect.poll(() => connections(page)).toHaveLength(3);
  const snapshot = await api(page, operator.origin, "/api/bootstrap");
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: snapshot }));
  await page.route(/\/api\/calls\/[^/]+$/, (route) => route.abort());
  for (const [index, call] of calls.entries()) {
    const tile = card(page, call);
    await expect(tile.getByText("Live event timeline", { exact: true })).toBeVisible();
    await expect(tile.locator(".live-call-facts")).toContainText("Awaiting follow-up");
    await expect(tile.locator(".live-call-speech")).toContainText(SCENARIOS[scenarios[index]].transcript);
    await expect(tile.locator(".event-log")).toContainText("Transcript final");
    await expect(tile).toContainText(call.callerId);
    await expect(tile).toContainText("Not recording");
    await expect(tile.locator(".live-call-status")).toHaveText("Listening");
    await expect(tile.locator(".event-log time").last()).toHaveText(new Date(call.events[0].timestamp).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  const tick = await card(page, calls[0]).locator(".live-call-duration").innerText();
  await expect(card(page, calls[0]).locator(".live-call-duration")).not.toHaveText(tick);
  await page.screenshot({ path: testInfo.outputPath("live-calls-three.png"), fullPage: true });
  await testInfo.attach("Three concurrent simulator calls", { path: testInfo.outputPath("live-calls-three.png"), contentType: "image/png" });
  const positions = await page.getByTestId("live-call-card").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-call-id")));
  await card(page, calls[0]).getByRole("button", { name: "End call", exact: true }).click();
  await expect(card(page, calls[0]).getByText("Stopped", { exact: true })).toBeVisible();
  await expect(card(page, calls[0])).toContainText("Stopped by operator");
  await expect(page.getByRole("region", { name: "Trunk capacity" })).toContainText("2 / 5");
  await expect.poll(() => connections(page)).toHaveLength(2);
  // Public simulator interface, same classifier/flow path as the automatic reply.
  await operator.calls.submitTranscript(calls[1].id, SCENARIOS.callback.transcript);
  await expect(card(page, calls[1]).getByText("Callback requested", { exact: true })).toBeVisible();
  const failed = operator.calls.get(calls[2].id)!;
  await operator.calls.mediaError(failed.id, failed.listenWindowId!);
  await expect(card(page, calls[2])).toContainText("Speech transcription unavailable.");
  await expect(card(page, calls[2]).locator(".live-call-status")).toHaveText("Failed");
  await expect.poll(() => connections(page)).toHaveLength(0);
  // Stale bootstrap must neither resurrect finished calls nor replace their logs.
  await focusRefresh(page);
  await expect(page.getByRole("region", { name: "Trunk capacity" })).toContainText("0 / 5");
  expect(await page.getByTestId("live-call-card").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-call-id")))).toEqual(positions);
  const frozen = await card(page, calls[0]).locator(".live-call-duration").innerText();
  await page.waitForTimeout(1100);
  await expect(card(page, calls[0]).locator(".live-call-duration")).toHaveText(frozen);
  await card(page, calls[0]).getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(card(page, calls[0])).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Live calls", exact: true })).toBeFocused();
});

test("natural scenario outcomes remain visible and stop failures can be retried", async ({ page, operator }) => {
  const flow = await prepare(page, operator.origin, false);
  const calls = await Promise.all([start(page, operator.origin, flow.id, 0), start(page, operator.origin, flow.id, 1, "callback")]);
  await focusRefresh(page);
  await expect(page.getByTestId("live-call-card")).toHaveCount(2);
  await expect(card(page, calls[0]).getByText("Interested", { exact: true })).toBeVisible();
  await expect(card(page, calls[1]).getByText("Callback requested", { exact: true })).toBeVisible();
  await expect.poll(() => connections(page)).toHaveLength(0);
  await go(page, "Dismiss 2 finished calls");
  await expect(page.getByRole("heading", { name: "No calls running", exact: true })).toBeVisible();
  const held = await prepare(page, operator.origin);
  const call = await start(page, operator.origin, held.id, 2);
  await focusRefresh(page);
  await page.route(`**/api/calls/${call.id}/end`, (route) => route.fulfill({ status: 503, json: { error: "Simulator stop temporarily unavailable." } }));
  await card(page, call).getByRole("button", { name: "End call", exact: true }).click();
  await expect(card(page, call).getByRole("alert")).toContainText("Simulator stop temporarily unavailable.");
  await expect(card(page, call).getByRole("button", { name: "End call", exact: true })).toBeEnabled();
  await page.unroute(`**/api/calls/${call.id}/end`);
  await card(page, call).getByRole("button", { name: "End call", exact: true }).click();
  await expect(card(page, call).getByText("Stopped", { exact: true })).toBeVisible();
});

test("full capacity, single-card layout, narrow screens, and stream cleanup on navigation and roster removal", async ({ page, operator }, testInfo) => {
  const flow = await prepare(page, operator.origin);
  const first = await start(page, operator.origin, flow.id, 0);
  await focusRefresh(page);
  await expect(page.getByTestId("live-call-card")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("live-calls-one.png"), fullPage: true });
  const others = await Promise.all([1, 2, 3, 4].map((index) => start(page, operator.origin, flow.id, index)));
  await focusRefresh(page);
  await expect(page.getByTestId("live-call-card")).toHaveCount(5);
  await expect(page.getByRole("region", { name: "Trunk capacity" })).toContainText("5 / 5");
  await expect(page.getByText("Trunk full", { exact: true })).toBeVisible();
  await expect.poll(() => connections(page)).toHaveLength(5);
  for (const width of [1440, 1024, 640, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".main-view")!.scrollWidth <= document.querySelector(".main-view")!.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`live-calls-full-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bootstrap = await api<{ calls: CallSession[] }>(page, operator.origin, "/api/bootstrap");
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...bootstrap, calls: bootstrap.calls.filter((call) => call.id !== first.id) } }));
  await focusRefresh(page);
  await expect(card(page, first)).toHaveCount(0);
  await expect.poll(() => connections(page)).toHaveLength(4);
  await go(page, "Flows");
  await expect.poll(() => connections(page)).toHaveLength(0);
  await go(page, "Live calls");
  await expect.poll(() => connections(page)).toHaveLength(4);
  await expect(card(page, others[0]).getByText("Live event timeline")).toBeVisible();
});

test("dropped and permanently closed streams recover without clearing either timeline", async ({ page, operator }) => {
  const flow = await prepare(page, operator.origin);
  const calls = await Promise.all([start(page, operator.origin, flow.id, 0), start(page, operator.origin, flow.id, 1, "callback")]);
  await focusRefresh(page);
  for (const call of calls) await expect(card(page, call)).toContainText("Awaiting follow-up");
  await page.route("**/api/bootstrap", (route) => route.abort());
  await page.route(/\/api\/calls\/[^/]+$/, (route) => route.fulfill({ status: 503, json: { error: "Read interrupted" } }));
  let rejectStreams = true;
  await page.route("**/api/calls/*/events", (route) => rejectStreams ? route.fulfill({ status: 503, body: "Temporarily unavailable" }) : route.continue());
  operator.closeStreams();
  for (const call of calls) {
    await expect(card(page, call).getByText("Reconnecting to call updates…")).toBeVisible();
    await expect(card(page, call).locator(".event-log")).toContainText("Transcript final");
  }
  // Wait for a failed HTTP reconnect, exercising CLOSED transport recreation.
  await expect.poll(() => page.evaluate(() => (window as unknown as { callStreams: EventSource[] }).callStreams.some((stream) => stream.readyState === EventSource.CLOSED))).toBe(true);
  rejectStreams = false;
  await page.unroute(/\/api\/calls\/[^/]+$/);
  for (const call of calls) await expect(card(page, call).getByText("Live connection", { exact: true })).toBeVisible();
  await operator.calls.submitTranscript(calls[1].id, SCENARIOS.callback.transcript);
  await expect(card(page, calls[1]).getByText("Callback requested", { exact: true })).toBeVisible();
  await expect(card(page, calls[0]).locator(".live-call-status")).toHaveText("Listening");
  await go(page, "Flows");
  await expect.poll(() => connections(page)).toHaveLength(0);
});

test("known contact and campaign names, recording metadata, and missing flow versions have honest fallbacks", async ({ page, operator }) => {
  const { records, contacts } = seedHistory(operator.store, 3);
  const call = { ...records[0], status: "listening" as const, currentNodeId: "deleted-node", createdAt: new Date().toISOString(), endedAt: undefined, outcome: undefined, endReason: undefined };
  operator.store.saveCall(call);
  await operator.store.deleteFlow(call.flowId);
  await page.reload();
  await go(page, "Live calls");
  await expect(card(page, call).getByRole("heading", { name: contacts[0].name })).toBeVisible();
  await expect(card(page, call)).toContainText("September customer outreach");
  await expect(card(page, call)).toContainText("Unavailable flow");
  await expect(card(page, call)).toContainText(`Node deleted-node · label unavailable for v${call.flowVersion}`);
  await expect(card(page, call).getByText("Recording", { exact: true })).toBeVisible();
  await expect(card(page, call).locator(".event-log")).toContainText("420 ms");
  await expect(card(page, call).locator(".event-log")).toContainText("0 ms");
  // A failed name lookup still leaves the number, ID and independent stream usable.
  await go(page, "Flows");
  await page.route("**/api/contacts", (route) => route.fulfill({ status: 503, json: { error: "Names unavailable" } }));
  await go(page, "Live calls");
  await expect(page.getByRole("alert")).toContainText("Could not load contact and campaign names");
  await expect(card(page, call).getByRole("heading", { name: call.destination })).toBeVisible();
  await page.unroute("**/api/contacts");
  await go(page, "Try again");
  await expect(card(page, call).getByRole("heading", { name: contacts[0].name })).toBeVisible();
});

test("reduced motion pauses timers and logs, keeps controls live, and resumes without screen-reader announcements", async ({ page, operator }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const flow = await prepare(page, operator.origin);
  const call = await start(page, operator.origin, flow.id, 0);
  await focusRefresh(page);
  await expect(card(page, call)).toBeVisible();
  const log = await card(page, call).locator(".event-log").innerText();
  const timer = await card(page, call).locator(".live-call-duration").innerText();
  await expect(card(page, call).locator(".live-call-facts")).toContainText("Awaiting follow-up");
  await expect(card(page, call).locator(".event-log")).toHaveText(log);
  await expect(card(page, call).locator(".live-call-duration")).toHaveText(timer);
  await expect(card(page, call).locator(".event-log")).toHaveAttribute("aria-live", "off");
  expect(await card(page, call).locator('[role="log"], [role="timer"], [aria-live="polite"], [aria-live="assertive"]').count()).toBe(0);
  await go(page, "Resume timers & logs");
  await expect(card(page, call).locator(".event-log")).toContainText("Transcript final");
  const region = card(page, call).getByRole("region", { name: "Technical events, newest first" });
  await region.focus();
  expect(await region.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("End");
  await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await go(page, "Pause timers & logs");
  await card(page, call).getByRole("button", { name: "End call", exact: true }).click();
  await expect(card(page, call)).toContainText("Stopped by operator");
  await expect.poll(() => connections(page)).toHaveLength(0);
});

test("initial loading and bootstrap failure are recoverable before showing the normal idle state", async ({ page, operator }, testInfo) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/bootstrap", async (route) => { await gate; await route.fulfill({ status: 503, json: { error: "Simulator starting up" } }); });
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Loading voice control");
  release();
  await expect(page.getByRole("alert")).toContainText("Could not load voice control");
  await page.unroute("**/api/bootstrap");
  await go(page, "Try again");
  await go(page, "Live calls");
  await expect(page.getByRole("heading", { name: "No calls running", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Trunk capacity" })).toContainText("0 / 5");
  await page.screenshot({ path: testInfo.outputPath("live-calls-empty.png"), fullPage: true });
  await go(page, "Go to flows");
  await expect(page.getByRole("button", { name: "Test call", exact: true })).toBeVisible();
  expect(operator.calls.activeCallCount()).toBe(0);
});
