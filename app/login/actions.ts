"use server";
import { redirect } from "next/navigation";
import { userClient } from "@/lib/db/server";

export async function signOut() {
  const db = await userClient();
  await db.auth.signOut();
  redirect("/login");
}
