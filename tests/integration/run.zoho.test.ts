// The run with Zoho (against the in-memory Zoho): §8 steps 1–3 through to recommendation rows.
// ZO-01/02/07/08/10/12, ZO-05/06 read-back, RN-07 (pending draft at run time), ST-04 (no writes).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZohoHttp, type Fetch } from "@/lib/zoho/http";
import { dbTokenSource } from "@/lib/zoho/token";
import { processRun } from "@/lib/run/worker";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { as, resetData, service } from "./db";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const SKUS = Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`);
let z: FakeZoho;
let firstRun = "";

const factory = (budgetOverride?: number) => (db: Parameters<typeof dbTokenSource>[0], budget: number) =>
  new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: dbTokenSource(db, CFG, z.fetch), budget: budgetOverride ?? budget, sleep: async () => {} });

async function freshRun(): Promise<string> {
  const { data, error } = await service().rpc("supersede_or_start_run", { p_week: "2026-W43", p_upload: null });
  if (error) throw new Error(error.message);
  return (data as { run_id: string }).run_id;
}
const run = (id: string, budget?: number) => processRun(service(), id, { caseDataMode: false, zoho: factory(budget), now: new Date("2026-10-19T03:30:00Z") });
async function recs(runId: string) {
  const { data } = await service().from("recommendation").select("sku_id, action, qty, triage, line_state, flags, inputs").eq("run_id", runId);
  return Object.fromEntries((data ?? []).map((r) => [r.sku_id, r]));
}

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))),
  );
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  firstRun = (await commitUpload(client, staged.uploadId)).run_id!;
  const svc = service();
  for (const s of SKUS) await svc.from("sku").update({ zoho_item_id: `it-${s}`, uom: "Units" }).eq("id", s);
  for (const d of ["DIST001", "DIST002", "DIST003", "DIST004"]) await svc.from("supplier").update({ zoho_vendor_id: `v-${d}` }).eq("id", d);
});

beforeEach(async () => {
  z = new FakeZoho();
  for (const s of SKUS) z.items.set(`it-${s}`, { item_id: `it-${s}`, sku: s, unit: "Units", status: "active" });
  for (const d of ["DIST001", "DIST002", "DIST003", "DIST004"]) z.vendors.set(`v-${d}`, { contact_id: `v-${d}`, status: "active" });
  await service().from("zoho_token_cache").delete().eq("id", true);
});

describe("reading Zoho into the position (ZO-01, ZO-02, ST-04)", () => {
  it("counts open POs and Monday receipts, ignores drafts, and writes nothing to Zoho", async () => {
    z.addPo({ purchaseorder_id: "open-1", status: "open", line_items: [{ item_id: "it-SKU013", quantity: 300, quantity_received: 0 }] });
    z.addPo({ purchaseorder_id: "draft-1", status: "draft", line_items: [{ item_id: "it-SKU003", quantity: 999 }] });
    z.addPo({ purchaseorder_id: "recv-1", status: "received", line_items: [{ item_id: "it-SKU004", quantity: 100, quantity_received: 100 }] });
    z.addReceive({ receive_id: "rc-1", date: "2026-10-19", purchaseorder_id: "recv-1", line_items: [{ item_id: "it-SKU004", quantity: 100 }] });
    const id = await freshRun();
    expect((await run(id)).status).toBe("done");
    const r = await recs(id);
    // Peanut Butter: 180 + 300 open = 480 → cover 8.45 → no action now.
    expect([(r.SKU013!.inputs as { position: number }).position, r.SKU013!.action]).toEqual([480, "none"]);
    // Brown Rice: the 999 draft doesn't count → still reorder 600.
    expect([(r.SKU003!.inputs as { position: number }).position, r.SKU003!.qty]).toEqual([820, 600]);
    // Almond Milk: 180 + 100 received Monday = 280; the perishable cap (119) is now below MOQ 150 → infeasible.
    expect((r.SKU004!.inputs as { position: number }).position).toBe(280);
    expect(r.SKU004!.flags).toContain("infeasible");
    const { data } = await service().from("run").select("zoho_read").eq("id", id).single();
    expect((data!.zoho_read as { calls: number }).calls).toBeGreaterThan(0);
    expect((data!.zoho_read as { calls: number }).calls).toBeLessThanOrEqual(300);
    expect(z.writes()).toEqual([]);
  });
});

describe("ZO-07 mapping check", () => {
  it("blocks an unmapped SKU and a unit mismatch; the rest run normally", async () => {
    await service().from("sku").update({ zoho_item_id: null }).eq("id", "SKU002");
    z.items.set("it-SKU005", { item_id: "it-SKU005", unit: "Cases", status: "active" });
    const id = await freshRun();
    await run(id);
    const r = await recs(id);
    expect([r.SKU002!.action, (r.SKU002!.inputs as { blockedReason: string }).blockedReason]).toEqual(["blocked", "No Zoho item mapped (Settings › SKUs)"]);
    expect((r.SKU005!.inputs as { blockedReason: string }).blockedReason).toMatch(/Unit mismatch/);
    expect(r.SKU003!.qty).toBe(600);
    await service().from("sku").update({ zoho_item_id: "it-SKU002" }).eq("id", "SKU002");
  });
});

describe("Zoho failures block the run and alert (ZO-08, outage, ZO-10)", () => {
  const blocked = async (id: string) => {
    const { data } = await service().from("run").select("status, error").eq("id", id).single();
    const { data: alert } = await service().from("alert").select("kind, payload").eq("run_id", id).single();
    const { data: rows } = await service().from("recommendation").select("id").eq("run_id", id);
    return { ...data!, alert, recs: rows?.length ?? 0 };
  };

  it("ZO-08 a revoked refresh token", async () => {
    z.refreshTokenValid = false;
    const id = await freshRun();
    expect((await run(id)).status).toBe("blocked");
    const b = await blocked(id);
    expect(b).toMatchObject({ status: "blocked", error: { reason: "zoho_auth" }, alert: { kind: "run_blocked" }, recs: 0 });
  });

  it("F8: an outage is retried by the next cron cycles, and the run finishes when Zoho is back", async () => {
    for (let i = 0; i < 5; i++) z.script.push({ status: 503 });
    const id = await freshRun();
    expect((await run(id)).status).toBe("retrying");
    const { data: mid } = await service().from("run").select("status, error").eq("id", id).single();
    expect(mid).toMatchObject({ error: { reason: "zoho_unavailable" } });
    expect(mid!.status).not.toBe("blocked");
    expect((await service().from("alert").select("id").eq("run_id", id)).data).toEqual([]);
    expect((await run(id)).status).toBe("done"); // Zoho answers again
  });

  it("F8: an outage that outlasts about 30 minutes of retries blocks the run and alerts", async () => {
    const id = await freshRun();
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let i = 0; i < 5; i++) z.script.push({ status: 503 });
      const r = await run(id);
      if (r.status === "blocked") break;
      z.script = [];
    }
    expect(await blocked(id)).toMatchObject({ status: "blocked", error: { reason: "zoho_unavailable" }, alert: { kind: "run_blocked" }, recs: 0 });
  });

  it("ZO-10 the call budget", async () => {
    const id = await freshRun();
    await run(id, 3);
    expect(await blocked(id)).toMatchObject({ status: "blocked", error: { reason: "zoho_budget" }, recs: 0 });
  });
});

describe("ZO-12 the access token is shared through the database", () => {
  it("two runs mint one access token between them", async () => {
    await run(await freshRun());
    await run(await freshRun());
    expect(z.tokensMinted).toBe(1);
    const { data } = await service().from("zoho_token_cache").select("access_token").single();
    expect(data!.access_token).toBe(z.validToken);
  });
});

describe("draft read-back (ZO-05, ZO-06, RN-07)", () => {
  it("logs deleted and edited drafts, and holds back a supplier whose draft is still pending", async () => {
    const svc = service();
    const draft = (supplier: string, zohoId: string, qty: number) => ({
      run_id: firstRun,
      supplier_id: supplier,
      iso_week: "2026-W42",
      mode: "live",
      reference: `FR-2026-W42-${supplier}`,
      zoho_po_id: zohoId,
      status: "created",
      requested_lines: [{ sku_id: "x", item_id: `it-${supplier === "DIST004" ? "SKU011" : "SKU001"}`, qty }],
    });
    await svc.from("draft_po").insert([draft("DIST001", "d-pending", 500), draft("DIST002", "d-gone", 300), draft("DIST004", "d-edited", 600)]);
    z.addPo({ purchaseorder_id: "d-pending", status: "draft", reference_number: "FR-2026-W42-DIST001", line_items: [{ item_id: "it-SKU001", quantity: 500 }] });
    z.addPo({ purchaseorder_id: "d-edited", status: "open", reference_number: "Supplier ref 77", line_items: [{ item_id: "it-SKU011", quantity: 450, quantity_received: 0 }] });

    const id = await freshRun();
    expect((await run(id)).status).toBe("done");

    const { data: rows } = await svc.from("draft_po").select("supplier_id, status, issued_lines, issued_at").order("supplier_id");
    expect(rows!.map((r) => [r.supplier_id, r.status])).toEqual([
      ["DIST001", "created"],
      ["DIST002", "deleted"],
      ["DIST004", "edited"],
    ]);
    expect(rows![2]!.issued_lines).toEqual([{ item_id: "it-SKU011", qty: 450 }]);
    expect(rows![2]!.issued_at).not.toBeNull();
    const { data: log } = await svc.from("change_log").select("entity_id, reason").eq("entity", "draft_po").order("entity_id");
    expect(log!.map((l) => [l.entity_id, l.reason])).toEqual([
      ["FR-2026-W42-DIST002", "Procurement rejection: draft deleted in Zoho"],
      ["FR-2026-W42-DIST004", "Procurement override: draft quantities changed in Zoho"],
    ]);

    // DIST001 (Mango Drink, Peanut Butter, Coconut Water) still has a pending draft → no new draft this week.
    const r = await recs(id);
    expect(r.SKU001!.line_state).toBe("blocked_pending");
    expect(r.SKU013!.line_state).toBe("blocked_pending");
    // The edited draft is now an issued PO, so its 450 counts towards Multigrain Bread's position.
    expect((r.SKU011!.inputs as { position: number }).position).toBe(460 + 450);
    expect(z.writes()).toEqual([]);

    // A second run reads the same pending draft again: nothing new is logged (review M3, finding 9).
    const before = (await svc.from("change_log").select("id").eq("entity", "draft_po")).data!.length;
    await run(await freshRun());
    expect((await svc.from("change_log").select("id").eq("entity", "draft_po")).data!.length).toBe(before);
  });

  it("read-back runs before the PO read: a draft issued in between is held back AND counted (review M3, finding 6)", async () => {
    const svc = service();
    await svc.from("draft_po").update({ status: "issued" }).eq("status", "created"); // clear the earlier test's pending draft
    await svc.from("draft_po").insert({
      run_id: firstRun, supplier_id: "DIST002", iso_week: "2026-W43", mode: "live", reference: "FR-2026-W43-DIST002",
      zoho_po_id: "d-race", status: "created", requested_lines: [{ sku_id: "SKU003", item_id: "it-SKU003", qty: 600 }],
    });
    z.addPo({ purchaseorder_id: "d-race", status: "draft", reference_number: "FR-2026-W43-DIST002", line_items: [{ item_id: "it-SKU003", quantity: 600, quantity_received: 0 }] });
    // Procurement issues the draft right after our read-back request, before the PO list.
    const original = z.fetch;
    let issued = false;
    z.fetch = async (url: string, init: Parameters<Fetch>[1]) => {
      const res = await original(url, init);
      if (!issued && url.includes("/purchaseorders/d-race")) {
        z.pos.get("d-race")!.status = "open";
        issued = true;
      }
      return res;
    };
    const id = await freshRun();
    await run(id);
    const r = await recs(id);
    expect((r.SKU003!.inputs as { position: number }).position).toBe(820 + 600); // counted
    const { data } = await svc.from("draft_po").select("status").eq("zoho_po_id", "d-race").single();
    expect(data!.status).toBe("created"); // seen pending at read-back → the supplier was held back this week
  });
});
