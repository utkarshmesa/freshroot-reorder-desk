// Step 4 stress-test fixes through the database (docs/STRESS_TEST_STEP4.md §1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { commitUpload, stageUpload, toInputFile } from "@/lib/upload/server";
import { as, resetData, service } from "./db";

const CASE = ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"];

beforeAll(async () => {
  await resetData();
  const { client, id } = await as("priya");
  const files = CASE.map((f) => toInputFile(`${f}.csv`, new Uint8Array(readFileSync(path.join(process.cwd(), `data/case/${f}.csv`)))));
  const staged = await stageUpload({ user: client, service: service(), userId: id, files, caseDataMode: true });
  expect(staged.report.errors).toBe(0);
  await commitUpload(client, staged.uploadId);
});

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
