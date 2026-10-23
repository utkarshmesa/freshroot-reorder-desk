// UP-08 (UI part): unknown IDs say "add or fix" with a link to Instructions, and the commit stays disabled.
import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const ROOT = process.cwd();

test("unknown SKU and distributor prompt 'add or fix' and block the commit", async ({ page }) => {
  await signIn(page, "priya");
  await page.getByLabel("Files to upload").setInputFiles(path.join(ROOT, "tests/fixtures/upload/unknown_ids.csv"));
  await page.getByRole("button", { name: "Check files" }).click();
  const issue = page.locator(".issue.error").filter({ hasText: "Unknown SKU" });
  await expect(issue).toContainText("SKU999");
  await expect(issue).toContainText("Add or fix");
  await expect(issue.getByRole("link", { name: "What to do" })).toHaveAttribute("href", "/instructions#what-to-do-when");
  await expect(page.getByRole("button", { name: "Commit" })).toBeDisabled();
  await expect(page.getByText("Nothing has been saved.")).toBeVisible();
});
