// ST-07 (e2e) and e2e 5: the Instructions screen shows the live Settings values, reachable from every header,
// with the sections other screens link to. Restores the rule it changes, so later files see the seed rules.
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

async function setHighDemand(page: import("@playwright/test").Page, ratio: string, reason: string) {
  await page.goto("/settings/rules");
  await page.locator('input[name="highDemandRatio"]').fill(ratio);
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Publish new version" }).click();
  await expect(page.getByRole("cell", { name: reason })).toBeVisible();
}

test("every role reaches it from the header; the CEO reads the rules with today's values", async ({ page }) => {
  await signIn(page, "ceo");
  await page.getByRole("link", { name: "How this works" }).click();
  await expect(page).toHaveURL(/\/instructions$/);
  await expect(page.getByRole("heading", { name: "How the Freshroots Reorder Desk works" })).toBeVisible();
  await expect(page.locator("#rules")).toBeVisible();
  await expect(page.locator("article.instructions")).toContainText("more than 20% ⚙ above the 12-week average");
  await expect(page.locator("article.instructions")).not.toContainText("{{");
  await expect(page.getByText(/come from rules version \d+/)).toBeVisible();
});

test("links from other screens land on their sections", async ({ page }) => {
  await signIn(page, "priya");
  for (const id of ["assumptions", "what-to-do-when", "uploader-priya"]) {
    await page.goto(`/instructions#${id}`);
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});

test("ST-07: Raghav changes the high-demand threshold 20% → 25% with a reason; Instructions shows 25% at once", async ({ page }) => {
  await signIn(page, "raghav");
  await setHighDemand(page, "1.25", "ST-07 e2e: test the Instructions binding");
  await page.goto("/instructions");
  await expect(page.locator("article.instructions")).toContainText("more than 25% ⚙ above the 12-week average");
  await expect(page.locator("article.instructions")).toContainText("Last 4 weeks' sales more than 25% ⚙");
  // Back to the seed value so the W43 reference flow later in the run is unaffected.
  await setHighDemand(page, "1.2", "ST-07 e2e: restore the seed value");
  await page.goto("/instructions");
  await expect(page.locator("article.instructions")).toContainText("more than 20% ⚙ above the 12-week average");
});
