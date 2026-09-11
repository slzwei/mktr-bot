import type { Page } from "@playwright/test";

/** Chromium permits Secure cookies on loopback; Playwright's Node request jar does not. */
export async function authenticatedHeaders(page: Page, headers: Record<string, string> = {}) {
  const cookies = await page.context().cookies();
  return { ...headers, Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") };
}
