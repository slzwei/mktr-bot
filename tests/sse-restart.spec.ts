import { expect, test, type Page } from "@playwright/test";
import type { CallSession, FlowDefinition } from "../src/lib/domain";
import { authenticatedHeaders } from "./api-headers";
import { startRestartHarness } from "./support/restart-harness";

test("API restart recovers the open call console and two operators share the active count", async ({ browser }) => {
  const harness = await startRestartHarness();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const heartbeatController = new AbortController();
  try {
    const signIn = async (page: Page) => {
      await page.goto(harness.webOrigin);
      await page.getByLabel("Email").fill(harness.email);
      await page.getByLabel("Password").fill(harness.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("button", { name: "Test call", exact: true })).toBeVisible();
    };
    const left = await first.newPage();
    const right = await second.newPage();
    await signIn(left);
    await signIn(right);
    const headers = await authenticatedHeaders(left);
    const api = async (route: string, method = "GET", body?: unknown) => {
      const response = await left.request.fetch(harness.apiOrigin + route, { method, headers, data: body });
      expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true);
      return response.json();
    };
    const draft = await api("/api/flows", "POST", { name: "Restart observation" }) as FlowDefinition;
    await api(`/api/flows/${draft.id}`, "PUT", {
      ...draft, startNodeId: "start",
      nodes: [
        { id: "start", type: "start", data: { label: "Start" }, position: { x: 0, y: 0 } },
        { id: "listen-first", type: "listen", data: { label: "First reply", noSpeechTimeoutMs: 60_000 }, position: { x: 200, y: 0 } },
        { id: "listen-held", type: "listen", data: { label: "Wait through restart", noSpeechTimeoutMs: 60_000 }, position: { x: 400, y: 0 } },
        { id: "end", type: "end", data: { label: "End" }, position: { x: 600, y: 0 } }
      ],
      edges: [
        { id: "start-listen", source: "start", target: "listen-first" },
        { id: "first-held", source: "listen-first", target: "listen-held", condition: { fallback: true } },
        { id: "held-end", source: "listen-held", target: "end", condition: { fallback: true } }
      ]
    });
    await api(`/api/flows/${draft.id}/publish`, "POST", {});
    await api("/api/compliance/consent", "POST", { phone: "+6591234567", source: "Isolated simulator restart fixture", consentedAt: new Date(Date.now() - 1000).toISOString(), purpose: "voice_marketing" });
    await left.reload();
    await left.getByRole("button", { name: "Test call", exact: true }).click();
    await left.getByRole("combobox", { name: "Published flow", exact: true }).selectOption(draft.id);
    const started = left.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/calls"));
    await left.getByRole("button", { name: "Start test call", exact: true }).click();
    const call = await (await started).json() as CallSession;
    await expect.poll(async () => (await api(`/api/calls/${call.id}`)).currentNodeId).toBe("listen-held");
    await expect(left.locator(".sidebar__trunk")).toContainText("1 of 5 calls active");
    await expect(right.locator(".sidebar__trunk")).toContainText("1 of 5 calls active");

    // Observe the production 15-second heartbeat on the actual authenticated wire.
    const wire = await fetch(`${harness.apiOrigin}/api/calls/${call.id}/events`, { headers, signal: heartbeatController.signal });
    expect(wire.status).toBe(200);
    expect(wire.headers.get("x-accel-buffering")).toBe("no");
    const reader = wire.body!.getReader();
    let frames = "";
    const heartbeatDeadline = setTimeout(() => heartbeatController.abort(), 19_000);
    try {
      while (!frames.includes(": ping\n\n")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += Buffer.from(chunk.value!).toString();
      }
    } finally { clearTimeout(heartbeatDeadline); heartbeatController.abort(); }
    expect(frames).toMatch(/id: [^\n]+\ndata: /);
    expect(frames).toContain("retry: 1000");

    // Exclude bootstrap polling as a recovery path in this console: reconnect must refetch/SSE.
    await left.route("**/api/bootstrap", (route) => route.abort());
    await harness.crashApi();
    await expect(left.getByText("Reconnecting to call updates…", { exact: true })).toBeVisible();
    const refetched = left.waitForResponse((response) => response.url().endsWith(`/api/calls/${call.id}`) && response.request().method() === "GET" && response.ok());
    await harness.startApi();
    await refetched;
    // Boot recovery can explicitly terminate an interrupted simulator call. Older durable
    // snapshots still active are ended through the public API, exercising the reopened stream.
    const recovered = await api(`/api/calls/${call.id}`) as CallSession;
    if (!["ended", "failed"].includes(recovered.status)) await api(`/api/calls/${call.id}/end`, "POST", {});
    await expect(left.locator(".call-live__summary strong")).toHaveText(/^(ended|failed)$/);
    await expect(left.locator(".sidebar__trunk")).toContainText("0 of 5 calls active");
    await expect(right.locator(".sidebar__trunk")).toContainText("0 of 5 calls active");
    await expect(left.getByRole("complementary", { name: "Test call console" })).toBeVisible();
    await expect(left.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  } finally {
    heartbeatController.abort();
    try { await Promise.allSettled([first.close(), second.close()]); }
    finally { await harness.close(); }
  }
});
