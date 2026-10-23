// ST-06 (database part) for the Milestone 1 tables: each role can do exactly what ARCHITECTURE §3.2 says.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { as, resetData, service, type Who } from "./db";

const ROLES: Who[] = ["priya", "raghav", "procurement", "it.admin", "deepa", "ceo"];

beforeAll(async () => {
  await resetData();
  const svc = service();
  await svc.from("supplier").upsert({ id: "RLS_SUP", name: "RLS supplier" });
  await svc.from("sku").upsert({ id: "RLS_SKU", name: "RLS test SKU", std_qty: 10, perishable: false, supplier_id: "RLS_SUP" });
  await svc.from("distributor").upsert({ id: "RLS_DIST", name: "RLS distributor" });
  const { data: up } = await svc.from("upload").insert({ status: "committed", by: (await as("priya")).id }).select("id").single();
  await svc.from("sales_fact").upsert({ sku_id: "RLS_SKU", distributor_id: "RLS_DIST", iso_week: "2026-W01", shipped_units: 1, returns_units: 0, upload_id: up!.id });
});

async function canUpdateSku(who: Who) {
  const { client } = await as(who);
  const { data, error } = await client.from("sku").update({ lead_time_wks: 3 }).eq("id", "RLS_SKU").select("id");
  return !error && (data?.length ?? 0) === 1;
}

describe("master data (sku): planner and admin write; procurement read-only (C-013)", () => {
  it.each([
    ["raghav", true],
    ["deepa", true],
    ["it.admin", true],
    ["procurement", false],
    ["priya", false],
    ["ceo", false],
  ] as Array<[Who, boolean]>)("%s can update sku: %s", async (who, allowed) => {
    expect(await canUpdateSku(who)).toBe(allowed);
  });

  it("every role can read the SKU list", async () => {
    for (const who of ROLES) {
      const { data } = await (await as(who)).client.from("sku").select("id").eq("id", "RLS_SKU");
      expect(data, who).toHaveLength(1);
    }
  });

  it("a non-member (signed in, no app_user row) sees nothing", async () => {
    const svc = service();
    await svc.auth.admin.createUser({ email: "stranger@freshroots.test", password: "local-dev-only-stranger-1", email_confirm: true });
    const { createClient } = await import("@supabase/supabase-js");
    const { inject } = await import("vitest");
    const cfg = inject("supabase");
    const c = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });
    await c.auth.signInWithPassword({ email: "stranger@freshroots.test", password: "local-dev-only-stranger-1" });
    const { data } = await c.from("sku").select("id");
    expect(data).toEqual([]);
  });

  it("changes are logged with the actor", async () => {
    const { client, id } = await as("raghav");
    await client.from("sku").update({ lead_time_wks: 4 }).eq("id", "RLS_SKU");
    const { data } = await service().from("change_log").select("by, old, new").match({ entity: "sku", entity_id: "RLS_SKU", field: "lead_time_wks" }).order("at", { ascending: false }).limit(1).single();
    expect(data).toEqual({ by: id, old: 3, new: 4 });
  });
});

describe("festivals and holds: planner only", () => {
  it.each([
    ["raghav", true],
    ["deepa", true],
    ["it.admin", false],
    ["procurement", false],
    ["priya", false],
    ["ceo", false],
  ] as Array<[Who, boolean]>)("%s can add a hold: %s", async (who, allowed) => {
    const { client } = await as(who);
    const { error } = await client.from("event").insert({ type: "hold", start_date: "2026-11-02", end_date: "2026-11-08", sku_ids: ["RLS_SKU"], reason: `test by ${who}` });
    expect(!error).toBe(allowed);
  });
});

describe("rules: planner publishes a new version with a reason (D12)", () => {
  it("planner can, with a reason; the old version stops being current", async () => {
    const { client } = await as("raghav");
    const params = { ...DEFAULT_RULES, highDemandRatio: 1.25 };
    await expect(client.rpc("publish_rule_version", { p_params: params, p_reason: "" }).then((r) => { if (r.error) throw r.error; })).rejects.toThrow(/reason/);
    const { data: id, error } = await client.rpc("publish_rule_version", { p_params: params, p_reason: "Test: stricter high-demand ratio" });
    expect(error).toBeNull();
    const { data } = await service().from("rule_version").select("id").eq("is_current", true);
    expect(data).toEqual([{ id }]);
    const { data: cur } = await client.rpc("current_rules");
    expect(cur.params.highDemandRatio).toBe(1.25);
    // restore defaults for later tests
    await client.rpc("publish_rule_version", { p_params: DEFAULT_RULES, p_reason: "Test: restore defaults" });
  });

  it.each(["procurement", "it.admin", "priya", "ceo"] as Who[])("%s cannot publish rules", async (who) => {
    const { error } = await (await as(who)).client.rpc("publish_rule_version", { p_params: DEFAULT_RULES, p_reason: "x" });
    expect(error?.message).toMatch(/Only the planner/);
  });

  it("nobody writes rule_version directly", async () => {
    const { error } = await (await as("raghav")).client.from("rule_version").insert({ params: DEFAULT_RULES, reason: "direct", is_current: false });
    expect(error).not.toBeNull();
  });
});

describe("mode and holdout: only the owner (Deepa) (D17, A16)", () => {
  it("IT admin (admin, not owner) cannot switch to live", async () => {
    const { error } = await (await as("it.admin")).client.rpc("set_mode", { p_mode: "live", p_reason: "x" });
    expect(error?.message).toMatch(/Only the owner/);
  });

  it("Deepa can switch, and it's logged; then back to shadow", async () => {
    const { client, id } = await as("deepa");
    expect((await client.rpc("set_mode", { p_mode: "live", p_reason: "Test switch" })).error).toBeNull();
    const { data } = await service().from("change_log").select("by, new, reason").match({ entity: "app_mode", field: "mode" }).order("at", { ascending: false }).limit(1).single();
    expect(data).toEqual({ by: id, new: "live", reason: "Test switch" });
    await client.rpc("set_mode", { p_mode: "shadow", p_reason: "Test: back to shadow" });
  });

  it("nobody updates app_mode directly", async () => {
    const { data } = await (await as("deepa")).client.from("app_mode").update({ mode: "live" }).eq("id", true).select();
    expect(data ?? []).toEqual([]);
    const { data: m } = await service().from("app_mode").select("mode").single();
    expect(m!.mode).toBe("shadow");
  });

  it("holdout: Deepa yes, Raghav no", async () => {
    expect((await (await as("deepa")).client.rpc("set_holdout", { p_sku_ids: ["RLS_SKU"], p_reason: "test" })).error).toBeNull();
    expect((await (await as("raghav")).client.rpc("set_holdout", { p_sku_ids: [], p_reason: "test" })).error?.message).toMatch(/Only the owner/);
    await (await as("deepa")).client.rpc("set_holdout", { p_sku_ids: [], p_reason: "test cleanup" });
  });
});

describe("uploads and facts", () => {
  it("only uploaders can prepare or commit uploads", async () => {
    for (const who of ["raghav", "procurement", "ceo"] as Who[]) {
      const { error } = await (await as(who)).client.rpc("upload_context", { p_hashes: [] });
      expect(error?.message, who).toMatch(/Only an uploader/);
    }
    expect((await (await as("priya")).client.rpc("upload_context", { p_hashes: [] })).error).toBeNull();
  });

  it("nobody can insert an upload or staging rows through the API (server writes them after validating)", async () => {
    const { client, id } = await as("priya");
    expect((await client.from("upload").insert({ by: id, validation_report: { errors: 0, unconfirmed: 0 } })).error).not.toBeNull();
  });

  it("the viewer (CEO) can't read sales or stock facts; procurement can", async () => {
    const ceo = await (await as("ceo")).client.from("sales_fact").select("sku_id").limit(1);
    expect(ceo.data).toEqual([]);
    const proc = await (await as("procurement")).client.from("sales_fact").select("sku_id").limit(1);
    expect(proc.data!.length).toBe(1);
  });

  it("no role can read the Zoho token cache or committed hashes", async () => {
    for (const who of ROLES) {
      const c = (await as(who)).client;
      expect((await c.from("zoho_token_cache").select("*")).data ?? [], who).toEqual([]);
      expect((await c.from("upload_hash").select("*")).data ?? [], who).toEqual([]);
    }
  });
});

describe("people: self or admin", () => {
  it("a user sees only their own app_user row; admin sees all", async () => {
    expect((await (await as("raghav")).client.from("app_user").select("email")).data).toEqual([{ email: "raghav@freshroots.test" }]);
    expect(((await (await as("it.admin")).client.from("app_user").select("email")).data ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("a user can't grant themselves roles", async () => {
    const { client, id } = await as("priya");
    const { data } = await client.from("app_user").update({ roles: ["uploader", "admin"] }).eq("user_id", id).select();
    expect(data ?? []).toEqual([]);
  });
});
