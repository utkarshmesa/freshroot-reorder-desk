// ST-06 (UI part): each role sees only its screens and lands on its main screen.
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const cases: Array<[string, string, string[], string[]]> = [
  ["priya", "/upload", ["Upload"], ["/settings/skus", "/review", "/outcomes"]],
  ["raghav", "/review", ["Review desk", "Settings", "Outcomes"], ["/upload"]],
  ["procurement", "/review", ["Review desk", "Settings", "Outcomes"], ["/upload"]],
  ["ceo", "/outcomes", ["Outcomes"], ["/upload", "/review", "/settings/skus"]],
];

for (const [who, home, nav, forbidden] of cases) {
  test(`${who}: lands on ${home}, sees ${nav.join(", ")}, blocked elsewhere`, async ({ page }) => {
    await signIn(page, who);
    await expect(page).toHaveURL(new RegExp(`${home}$`));
    const links = await page.locator("header.top nav a").allTextContents();
    expect(links).toEqual(nav);
    await expect(page.getByRole("link", { name: "How this works" })).toBeVisible();
    for (const path of forbidden) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/forbidden$/);
    }
  });
}

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/settings/rules");
  await expect(page).toHaveURL(/\/login$/);
});

test("procurement sees settings read-only (C-013)", async ({ page }) => {
  await signIn(page, "procurement");
  await page.goto("/settings/skus");
  await expect(page.getByText("Read-only for your role.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Add SKU" })).toHaveCount(0);
  await page.goto("/settings/mode");
  await expect(page.getByText("Only Deepa can switch between shadow and live.")).toBeVisible();
});

test("only Deepa sees the shadow/live switch", async ({ page }) => {
  await signIn(page, "deepa");
  await page.goto("/settings/mode");
  await expect(page.getByLabel("Mode")).toBeVisible();
});
