// Email sign-in links (ARCHITECTURE §9; needed before the first hosted deploy): a person asks for a link, it
// arrives (local Mailpit), and opening it signs them in on their own screen. Unknown addresses get the same
// reply and no email; a used or bad link says so.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const MAILPIT = "http://127.0.0.1:56324/api/v1";

async function latestLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const list = (await (await fetch(`${MAILPIT}/messages`)).json()) as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
    const m = list.messages.find((x) => x.To.some((t) => t.Address === email));
    if (m) {
      const msg = (await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { HTML: string };
      const href = /href="([^"]*\/auth\/confirm[^"]*)"/.exec(msg.HTML)?.[1];
      if (href) return href.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no sign-in email for ${email}`);
}

test.beforeEach(async () => {
  await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
});

test("a planner asks for a link, opens it and lands on the review desk", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email for a sign-in link").fill("raghav@freshroots.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("If that address has access, a sign-in link is on its way.")).toBeVisible();
  const link = await latestLinkFor("raghav@freshroots.test");
  await page.goto(link);
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("link", { name: "How this works" })).toBeVisible();

  // The same link doesn't work twice.
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page).toHaveURL(/\/login\?error=link$/);
  await expect(page.getByText("That sign-in link has expired or was already used.")).toBeVisible();
});

test("a link from Supabase's default email (free plan) brings the session in the address and signs the person in", async ({ page }) => {
  // The hosted free plan can't use our templates: Supabase verifies the link itself and redirects with the
  // session in the address fragment (invites). Admin-generated links behave the same way.
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: "raghav@freshroots.test", options: { redirectTo: "http://localhost:3000/login" } });
  expect(error).toBeNull();
  await page.goto(data.properties!.action_link);
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("link", { name: "How this works" })).toBeVisible();
});

test("an unknown address gets the same reply and no email", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email for a sign-in link").fill("stranger@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("If that address has access, a sign-in link is on its way.")).toBeVisible();
  await new Promise((r) => setTimeout(r, 1500));
  const list = (await (await fetch(`${MAILPIT}/messages`)).json()) as { messages: unknown[] };
  expect(list.messages).toEqual([]);
});
