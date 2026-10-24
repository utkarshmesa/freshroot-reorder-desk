import type { Page } from "@playwright/test";
import { LOCAL_TEST_PASSWORD } from "../../scripts/seed/users";

export async function signIn(page: Page, who: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(`${who}@freshroots.test`);
  await page.getByLabel("Password").fill(LOCAL_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}
