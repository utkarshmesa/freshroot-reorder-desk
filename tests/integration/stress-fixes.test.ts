// Step 4 stress-test fixes through the database (docs/STRESS_TEST_STEP4.md §1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { noonJob } from "@/lib/cron/jobs";
import { settleAfterSave } from "@/lib/run/carryover";
import { processRun } from "@/lib/run/worker";
import { sendToProcurement } from "@/lib/send/send";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { ZohoHttp } from "@/lib/zoho/http";
import { dbTokenSource } from "@/lib/zoho/token";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { as, resetData, service } from "./db";

const CASE = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"];
const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const SKUS = Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`);
const SUPPLIERS = ["DIST001", "DIST002", "DIST003", "DIST004"];
const MON = new Date("2026-10-19T03:30:00Z");
const TUE = new Date("2026-10-20T06:30:00Z");
let z: FakeZoho;

const zohoFactory = (db: Parameters<typeof dbTokenSource>[0], budget: number) =>
  new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: dbTokenSource(db, CFG, z.fetch), budget, sleep: async () => {} });
const noZoho = () => {
  throw new Error("no Zoho in shadow");
};

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = CASE.map((f) => toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))));
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  expect(staged.report.errors).toBe(0);
  await commitUpload(client, staged.uploadId);
});

async function setupZoho() {
  z = new FakeZoho();
  const svc = service();
  for (const s of SKUS) await svc.from("sku").update({ zoho_item_id: `it-${s}`, uom: "Units" }).eq("id", s);
  for (const d of SUPPLIERS) await svc.from("supplier").update({ zoho_vendor_id: `v-${d}` }).eq("id", d);
  for (const s of SKUS) z.items.set(`it-${s}`, { item_id: `it-${s}`, sku: s, unit: "Units", status: "active" });
  for (const d of SUPPLIERS) z.vendors.set(`v-${d}`, { contact_id: `v-${d}`, status: "active" });
  for (const t of ["decision", "draft_po", "alert"]) await svc.from(t).delete().not("id", "is", null);
  await svc.from("zoho_token_cache").delete().eq("id", true);
  await svc.from("app_mode").update({ mode: "shadow" }).not("mode", "is", null);
}
async function newRun(mode: "shadow" | "live" = "shadow"): Promise<string> {
  const { data, error } = await service().rpc("supersede_or_start_run", { p_week: "2026-W43", p_upload: null });
  if (error) throw new Error(error.message);
  const runId = (data as { run_id: string }).run_id;
  await service().from("run").update({ mode }).eq("id", runId);
  expect((await processRun(service(), runId, { caseDataMode: true, llm: null, now: MON })).status).toBe("done");
  return runId;
}
async function lines(runId: string) {
  const { data } = await service().from("recommendation").select("id, sku_id, qty, final_qty, line_state, inputs").eq("run_id", runId).order("sku_id");
  return (data ?? []).map((r) => ({ ...r, supplierId: (r.inputs as { supplierId: string }).supplierId }));
}
async function approveAll(runId: string) {
  const { client } = await as("raghav");
  for (const l of await lines(runId)) if (l.line_state === "queued") await client.rpc("decide_line", { p_rec_id: l.id, p_action: "approve" });
}
async function alerts(kind: string) {
  const { data } = await service().from("alert").select("dedupe_key, payload").eq("kind", kind);
  return (data ?? []) as Array<{ dedupe_key: string; payload: { message?: string } }>;
}

describe("F2: a SKU master re-upload keeps values typed in Settings", () => {
  it("lead time, MOQ, shelf life, cost and Zoho item survive; the file's own values still update", async () => {
    const svc = service();
    await svc.from("sku").update({ lead_time_wks: 3, moq: 600, shelf_life_wks: 8, unit_cost_inr: 42, zoho_item_id: "it-SKU001", uom: "Units" }).eq("id", "SKU001");

    const master = readFileSync("data/case/sku_master.csv", "utf8").replace("SKU001,Freshroots Mango Drink 200ml,Beverage,Low,500", "SKU001,Freshroots Mango Drink 200ml,Beverage,Low,550");
    const { client, id } = await as("priya");
    const staged = await stageUpload({ user: client, service: svc, userId: id, files: [toInputFile("sku_master.csv", new TextEncoder().encode(master))], caseDataMode: true });
    expect(staged.report.errors).toBe(0);
    await commitUpload(client, staged.uploadId);

    const { data } = await svc.from("sku").select("std_qty, lead_time_wks, moq, shelf_life_wks, unit_cost_inr, zoho_item_id, uom").eq("id", "SKU001").single();
    expect(data).toEqual({ std_qty: 550, lead_time_wks: 3, moq: 600, shelf_life_wks: 8, unit_cost_inr: 42, zoho_item_id: "it-SKU001", uom: "Units" });
  });
});

describe("F3: only a position change holds a line; held lines alert the planner", () => {
  async function liveRunWithMondayPo(ordered: number) {
    await setupZoho();
    const runId = await newRun("live");
    await service().from("app_mode").update({ mode: "live" }).not("mode", "is", null);
    const target = (await lines(runId)).find((l) => l.sku_id === "SKU001")!;
    const { data: run } = await service().from("run").select("zoho_read").eq("id", runId).single();
    const doc = { ...(run!.zoho_read as object), po_lines: [{ poId: "po-1", poNumber: "PO-1", status: "open", skuId: "SKU001", ordered, received: 0, expectedDate: null }] };
    await service().from("run").update({ zoho_read: doc }).eq("id", runId);
    await approveAll(runId);
    return { runId, target };
  }
  const send = (runId: string) => sendToProcurement(service(), runId, { now: TUE, zoho: zohoFactory, envMode: "live", sleep: async () => {} });
  const mondayPo = (status: string, quantity: number, received: number) =>
    z.addPo({ purchaseorder_id: "po-1", status, vendor_id: "v-DIST001", reference_number: "manual", last_modified_time: "2026-10-19T15:00:00+0530", line_items: [{ item_id: "it-SKU001", quantity, quantity_received: received }] });

  it("a receipt on Monday's open PO (ordered unchanged) doesn't hold the line", async () => {
    const { runId, target } = await liveRunWithMondayPo(50);
    mondayPo("partially_received", 50, 50);
    expect((await send(runId)).held).toEqual([]);
    expect((await lines(runId)).find((l) => l.id === target.id)!.line_state).toBe("sent");
  });

  it("a changed ordered quantity holds the line and alerts the planner", async () => {
    const { runId, target } = await liveRunWithMondayPo(50);
    mondayPo("issued", 80, 0);
    expect((await send(runId)).held).toEqual([{ supplierId: "DIST001", skuIds: ["SKU001"] }]);
    expect((await lines(runId)).find((l) => l.id === target.id)!.line_state).toBe("held_changed");
    expect((await alerts("lines_held")).map((a) => a.dedupe_key)).toEqual(["lines_held:2026-W43:DIST001"]);
  });

  it("a PO cancelled since Monday holds the line", async () => {
    const { runId } = await liveRunWithMondayPo(50);
    mondayPo("cancelled", 50, 0);
    expect((await send(runId)).held.flatMap((h) => h.skuIds)).toContain("SKU001");
  });
});

describe("F4: a same-week correction", () => {
  it("carries Raghav's decision over when the card is unchanged", async () => {
    await setupZoho();
    const first = await newRun();
    const card = (await lines(first)).find((l) => l.sku_id === "SKU001")!;
    const { client } = await as("raghav");
    expect((await client.rpc("decide_line", { p_rec_id: card.id, p_action: "change", p_final_qty: 600, p_note: "promo next week" })).error).toBeNull();
    const second = await newRun();
    const again = (await lines(second)).find((l) => l.sku_id === "SKU001")!;
    expect(again).toMatchObject({ line_state: "changed", final_qty: 600 });
    const { data: d } = await service().from("decision").select("status, final_qty, note").eq("recommendation_id", again.id);
    expect(d).toEqual([{ status: "changed", final_qty: 600, note: "Carried over from the replaced run: promo next week" }]);
  });

  it("keeps what was already sent, holds the rest for next week, and tells planner and procurement what changed", async () => {
    await setupZoho();
    const first = await newRun();
    await approveAll(first);
    await sendToProcurement(service(), first, { now: TUE, envMode: undefined, zoho: noZoho });
    const sent = (await lines(first)).filter((l) => l.line_state === "sent");
    // The first upload overstated nothing here, so pretend the sent quantity differs from the corrected data.
    const mango = sent.find((l) => l.sku_id === "SKU001")!;
    await service().from("recommendation").update({ final_qty: 1 }).eq("id", mango.id);
    const second = await newRun();
    const now = await lines(second);
    const newMango = now.find((l) => l.sku_id === "SKU001")!;
    expect(newMango).toMatchObject({ line_state: "sent", final_qty: 1 });
    const draftedSuppliers = new Set(sent.map((s) => s.supplierId));
    for (const l of now.filter((x) => draftedSuppliers.has(x.supplierId) && x.line_state !== null)) expect(["sent", "rolled"]).toContain(l.line_state);
    const a = await alerts("correction_after_send");
    expect(a).toHaveLength(1);
    expect(a[0]!.payload.message).toContain(`DIST001 SKU001: sent 1, corrected data says ${newMango.qty}`);
    expect((await sendToProcurement(service(), second, { now: TUE, envMode: undefined, zoho: noZoho })).sent).toEqual([]);
  });
});

describe("F7 and F11", () => {
  it("F7: a supplier held by an earlier unissued draft is alerted every week", async () => {
    await setupZoho();
    const runId = await newRun();
    const l = (await lines(runId)).find((x) => x.sku_id === "SKU001")!;
    await service().from("recommendation").update({ line_state: "blocked_pending" }).eq("id", l.id);
    await settleAfterSave(service(), runId, "2026-W43");
    expect((await alerts("supplier_blocked")).map((a) => a.dedupe_key)).toEqual(["supplier_blocked:2026-W43:DIST001"]);
  });

  it("F11: when the noon send fails, the planner is alerted too", async () => {
    await setupZoho();
    const runId = await newRun();
    await service().rpc("claim_send", { p_run_id: runId }); // another send holds the lease
    const res = await noonJob(service(), TUE, { envMode: undefined, lockTries: 1, sleep: async () => {} });
    expect(res.errors.join(" ")).toMatch(/already in progress/);
    expect((await alerts("send_failed"))[0]?.payload.message).toMatch(/Approved orders have not reached procurement/);
    await service().rpc("release_send", { p_run_id: runId });
  });
});
