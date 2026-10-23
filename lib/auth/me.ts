import "server-only";
import { redirect } from "next/navigation";
import { userClient } from "@/lib/db/server";
import { can, canSee, type Action, type Me, type Role, type Screen } from "./access";

export type Session = Me & { userId: string; name: string; email: string };

/** The signed-in user with their roles, or null. */
export async function getSession(): Promise<Session | null> {
  const db = await userClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const { data } = await db.from("app_user").select("name, email, roles, is_owner").eq("user_id", auth.user.id).maybeSingle();
  if (!data) return { userId: auth.user.id, name: auth.user.email ?? "", email: auth.user.email ?? "", roles: [], isOwner: false };
  return { userId: auth.user.id, name: data.name, email: data.email, roles: data.roles as Role[], isOwner: data.is_owner };
}

/** For pages: signed in and allowed to see the screen, else redirect. */
export async function requireScreen(screen: Screen): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!canSee(s, screen)) redirect("/forbidden");
  return s;
}

/** For server actions: signed in and allowed to take the action, else throw. */
export async function requireAction(action: Action): Promise<Session> {
  const s = await getSession();
  if (!s || !can(s, action)) throw new Error("You don't have permission to do that.");
  return s;
}
