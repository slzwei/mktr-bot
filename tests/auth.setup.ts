import { expect, test as setup } from "@playwright/test";

setup("operator signs in with the environment-seeded administrator", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Voice Control" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(process.env.MKTR_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.MKTR_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "__Host-mktr_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  await page.context().storageState({ path: process.env.MKTR_E2E_AUTH_STATE! });
});
