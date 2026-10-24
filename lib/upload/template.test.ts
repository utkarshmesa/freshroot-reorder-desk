// The SKU-details template procurement fills in (data/templates/sku_details_for_procurement.csv) must stay a
// valid sku_master upload: blank optional columns allowed (they keep what Settings has, F2).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./parse";
import { prepareUpload } from "./validate";

const ctx = {
  caseDataMode: false,
  knownSkuIds: new Set<string>(),
  knownDistributorIds: new Set<string>(),
  knownSupplierIds: new Set(["DIST001", "DIST002", "DIST003", "DIST004"]),
  committedHashes: new Set<string>(),
  latestCommittedWeek: null,
  lastAsOf: null,
  previousWeekNetUnits: null,
  rules: { restatementWindowWks: 12, volumeChangeConfirmPct: 40, festivalUpliftPct: 25, festivalPreloadWks: 3 },
};
const load = (text: string) => prepareUpload([{ name: "sku_details.csv", hash: "h", table: parseCsv("sku_details.csv", text) }], ctx);

describe("procurement SKU-details template", () => {
  const text = readFileSync("data/templates/sku_details_for_procurement.csv", "utf8");

  it("validates as a SKU master with no errors, all 15 SKUs, blanks left as blanks", () => {
    const p = load(text);
    expect(p.report.issues.filter((i) => i.level === "error")).toEqual([]);
    const skus = p.staging.filter((s) => s.kind === "sku");
    expect(skus).toHaveLength(15);
    expect(skus[0]!.row).toMatchObject({ id: "SKU001", std_qty: 500, perishable: false, supplier_id: "DIST001", lead_time_wks: null, moq: null, shelf_life_wks: null, zoho_item_id: null });
  });

  it("filled in, the values come through", () => {
    const filled = text.replace("SKU004,Freshroots Almond Milk 500ml,Dairy Alt,active,150,true,Units,DIST002,,,,,,", "SKU004,Freshroots Almond Milk 500ml,Dairy Alt,active,150,true,Units,DIST002,1,120,12,3,48.5,it-almond");
    const row = load(filled).staging.find((s) => s.kind === "sku" && s.row.id === "SKU004")!.row;
    expect(row).toMatchObject({ lead_time_wks: 1, moq: 120, pack_size: 12, shelf_life_wks: 3, unit_cost_inr: 48.5, zoho_item_id: "it-almond", perishable: true });
  });
});
