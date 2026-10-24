// C-039 Zoho failsafe (file mode): the open-PO and receipts files that stand in for the Zoho read.
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/upload/parse";
import { readPositionFiles } from "./parse";

const SKUS = new Set(["SKU001", "SKU002", "SKU013"]);
const open = (body: string) => parseCsv("open_pos.csv", `po_number,supplier_id,sku_id,po_date,ordered_units,received_units,status,expected_date,reference\n${body}`);
const rec = (body: string) => parseCsv("receipts.csv", `po_number,sku_id,receipt_date,received_units\n${body}`);

describe("readPositionFiles", () => {
  it("open lines become PO lines with their date and reference; closed and draft ones don't count", () => {
    const r = readPositionFiles({ openPos: open("PO-1,DIST001,SKU013,2026-10-12,300,0,open,2026-10-26,phone\nPO-2,DIST001,SKU001,2026-10-05,500,500,closed,,\nPO-3,DIST001,SKU002,2026-10-16,100,0,draft,,"), receipts: null, runWeek: "2026-W43", skus: SKUS });
    expect(r.errors).toEqual([]);
    expect(r.poLines).toEqual([
      { poId: "PO-1", poNumber: "PO-1", status: "open", skuId: "SKU013", ordered: 300, received: 0, expectedDate: "2026-10-26", placedDate: "2026-10-12", reference: "phone" },
      { poId: "PO-2", poNumber: "PO-2", status: "closed", skuId: "SKU001", ordered: 500, received: 500, expectedDate: null, placedDate: "2026-10-05", reference: null },
    ]);
    expect(r.summary).toEqual({ openLines: 1, openUnits: 300, pos: 2 });
  });

  it("receipts dated before Monday of the run week are ignored (SAP stock already has them), with a note", () => {
    const r = readPositionFiles({ openPos: open("PO-1,DIST001,SKU013,2026-10-12,300,100,partially_received,,"), receipts: rec("PO-1,SKU013,2026-10-19,100\nPO-1,SKU013,2026-10-17,40"), runWeek: "2026-W43", skus: SKUS });
    expect(r.receipts).toEqual([{ poId: "PO-1", skuId: "SKU013", date: "2026-10-19", qty: 100 }]);
    // Review M5b #4: the list is "as of Monday 00:00", so the Monday receipt moves from open to received.
    expect(r.poLines[0]).toMatchObject({ ordered: 300, received: 200 });
    expect(r.summary.openUnits).toBe(100);
    expect(r.warnings.join(" ")).toMatch(/1 receipt line\(s\) dated before 2026-10-19/);
  });

  it("refuses unknown SKUs, bad numbers, unknown statuses and missing columns", () => {
    expect(readPositionFiles({ openPos: open("PO-1,DIST001,SKU999,2026-10-12,300,0,open,,"), receipts: null, runWeek: "2026-W43", skus: SKUS }).errors[0]).toMatch(/SKU999/);
    expect(readPositionFiles({ openPos: open("PO-1,DIST001,SKU001,2026-10-12,abc,0,open,,"), receipts: null, runWeek: "2026-W43", skus: SKUS }).errors[0]).toMatch(/ordered_units/);
    expect(readPositionFiles({ openPos: open("PO-1,DIST001,SKU001,2026-10-12,10,0,awaiting_magic,,"), receipts: null, runWeek: "2026-W43", skus: SKUS }).errors[0]).toMatch(/awaiting_magic/);
    expect(readPositionFiles({ openPos: parseCsv("x.csv", "po,sku\n1,2"), receipts: null, runWeek: "2026-W43", skus: SKUS }).errors[0]).toMatch(/columns/);
  });

  it("received more than ordered is refused (the position would go negative)", () => {
    expect(readPositionFiles({ openPos: open("PO-1,DIST001,SKU001,2026-10-12,10,20,open,,"), receipts: null, runWeek: "2026-W43", skus: SKUS }).errors[0]).toMatch(/received more than ordered/);
  });
});

describe("the failsafe templates in data/templates", () => {
  it("are the exact layouts the failsafe reads (empty is valid: no open POs)", async () => {
    const { readFileSync } = await import("node:fs");
    const r = readPositionFiles({
      openPos: parseCsv("open_pos_template.csv", readFileSync("data/templates/open_pos_template.csv", "utf8")),
      receipts: parseCsv("receipts_since_monday_template.csv", readFileSync("data/templates/receipts_since_monday_template.csv", "utf8")),
      runWeek: "2026-W43",
      skus: SKUS,
    });
    expect(r.errors).toEqual([]);
    expect(r.summary).toEqual({ openLines: 0, openUnits: 0, pos: 0 });
  });
});
