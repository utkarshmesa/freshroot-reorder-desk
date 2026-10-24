"use server";
import { redirect } from "next/navigation";
import { userClient } from "@/lib/db/server";

export async function signOut() {
  const db = await userClient();
  await db.auth.signOut();
  redirect("/login");
}

/**
 * Emails a one-time sign-in link (ARCHITECTURE §9). Never creates an account: only people an admin has added
 * can sign in. The reply is the same whether or not the address has access.
 */
export async function sendSignInLink(_prev: string | null, form: FormData): Promise<string> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email) await (await userClient()).auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  return "If that address has access, a sign-in link is on its way. It works once.";
}
