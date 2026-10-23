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

test("case files commit and the W43 run is computed straight away (M1 + M2 exit)", async ({ page }) => {
  await signIn(page, "priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) => path.join(ROOT, `data/case/${f}.csv`));
  await page.getByLabel("Files to upload").setInputFiles(files);
  await page.getByRole("button", { name: "Check files" }).click();
  await expect(page.getByText("0 to fix")).toBeVisible();
  await expect(page.getByText(/top-3 distributor view is hidden/)).toBeVisible();
  await page.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText("Committed. The 2026-W43 run is queued.")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Latest run: 2026-W43 (ready)")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});
