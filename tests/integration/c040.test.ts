// C-040: the case file layouts in production (case-data mode off): they commit, and the run reads Zoho, so an
// open PO counts in the position (case-data mode would have skipped Zoho).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { processRun } from "@/lib/run/worker";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { ZohoHttp } from "@/lib/zoho/http";
import { dbTokenSource } from "@/lib/zoho/token";
import { ACCOUNTS, API, FakeZoho, ORG } from "@/tests/mocks/zoho";
import { as, resetData, service } from "./db";

const CFG = { accountsDomain: ACCOUNTS, clientId: "cid", clientSecret: "secret", refreshToken: "1000.refresh" };
const SKUS = Array.from({ length: 15 }, (_, i) => `SKU${String(i + 1).padStart(3, "0")}`);
const SUPPLIERS = ["DIST001", "DIST002", "DIST003", "DIST004"];
let runId = "";

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) =>
    toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))),
  );
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: false });
  expect(staged.report.errors).toBe(0);
  expect(staged.report.issues.map((i) => i.code)).toContain("sku_level_sales");
  runId = (await commitUpload(client, staged.uploadId)).run_id!;
});

describe("C-040: case layouts with case-data mode off", () => {
  it("the run reads Zoho and counts an open PO in the position", async () => {
    const svc = service();
    for (const s of SKUS) await svc.from("sku").update({ zoho_item_id: `it-${s}`, uom: "Units" }).eq("id", s);
    for (const d of SUPPLIERS) await svc.from("supplier").update({ zoho_vendor_id: `v-${d}` }).eq("id", d);
    const z = new FakeZoho();
    for (const s of SKUS) z.items.set(`it-${s}`, { item_id: `it-${s}`, sku: s, unit: "Units", status: "active" });
    for (const d of SUPPLIERS) z.vendors.set(`v-${d}`, { contact_id: `v-${d}`, status: "active" });
    z.addPo({ purchaseorder_id: "open-1", status: "open", vendor_id: "v-DIST001", line_items: [{ item_id: "it-SKU013", quantity: 300, quantity_received: 0 }] });
    const zoho = (db: Parameters<typeof dbTokenSource>[0], budget: number) =>
      new ZohoHttp({ apiBase: API, organizationId: ORG, fetch: z.fetch, token: dbTokenSource(db, CFG, z.fetch), budget, sleep: async () => {} });

    expect((await processRun(svc, runId, { caseDataMode: false, zoho, llm: null, now: new Date("2026-10-19T03:30:00Z") })).status).toBe("done");
    const { data } = await svc.from("recommendation").select("inputs").eq("run_id", runId).eq("sku_id", "SKU013").single();
    expect((data!.inputs as { openPoQty: number }).openPoQty).toBe(300);
    const { data: run } = await svc.from("run").select("zoho_read").eq("id", runId).single();
    expect((run!.zoho_read as { skipped?: string }).skipped).toBeUndefined();
  });
});
