import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import { LOCAL_TEST_PASSWORD, LOCAL_USERS } from "@/scripts/seed/users";

export type Who = "priya" | "raghav" | "procurement" | "it.admin" | "deepa" | "ceo";

const cfg = () => inject("supabase");
const url = () => cfg().url;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

export const service = (): SupabaseClient => createClient(url(), cfg().serviceKey, opts);

const cache = new Map<Who, { client: SupabaseClient; id: string }>();
export async function as(who: Who): Promise<{ client: SupabaseClient; id: string }> {
  const hit = cache.get(who);
  if (hit) return hit;
  const u = LOCAL_USERS.find((x) => x.email.startsWith(`${who}@`))!;
  const client = createClient(url(), cfg().anonKey, opts);
  const { error } = await client.auth.signInWithPassword({ email: u.email, password: LOCAL_TEST_PASSWORD });
  if (error) throw new Error(`login ${who}: ${error.message}`);
  const v = { client, id: u.id };
  cache.set(who, v);
  return v;
}
