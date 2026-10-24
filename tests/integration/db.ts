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

/** Empties the data tables (children first) so each test file starts from the seed state. */
export async function resetData(): Promise<void> {
  const svc = service();
  const tables: Array<[string, string]> = [
    ["decision", "id"], ["recommendation", "id"], ["draft_po", "id"], ["brief", "run_id"], ["alert", "id"],
    ["run", "id"], ["sales_fact", "sku_id"], ["stock_snapshot", "sku_id"], ["backfill_sales", "sku_id"],
    ["upload_staging", "id"], ["upload_hash", "hash"], ["upload", "id"], ["holdout", "sku_id"],
    ["event", "id"], ["sku", "id"], ["distributor", "id"], ["supplier", "id"], ["change_log", "id"],
  ];
  for (const [t, col] of tables) {
    const { error } = await svc.from(t).delete().not(col, "is", null);
    if (error) throw new Error(`reset ${t}: ${error.message}`);
  }
  // Every file starts in shadow mode (the default), whatever an earlier file switched to.
  const { error } = await svc.from("app_mode").update({ mode: "shadow" }).not("mode", "is", null);
  if (error) throw new Error(`reset app_mode: ${error.message}`);
}
