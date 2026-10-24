// The Milestone 5 exit flow in the browser, case data, shadow mode: Monday upload → run → Raghav decides every
// card → Send to procurement → procurement sees drafts read-only → CEO sees the brief and decision log.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

const ROOT = process.cwd();
test.describe.configure({ mode: "serial" });

const card = (page: Page, name: string) => page.locator("article.desk-card").filter({ hasText: name });

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
    await expect(page.getByText(/Latest run: 2026-W43 \(done\)/)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
});

test("Raghav sees the W43 queue: three cards plus two spot-checks, most urgent first, with reasons and gauges", async ({ page }) => {
  await signIn(page, "raghav");
  await expect(page.getByRole("heading", { name: /Review desk · 2026-W43/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs your decision (5)" })).toBeVisible();
  await expect(page.locator("article.desk-card")).toHaveCount(5);
  await expect(card(page, "Mango Drink")).toContainText("Reorder 750");
  await expect(card(page, "Mango Drink").getByRole("img", { name: /Cover .* weeks; target 6 to 14 weeks/ })).toBeVisible();
  await expect(card(page, "Brown Rice")).toContainText("Spot-check");
  await expect(card(page, "Mango Drink")).toContainText("rule text"); // no Claude key locally: template text
});

test("Raghav approves, changes and rejects; a rejection needs a reason", async ({ page }) => {
  await signIn(page, "raghav");
  await card(page, "Mango Drink").getByRole("button", { name: "Approve 750" }).click();
  await expect(page.getByText("Saved: Card approved at 750 units.")).toBeVisible();

  const bread = card(page, "Multigrain Bread");
  await bread.getByLabel(/Changed quantity/).fill("500");
  await bread.getByRole("button", { name: "Approve changed qty" }).click();
  await expect(page.getByText("Saved: Card changed at 500 units.")).toBeVisible();

  await card(page, "Almond Milk").getByRole("button", { name: "Reject" }).click();
  await expect(page.locator(".banner.bad")).toContainText("Pick a reason for the rejection");
  await card(page, "Almond Milk").getByLabel(/Reason for/).selectOption("supplier_issue");
  await card(page, "Almond Milk").getByLabel(/Note for/).fill("supplier out until Friday");
  await card(page, "Almond Milk").getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Saved: Card rejected.")).toBeVisible();

  for (const name of ["Brown Rice", "Peanut Butter"]) {
    await card(page, name).getByRole("button", { name: /^Approve [\d,]+$/ }).click();
    await expect(page.getByText(/Saved: Card approved/)).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Needs your decision (0)" })).toBeVisible();
});

test("Send records shadow drafts for the three suppliers and nothing reaches Zoho", async ({ page }) => {
  await signIn(page, "raghav");
  await page.getByRole("button", { name: "Send 3 supplier draft(s)" }).click();
  await expect(page.getByText(/Recorded \(shadow mode, nothing sent to Zoho\) for DIST001, DIST002, DIST004\./)).toBeVisible();
  const drafts = page.getByRole("table").filter({ hasText: "FR-2026-W43-DIST001" });
  await expect(drafts).toContainText("FR-2026-W43-DIST002");
  await expect(drafts).toContainText("FR-2026-W43-DIST004");
  await expect(drafts).toContainText("shadow");
  await expect(page.getByRole("button", { name: /Send 0 supplier/ })).toBeDisabled();
});

test("procurement sees the desk and drafts read-only", async ({ page }) => {
  await signIn(page, "procurement");
  await expect(page.getByRole("heading", { name: /Review desk · 2026-W43/ })).toBeVisible();
  await expect(page.getByText("FR-2026-W43-DIST001")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Send|Reject/ })).toHaveCount(0);
});

test("the CEO sees the brief, pilot vs manual and the decision log", async ({ page }) => {
  await signIn(page, "ceo");
  await expect(page.getByText(/Week 2026-W43 \(shadow mode\)/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pilot vs manual" })).toBeVisible();
  // C-038: the shadow week compared with Raghav's actual orders (none read in case-data mode, so all "system only").
  await expect(page.getByRole("heading", { name: "Shadow: the system against Raghav's actual orders" })).toBeVisible();
  const shadowRow = page.locator("table").filter({ hasText: "Same call (order or not)" }).getByRole("row", { name: /2026-W43/ });
  await expect(shadowRow).toContainText(" / 0");
  await expect(page.getByRole("cell", { name: "supplier_issue: supplier out until Friday" })).toBeVisible();
});
